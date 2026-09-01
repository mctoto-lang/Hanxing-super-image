import { and, desc, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import { systemSettings, type SystemSettingValue } from "@/db/schema"

/**
 * 存储配置与图片分类（单桶 + 文件夹前缀，手册 §10.5）
 *
 * 单个 COS 桶，用前缀（文件夹）区分文件类型并驱动生命周期规则：
 * - ref/        参考图（会过期）       用户上传
 * - config/     配置图（不过期）         logo/图标/模板图
 * - gen/        生成图（会过期）         AI 结果
 * - gen/thumb/  缩略图（会过期）
 *
 * 过期清理由腾讯云 COS 生命周期规则按前缀自动处理；应用侧仅清理 DB 死链接。
 */

export type StorageProvider = "local" | "cos"

/**
 * 图片分类：决定用什么前缀（文件夹）、是否过期。所有 category 落到同一个 COS 桶。
 * - reference：用户上传的参考图（ref/，会过期）
 * - config：管理员上传的 logo/图标/模板图等（config/，不过期）
 * - generate：AI 生成的结果图（gen/，会过期）
 * - thumb：生成图缩略图（gen/thumb/，会过期）
 */
export type ImageCategory = "reference" | "config" | "generate" | "thumb"

export interface StorageConfig {
  provider: StorageProvider
  /** COS 凭证（子账号，授予该桶读写权限） */
  cosSecretId: string
  cosSecretKey: string
  cosRegion: string
  /** 单个 COS 桶 + 访问域名 */
  cosBucket: string
  cosBaseUrl: string
  /** key 前缀（对应桶内文件夹 / COS 生命周期规则） */
  refPrefix: string
  configPrefix: string
  generatePrefix: string
  /**
   * 上传强制走 COS 内网域名（<bucket>.cos.<region>.tencentcos.cn）。
   * 仅当应用服务器部署在腾讯云且与桶同地域时开启：内网上传免流量费、
   * 不占公网出带宽。展示/预签名 URL 仍用公网域名，不受此开关影响。
   */
  cosForceInternalEndpoint: boolean
  /** 本地降级目录前缀 */
  localImagePrefix: string
  /** 额外可信下载域名（SSRF 白名单补充）：精确 host，或以 "." 开头的后缀（如 ".dakka.com.cn"） */
  allowedDownloadHosts: string[]
}

const DEFAULT_STORAGE: StorageConfig = {
  provider: "local",
  cosSecretId: "",
  cosSecretKey: "",
  cosRegion: "",
  cosBucket: "",
  cosBaseUrl: "",
  refPrefix: "ref/",
  configPrefix: "config/",
  generatePrefix: "gen/",
  cosForceInternalEndpoint: false,
  localImagePrefix: "image/",
  allowedDownloadHosts: [],
}

/** 历史配置字段（向后兼容合并到 cosBucket/cosBaseUrl） */
interface LegacyStorageFields {
  /** 最初的单桶字段 */
  cosBucket?: string
  cosBaseUrl?: string
  cosImagePrefix?: string
  /** 曾短暂使用的双桶字段 */
  uploadBucket?: string
  uploadBaseUrl?: string
  generateBucket?: string
  generateBaseUrl?: string
}

/**
 * 读取平台级存储配置（system_setting key=storage，enterpriseId=NULL）。
 *
 * 不含鉴权——鉴权由调用方在入口完成（超管 action / 已登录 API 路由）。
 * 供存储层 getStorage()、presign 端点、超管 server action 共用，避免重复查询逻辑。
 *
 * 向后兼容：合并最初的单桶字段（cosBucket/cosBaseUrl）与曾用的双桶字段
 * （uploadBucket/generateBucket 等）到 cosBucket/cosBaseUrl，保证任意历史配置都能读出。
 */
export async function loadStorageConfig(): Promise<StorageConfig> {
  // 取 updatedAt 最新一行：unique(key, enterpriseId) 对 NULL 不去重，历史上
  // 保存会累积重复的平台级行，按最新优先保证读取确定性
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(
      and(eq(systemSettings.key, "storage"), isNull(systemSettings.enterpriseId)),
    )
    .orderBy(desc(systemSettings.updatedAt))
    .limit(1)

  const v = (row?.value ?? {}) as Partial<StorageConfig> & LegacyStorageFields &
    SystemSettingValue

  return {
    ...DEFAULT_STORAGE,
    ...v,
    // 向后兼容：历史单桶 / 双桶字段统一回退到 cosBucket / cosBaseUrl
    cosBucket: v.cosBucket || v.uploadBucket || v.generateBucket || "",
    cosBaseUrl: v.cosBaseUrl || v.uploadBaseUrl || v.generateBaseUrl || "",
    // 内网上传开关：严格布尔（防 jsonb 脏数据）
    cosForceInternalEndpoint: v.cosForceInternalEndpoint === true,
    // 可信下载域名：过滤非字符串项，防御 jsonb 脏数据
    allowedDownloadHosts: Array.isArray(v.allowedDownloadHosts)
      ? v.allowedDownloadHosts.filter(
          (h): h is string => typeof h === "string",
        )
      : [],
  }
}

/** category 是否会过期（参考图/生成图/缩略图随 COS 生命周期删除；配置图永不） */
export function isExpirable(category: ImageCategory): boolean {
  return category !== "config"
}

/** 解析 category → COS 桶 + BaseUrl + key 前缀（单桶，仅前缀随 category 变） */
export function resolveCosTarget(
  cfg: StorageConfig,
  category: ImageCategory,
): { bucket: string; baseUrl: string; prefix: string } {
  const bucket = cfg.cosBucket
  const baseUrl = cfg.cosBaseUrl
  switch (category) {
    case "reference":
      return { bucket, baseUrl, prefix: cfg.refPrefix }
    case "config":
      return { bucket, baseUrl, prefix: cfg.configPrefix }
    case "generate":
      return { bucket, baseUrl, prefix: cfg.generatePrefix }
    case "thumb":
      return { bucket, baseUrl, prefix: `${cfg.generatePrefix}thumb/` }
  }
}

/** 当前年月分层路径：yyyy/mm */
export function datePath(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  return `${yyyy}/${mm}`
}

/** 从 URL 推断图片扩展名 */
export function extFromUrl(url: string): string {
  const m = url.match(/\.(jpe?g|png|webp|gif|bmp)(?:\?|#|$)/i)
  return m ? m[1]!.toLowerCase() : "png"
}

/* ─── 下载白名单 host 工具（local / cos 适配器共用） ─── */

/** 常见多段后缀 TLD（用于可注册域近似计算，如 dakka.com.cn） */
const MULTI_PART_TLDS = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "ac.cn",
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.br",
  "com.mx",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.my",
])

/** 可注册域近似值（eTLD+1）：无公共后缀库，按常见多段 TLD 启发式取最后 2~3 段 */
export function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".").filter(Boolean)
  if (parts.length <= 2) return parts.join(".")
  const lastTwo = parts.slice(-2).join(".")
  if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".")
  return lastTwo
}

/** host 是否命中可信条目：精确 host，或以 "." 开头的后缀（如 .dakka.com.cn） */
export function matchesAllowedHost(host: string, entries: string[]): boolean {
  for (const entry of entries) {
    if (!entry) continue
    if (entry.startsWith(".")) {
      if (host.endsWith(entry)) return true
    } else if (host === entry) {
      return true
    }
  }
  return false
}

/**
 * 默认可信下载域名后缀（local / cos 适配器共用）：
 * 常见云存储 + AI 生图上游图片 CDN。
 * 即梦/Dreamina 系图片走 byteimg.com（pXX-dreamina-sign.byteimg.com）与 douyinpic.com 签名 CDN。
 */
export const DEFAULT_DOWNLOAD_HOST_SUFFIXES = [
  ".aliyuncs.com",
  ".myqcloud.com",
  ".amazonaws.com",
  ".blob.core.windows.net",
  ".byteimg.com",
  ".douyinpic.com",
]

/** host 是否与提示域名同站（同一可注册域，如 api.foo.com 与 img.foo.com） */
export function sameSiteAsHost(host: string, hintHost: string): boolean {
  if (!host || !hintHost) return false
  if (host === hintHost) return true
  return registrableDomain(host) === registrableDomain(hintHost)
}

/** 扩展名 → Content-Type */
export function contentTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    case "svg":
      return "image/svg+xml"
    default:
      return "application/octet-stream"
  }
}

/**
 * 图片保留天数配置（system_setting key=image_retention）。
 *
 * 与腾讯云 COS 生命周期规则保持一致：COS 负责删对象，应用 cleanup cron
 * 负责按此天数清理 DB 中的死链接。0 表示该类不过期（不清理）。
 */
export interface ImageRetentionConfig {
  /** 参考图保留天数（generationTasks.referenceImages） */
  referenceRetainDays: number
  /** 生成图保留天数（resultImages + conversations.lastImageThumb） */
  generateRetainDays: number
}

const DEFAULT_RETENTION: ImageRetentionConfig = {
  referenceRetainDays: 30,
  generateRetainDays: 30,
}

function numOrDefault(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export async function loadImageRetentionConfig(): Promise<ImageRetentionConfig> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(
      and(
        eq(systemSettings.key, "image_retention"),
        isNull(systemSettings.enterpriseId),
      ),
    )
    .limit(1)
  const v = (row?.value ?? {}) as Partial<ImageRetentionConfig> & SystemSettingValue
  return {
    referenceRetainDays: numOrDefault(
      v.referenceRetainDays,
      DEFAULT_RETENTION.referenceRetainDays,
    ),
    generateRetainDays: numOrDefault(
      v.generateRetainDays,
      DEFAULT_RETENTION.generateRetainDays,
    ),
  }
}

/** 从可访问 URL 反解对象 key（URL 的 path 部分，去前导斜杠并 decode） */
export function keyFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""))
  } catch {
    return ""
  }
}
