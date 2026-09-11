import { NextResponse } from "next/server"
import { env } from "@/lib/env"
import { auth } from "@/lib/auth/config"
import {
  loadStorageConfig,
  toInternalCosFetchUrl,
  type StorageConfig,
} from "@/lib/storage/config"
import { signUploadToken } from "@/lib/storage/upload-token"

/**
 * 图片代理（手册 §10.7 防 SSRF）
 *
 * 校验目标 host 白名单（本应用域名 + COS 桶域名），防止 SSRF。
 * COS 桶域名来自 system_setting（loadStorageConfig）——存储配置的唯一
 * 真实来源，不读 .env（env 的 COS_* 可能未填或过期，会导致已配置好的
 * COS 图片被误拒 403）。
 *
 * 租户绑定：登录态显式校验（不依赖 proxy 重定向），且平台存储上的
 * 租户内容（ref/、gen/ 前缀，key 第二段为企业 ID）只允许本企业用户
 * 或超管访问，防止 A 企业取 B 企业图片；config/ 前缀为平台资产放行。
 */

/** 缓存存储配置（60s TTL），避免每张代理图片都查一次 system_setting */
let cfgCache: { at: number; cfg: StorageConfig } | null = null

async function getCachedStorageConfig(): Promise<StorageConfig> {
  if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.cfg
  const cfg = await loadStorageConfig()
  cfgCache = { at: Date.now(), cfg }
  return cfg
}

function isAllowedHost(url: URL, cfg: StorageConfig): boolean {
  const appUrl = new URL(env.NEXT_PUBLIC_APP_URL)
  // 同源
  if (url.host === appUrl.host) return true
  // COS 访问域名（system_setting 配置）
  if (cfg.cosBaseUrl) {
    try {
      if (url.host === new URL(cfg.cosBaseUrl).host) return true
    } catch {
      // ignore
    }
  }
  // COS 桶域名形如 <bucket>-<appid>.cos.<region>.myqcloud.com
  // 必须精确匹配桶名 + ".myqcloud.com"，避免 startsWith 被
  // 如 bucket-name-evil.myqcloud.com / bucket.evil.com.myqcloud.com 绕过。
  if (
    cfg.cosBucket &&
    cfg.cosRegion &&
    url.hostname === `${cfg.cosBucket}.cos.${cfg.cosRegion}.myqcloud.com`
  ) {
    return true
  }
  // 额外可信域名：精确 host，或以 "." 开头的后缀（与 cos.ts isAllowedDownloadHost 同语义）
  for (const entry of cfg.allowedDownloadHosts ?? []) {
    if (entry.startsWith(".")) {
      if (url.hostname.endsWith(entry)) return true
    } else if (url.hostname === entry) {
      return true
    }
  }
  return false
}

/**
 * 从平台存储路径中提取租户段（企业 ID）。
 * - 本应用 /uploads/<entId>/...（本地存储 key 规范）
 * - COS ref/<entId>/...、gen/<entId>/...、gen/thumb/<entId>/...（租户内容前缀）
 * config/ 前缀为平台资产，返回 null（不绑定租户）。
 */
function extractTenantSegment(pathname: string, cfg: StorageConfig): string | null {
  const p = pathname.replace(/^\/+/, "")
  if (p.startsWith("uploads/")) {
    return p.split("/")[1] || null
  }
  for (const prefix of [cfg.refPrefix, cfg.generatePrefix]) {
    if (prefix && p.startsWith(prefix)) {
      const seg = p.slice(prefix.length).split("/")[0]
      return seg || null
    }
  }
  return null
}

/**
 * 目标是否为自有存储（本站 /uploads 或配置的 COS 桶/访问域名）：
 * 对象键为 UUID、写后不变，可声明 1 年 immutable 长缓存；
 * 外部可信域名（allowedDownloadHosts）的内容可能变化，仅 24h。
 */
function isOwnStorageHost(url: URL, cfg: StorageConfig): boolean {
  const appUrl = new URL(env.NEXT_PUBLIC_APP_URL)
  if (url.host === appUrl.host) return true
  if (cfg.cosBaseUrl) {
    try {
      if (url.host === new URL(cfg.cosBaseUrl).host) return true
    } catch {
      // ignore
    }
  }
  return (
    Boolean(cfg.cosBucket) &&
    Boolean(cfg.cosRegion) &&
    url.hostname === `${cfg.cosBucket}.cos.${cfg.cosRegion}.myqcloud.com`
  )
}

/** 响应头阶段超时：防上游服务挂起（保留原 15s） */
const HEADER_TIMEOUT_MS = 15_000
/** body 流式阶段空闲超时：连续无数据才中止（防上游断流挂死） */
const IDLE_TIMEOUT_MS = 30_000
/** body 流式阶段总上限：慢涓流兜底，避免连接永动 */
const TOTAL_TIMEOUT_MS = 10 * 60_000

/**
 * 流式空闲看门狗：每个 chunk 的读取期间重置空闲计时，连续 IDLE_TIMEOUT
 * 无数据（或总时长超上限）时中止上游连接并向下游报错。
 *
 * 取代原先的 AbortSignal.timeout(15s) 总超时——它会掐断大文件（30MB+
 * 渲染原图/PSD）在慢链路下的整段传输，浏览器端表现为下载原图反复失败。
 * 计时只在 pull 内等待下一 chunk 时进行：下游背压（客户端收得慢）暂停在
 * pull 之间，不会触发误中止。Node 侧仍零缓冲逐 chunk 透传。
 */
function withIdleWatchdog(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let totalTimer: ReturnType<typeof setTimeout> | null = null
  let finished = false

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (totalTimer) clearTimeout(totalTimer)
    idleTimer = totalTimer = null
  }
  const abort = () => {
    clearTimers()
    upstream.abort()
  }
  totalTimer = setTimeout(abort, TOTAL_TIMEOUT_MS)

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(abort, IDLE_TIMEOUT_MS)
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        // 上游已被中止（看门狗/对端断开）
        finished = true
        clearTimers()
        controller.error(new Error("upstream aborted"))
        return
      }
      if (chunk.done) {
        finished = true
        clearTimers()
        controller.close()
        return
      }
      controller.enqueue(chunk.value)
    },
    cancel(reason) {
      finished = true
      clearTimers()
      void reader.cancel(reason).catch(() => {})
    },
  })
}

export async function GET(request: Request) {
  // 显式登录校验（proxy 中间件已挡未登录，这里 fail-closed 返回 401 而非依赖重定向）
  const session = await auth()
  if (!session?.user) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const target = searchParams.get("url")
  if (!target) {
    return new NextResponse("missing url", { status: 400 })
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return new NextResponse("invalid url", { status: 400 })
  }

  // 仅允许 https（防内网探测）
  if (targetUrl.protocol !== "https:") {
    return new NextResponse("only https allowed", { status: 403 })
  }

  let cfg: StorageConfig
  try {
    cfg = await getCachedStorageConfig()
  } catch {
    // 配置读取失败时拒绝（fail closed）
    return new NextResponse("storage config unavailable", { status: 503 })
  }

  if (!isAllowedHost(targetUrl, cfg)) {
    return new NextResponse("host not allowed (SSRF protection)", {
      status: 403,
    })
  }

  // 租户绑定：平台存储上的租户内容只允许本企业用户/超管访问
  const tenantSeg = extractTenantSegment(targetUrl.pathname, cfg)
  if (
    tenantSeg &&
    !session.user.isSuperAdmin &&
    tenantSeg !== session.user.enterpriseId
  ) {
    return new NextResponse("forbidden (tenant)", { status: 403 })
  }

  const upstream = new AbortController()
  const headerTimer = setTimeout(() => upstream.abort(), HEADER_TIMEOUT_MS)
  try {
    // 本站 /uploads URL 附短时效令牌（服务端回源 fetch 无会话 cookie）；
    // 先签名再做 COS 内网域名改写（改写后已非本站 URL，签名无效）
    const fetchUrl = toInternalCosFetchUrl(
      new URL(signUploadToken(targetUrl.toString())),
      cfg,
    )
    const resp = await fetch(fetchUrl, { signal: upstream.signal })
    clearTimeout(headerTimer)
    if (!resp.ok) {
      return new NextResponse(`upstream ${resp.status}`, {
        status: resp.status,
      })
    }
    const contentType = resp.headers.get("content-type") ?? "image/png"
    const headers = new Headers({
      "Content-Type": contentType,
      // 自有存储对象不可变（UUID 键），整机长缓存、重复下载/刷新不再
      // 回源；外部可信域名维持 24h
      "Cache-Control": isOwnStorageHost(targetUrl, cfg)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=86400",
    })
    // SVG 经代理透传时强制下载：防止在应用同源上下文直接导航执行脚本
    if (contentType.includes("image/svg+xml")) {
      headers.set("Content-Disposition", "attachment")
    }
    const contentLength = resp.headers.get("content-length")
    if (contentLength) headers.set("Content-Length", contentLength)
    // 流式透传响应体（不做整包 arrayBuffer 缓冲，100 图并发时避免
    // Node 进程内存峰值 = 并发数 × 原图体积）；空闲看门狗见函数注释
    return new NextResponse(
      resp.body ? withIdleWatchdog(resp.body, upstream) : null,
      { headers },
    )
  } catch {
    clearTimeout(headerTimer)
    return new NextResponse("fetch failed", { status: 502 })
  }
}
