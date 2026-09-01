import COS from "cos-nodejs-sdk-v5"
import { randomUUID } from "node:crypto"
import type { StorageAdapter } from "./index"
import { transferSemaphore } from "./semaphore"
import {
  type StorageConfig,
  type ImageCategory,
  resolveCosTarget,
  datePath,
  extFromUrl,
  contentTypeFromExt,
  keyFromUrl,
  matchesAllowedHost,
  sameSiteAsHost,
  DEFAULT_DOWNLOAD_HOST_SUFFIXES,
} from "./config"

/**
 * 腾讯云 COS 存储适配器（双桶 + category 路由）。
 *
 *凭证与桶名均来自 system_setting（loadStorageConfig），不读 env。
 * 参考图（reference）走客户端预签名直传（presignPut）；生成图（generate）走服务器
 * saveFromUrl/saveFromBuffer。过期清理由 COS 生命周期规则按前缀处理，本适配器不做删除。
 */

/** 单次回拉下载上限 50MB / 超时 30s（与 local 一致，防异常上游耗尽内存） */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
/** 预签名 PUT URL 有效期 10 分钟 */
const PRESIGN_EXPIRES = 600

export interface CosAdapter extends StorageAdapter {
  /** 生成预签名 PUT URL，供浏览器直传到指定 category 的桶/前缀 */
  presignPut(
    enterpriseId: string,
    ext: string,
    category: ImageCategory,
    contentType: string,
    /** 申报字节数：参与签名后 COS 强制 PUT 体积精确等于该值（可选，向后兼容） */
    size?: number,
  ): Promise<{ presignedUrl: string; finalUrl: string; key: string }>
}

/** 拼接对象 key：${前缀}${enterpriseId}/${yyyy}/${mm}/${uuid}.${ext} */
function buildKey(prefix: string, enterpriseId: string, filename: string): string {
  return `${prefix}${enterpriseId}/${datePath()}/${filename}`
}

/**
 * COS 对象规范访问 URL（按桶名 + Region 推导，不依赖手填 cosBaseUrl）。
 * 与 SDK 生成的 presignedUrl 同源，保证「上传位置 == 显示位置」永不分裂。
 */
function canonicalUrl(bucket: string, region: string, key: string): string {
  return `https://${bucket}.cos.${region}.myqcloud.com/${key}`
}

/**
 * 服务端上传目标域名：开启内网上传时改用 tencentcos.cn 内网域名
 * （仅腾讯云同地域服务器可达，公网不可达），上传免流量费、不占公网出带宽。
 * 展示与预签名仍走 canonicalUrl 公网域名，读写路径分离。
 */
function uploadDomain(cfg: StorageConfig, bucket: string): string | undefined {
  return cfg.cosForceInternalEndpoint
    ? `${bucket}.cos.${cfg.cosRegion}.tencentcos.cn`
    : undefined
}

/**
 * 校验回拉目标 host 是否可信（防 SSRF）。
 * 仅允许 https + 配置的 COS 桶域名 + 常见云存储/AI 上游后缀
 * + 平台配置的额外可信域名 + 调用方提示域名（模型 API 端点）的同站域名。
 */
function isAllowedDownloadHost(
  url: URL,
  cfg: StorageConfig,
  hostHints: string[] = [],
): boolean {
  if (url.protocol !== "https:") return false
  const host = url.hostname
  if (cfg.cosBaseUrl) {
    try {
      if (host === new URL(cfg.cosBaseUrl).hostname) return true
    } catch {
      // ignore
    }
  }
  if (DEFAULT_DOWNLOAD_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true
  // 额外放行配置的可信上游域名（精确 host，或以 "." 开头的后缀，如 ".dakka.com.cn"）
  if (matchesAllowedHost(host, cfg.allowedDownloadHosts ?? [])) return true
  // 调用方提示的可信域名（如模型 API 端点）：同站（同一可注册域）即放行
  if (hostHints.some((hint) => sameSiteAsHost(host, hint))) return true
  return false
}

/**
 * URL 是否已是本桶对象（图片中转服务器预转存场景）：
 * canonical 桶域名（或配置的 cosBaseUrl 域名）+ key 含本企业 ID 段。
 * 命中则直接复用原 URL，跳过「下载→重传」双跳。
 * 导出供单测直接验证判定边界。
 */
export function isOwnCosObjectUrl(
  url: URL,
  cfg: StorageConfig,
  enterpriseId: string,
): boolean {
  if (url.protocol !== "https:") return false
  const hosts = new Set<string>()
  if (cfg.cosBucket && cfg.cosRegion) {
    hosts.add(`${cfg.cosBucket}.cos.${cfg.cosRegion}.myqcloud.com`)
  }
  if (cfg.cosBaseUrl) {
    try {
      hosts.add(new URL(cfg.cosBaseUrl).hostname)
    } catch {
      // ignore
    }
  }
  if (!hosts.has(url.hostname)) return false
  // key 规范 <prefix><enterpriseId>/yyyy/mm/<uuid>.<ext>：企业段保证租户归属
  return decodeURIComponent(url.pathname).split("/").includes(enterpriseId)
}

/**
 * 信号量内完成下载（fetch + 流式读取 + 体积上限），拼成 Buffer 返回。
 * 排队等待不计入下载超时；上传（saveFromBuffer）在信号量外执行。
 */
async function downloadBuffered(url: URL): Promise<Buffer> {
  await transferSemaphore.acquire()
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`)

    const reader = resp.body?.getReader()
    if (!reader) {
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error("下载失败: 超过最大体积限制")
      }
      return buf
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value!.byteLength
      if (total > MAX_DOWNLOAD_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
        throw new Error("下载失败: 超过最大体积限制")
      }
      chunks.push(Buffer.from(value!))
    }
    return Buffer.concat(chunks)
  } finally {
    transferSemaphore.release()
  }
}

export function createCosAdapter(cfg: StorageConfig): CosAdapter {
  const cos = new COS({
    SecretId: cfg.cosSecretId,
    SecretKey: cfg.cosSecretKey,
  })

  return {
    async saveFromBuffer(buffer, enterpriseId, ext, category) {
      const target = resolveCosTarget(cfg, category)
      if (!target.bucket) throw new Error("COS 上传失败：未配置对应桶名")
      const filename = `${randomUUID()}.${ext}`
      const key = buildKey(target.prefix, enterpriseId, filename)
      const domain = uploadDomain(cfg, target.bucket)
      await cos.putObject({
        Bucket: target.bucket,
        Region: cfg.cosRegion,
        Key: key,
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: contentTypeFromExt(ext),
        // Domain 缺省时 SDK 走默认公网域名；内网开关开启时强制 tencentcos.cn
        ...(domain ? { Domain: domain } : {}),
      })
      return canonicalUrl(target.bucket, cfg.cosRegion, key)
    },

    async saveFromUrl(
      sourceUrl,
      enterpriseId,
      category,
      trustedHostHints = [],
    ) {
      let targetUrl: URL
      try {
        targetUrl = new URL(sourceUrl)
      } catch {
        throw new Error("下载失败: 无效 URL")
      }
      // 中转服务器预转存：上游返回的已是本桶对象（key 含本企业段），直接
      // 复用，省去每张图 2×（下载+上传）应用带宽与转存延迟
      if (isOwnCosObjectUrl(targetUrl, cfg, enterpriseId)) {
        return sourceUrl
      }
      if (!isAllowedDownloadHost(targetUrl, cfg, trustedHostHints)) {
        console.warn(
          `[storage] 拒绝下载：域名 ${targetUrl.hostname} 不在可信白名单内（url=${sourceUrl.slice(0, 160)}）`,
        )
        throw new Error(
          `下载失败: 目标域名 ${targetUrl.hostname} 不在可信白名单内`,
        )
      }

      const ext = extFromUrl(sourceUrl)
      const buffer = await downloadBuffered(targetUrl)
      return this.saveFromBuffer(buffer, enterpriseId, ext, category)
    },

    async deleteObjects(urls) {
      let n = 0
      for (const url of urls) {
        const key = keyFromUrl(url)
        if (!key || !cfg.cosBucket) continue
        try {
          await cos.deleteObject({
            Bucket: cfg.cosBucket,
            Region: cfg.cosRegion,
            Key: key,
          })
          n++
        } catch {
          // 已不存在或失败，忽略（幂等清理）
        }
      }
      return n
    },

    async presignPut(enterpriseId, ext, category, contentType, size) {
      const target = resolveCosTarget(cfg, category)
      if (!target.bucket) throw new Error("COS 预签名失败：未配置对应桶名")
      const filename = `${randomUUID()}.${ext}`
      const key = buildKey(target.prefix, enterpriseId, filename)
      // getObjectUrl 在 Sign:true 时返回带签名的 URL（同步返回字符串）。
      // 签名绑定了 Content-Type 与申报的 Content-Length：浏览器对 File body
      // 自动携带匹配的 Content-Length；绕过本端点直传的客户端必须精确匹配
      // 申报体积，否则签名校验失败——预签名端点的体积上限由建议变为强制。
      const presignedUrl = cos.getObjectUrl({
        Method: "PUT",
        Bucket: target.bucket,
        Region: cfg.cosRegion,
        Key: key,
        Sign: true,
        Expires: PRESIGN_EXPIRES,
        Headers: {
          "Content-Type": contentType,
          ...(size && size > 0 ? { "Content-Length": String(size) } : {}),
        },
      })
      return {
        presignedUrl,
        finalUrl: canonicalUrl(target.bucket, cfg.cosRegion, key),
        key,
      }
    },

    async presignGet(url, expiresSec = 600): Promise<string | null> {
      try {
        const parsed = new URL(url)
        // 仅允许配置过的桶（hostname 形如 {bucket}.cos.{region}.myqcloud.com）
        const upload = resolveCosTarget(cfg, "reference")
        const generate = resolveCosTarget(cfg, "generate")
        const buckets = new Set(
          [upload.bucket, generate.bucket].filter(Boolean) as string[],
        )
        const m = parsed.hostname.match(/^([^.]+)\.cos\.[^.]+\.myqcloud\.com$/)
        if (!m || !buckets.has(m[1]!)) return null
        const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))
        if (!key) return null
        return cos.getObjectUrl({
          Method: "GET",
          Bucket: m[1]!,
          Region: cfg.cosRegion,
          Key: key,
          Sign: true,
          Expires: expiresSec,
        })
      } catch {
        return null
      }
    },
  }
}
