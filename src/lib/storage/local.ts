import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { env } from "@/lib/env"
import { describeFetchError } from "@/lib/fetch-error"
import { transferSemaphore } from "./semaphore"
import {
  DEFAULT_DOWNLOAD_HOST_SUFFIXES,
  DOWNLOAD_REFUSAL_URL_MAX,
  buildDownloadRefusalError,
  type DownloadHostCheck,
  loadStorageConfig,
  matchesAllowedHost,
  sameSiteAsHost,
} from "./config"
import { parseDataImageUrl } from "./data-url"

/**
 * 本地文件存储（手册 §3、§10.5）
 *
 * 路径规范：uploads/<enterpriseId>/image/<yyyy>/<mm>/<uuid>.<ext>
 * 缩略图：uploads/<enterpriseId>/thumb/<yyyy>/<mm>/<uuid>.<ext>
 */

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads")

function datePath(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  return `${yyyy}/${mm}`
}

function extFromUrl(url: string): string {
  const m = url.match(/\.(jpe?g|png|webp|gif|bmp)(?:\?|#|$)/i)
  return m ? m[1]!.toLowerCase() : "png"
}

export async function saveFromBuffer(
  buffer: Buffer,
  enterpriseId: string,
  ext: string,
  kind: "image" | "thumb" = "image",
): Promise<string> {
  const relDir = `${enterpriseId}/${kind}/${datePath()}`
  const absDir = path.join(UPLOAD_ROOT, relDir)
  await fs.mkdir(absDir, { recursive: true })
  const filename = `${randomUUID()}.${ext}`
  const absPath = path.join(absDir, filename)
  await fs.writeFile(absPath, buffer)
  // 返回可访问的相对 URL（由 /uploads 静态托管或代理）
  const rel = `${relDir}/${filename}`
  return `${env.NEXT_PUBLIC_APP_URL}/uploads/${rel}`
}

/** 最大下载体积 50MB（防止恶意/异常上游耗尽磁盘） */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
/** 下载超时 30s */
const DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * 校验下载目标是否可信。
 *
 * saveFromUrl 用于拉取 AI 上游返回的图片 URL。虽然上游理论可信，
 * 但若上游被攻陷或返回内网地址（如 http://169.254.169.254 云元数据），
 * 服务器会无限制拉取。这里与 cos.ts 适配器保持一致的白名单策略：
 * https + 同源 + env COS + 常见云存储后缀 + 平台配置的额外可信域名
 * （system_setting key=storage 的 allowedDownloadHosts，精确 host 或 "." 开头后缀）
 * + 调用方传入的可信域名提示（模型 API 端点，自动放行其同站 CDN 域名）。
 *
 * 显式白名单与端点同站提示放行 http：本机反代/网关（如 jimeng-free-api
 * 部署在 127.0.0.1）回传指向自身的图片地址，无法挂 https 证书。前者是
 * 管理员主动信任；后者的 API 调用本就发往该端点且允许 http，图片回拉
 * 同 host 不扩大攻击面。其余路径仍强制 https（防内网探测被动触发）。
 */
export function checkTrustedDownloadHost(
  url: URL,
  extraHosts: string[],
  hostHints: string[],
): DownloadHostCheck {
  // 平台配置的额外可信域名（管理员显式信任，含 http 源站）
  if (matchesAllowedHost(url.hostname, extraHosts)) return { ok: true }
  // 调用方提示的可信域名（如模型 API 端点）：同站（同一可注册域）即放行
  if (hostHints.some((hint) => sameSiteAsHost(url.hostname, hint))) {
    return { ok: true }
  }
  // 其余路径仅允许 https（防内网探测）
  if (url.protocol !== "https:") {
    return { ok: false, reason: "protocol", host: url.hostname }
  }
  // 同源
  try {
    const appUrl = new URL(env.NEXT_PUBLIC_APP_URL)
    if (url.host === appUrl.host) return { ok: true }
  } catch {
    // ignore
  }
  // COS 域名
  if (env.COS_BASE_URL) {
    try {
      const cosUrl = new URL(env.COS_BASE_URL)
      if (url.host === cosUrl.host) return { ok: true }
    } catch {
      // ignore
    }
  }
  // 常见云存储 / AI 上游图片 CDN 域名后缀（与 cos.ts 共用常量）
  if (DEFAULT_DOWNLOAD_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s))) {
    return { ok: true }
  }
  return { ok: false, reason: "host", host: url.hostname }
}

/** 信号量内完成下载（与 cos.ts 一致：排队不计入 30s 超时，写盘在信号量外） */
async function downloadBuffered(url: URL): Promise<Buffer> {
  await transferSemaphore.acquire()
  try {
    let resp: Response
    try {
      resp = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
    } catch (err) {
      // 仅包装网络层失败（fetch failed → cause）带目标与原因；超时/中止原样上抛
      const reason = describeFetchError(err)
      if (reason) {
        throw new Error(
          `下载失败: 无法连接 ${url.host}（${reason}，url=${url.toString().slice(0, DOWNLOAD_REFUSAL_URL_MAX)}）`,
        )
      }
      throw err
    }
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}（${url.host}）`)
    // 流式读取并限制体积，避免超大响应耗尽内存/磁盘
    const reader = resp.body?.getReader()
    if (!reader) {
      // 无流时回退到一次性读取（仍受 max 限制）
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

/** URL 是否已是本服务托管的对象（同源 + /uploads/ + key 含本企业段） */
function isOwnLocalObjectUrl(url: URL, enterpriseId: string): boolean {
  try {
    if (url.host !== new URL(env.NEXT_PUBLIC_APP_URL).host) return false
  } catch {
    return false
  }
  if (!url.pathname.startsWith("/uploads/")) return false
  return decodeURIComponent(url.pathname).split("/").includes(enterpriseId)
}

export async function saveFromUrl(
  sourceUrl: string,
  enterpriseId: string,
  kind: "image" | "thumb" = "image",
  trustedHostHints: string[] = [],
): Promise<string> {
  const ext = extFromUrl(sourceUrl)
  let targetUrl: URL
  try {
    targetUrl = new URL(sourceUrl)
  } catch {
    throw new Error(`下载失败: 无效 URL`)
  }
  // 已是本服务 /uploads 对象（key 含本企业段）：直接复用，不重复落盘
  if (isOwnLocalObjectUrl(targetUrl, enterpriseId)) {
    return sourceUrl
  }
  // data: URL（模型 b64_json 回传）：内容自包含，直接解码落盘，
  // 不走网络下载与域名白名单（data: 非 https 会被白名单误拒）
  const dataImage = parseDataImageUrl(sourceUrl)
  if (dataImage) {
    return await saveFromBuffer(
      dataImage.buffer,
      enterpriseId,
      dataImage.ext,
      kind,
    )
  }
  // 平台配置读取失败时回退为空（仅基础白名单生效），不阻断下载流程
  let extraHosts: string[] = []
  try {
    extraHosts = (await loadStorageConfig()).allowedDownloadHosts ?? []
  } catch {
    // ignore
  }
  const hostCheck = checkTrustedDownloadHost(targetUrl, extraHosts, trustedHostHints)
  if (!hostCheck.ok) {
    console.warn(
      `[storage] 拒绝下载：${hostCheck.reason === "protocol" ? "非 https 协议" : `域名 ${targetUrl.hostname} 不在可信白名单内`}（url=${sourceUrl.slice(0, 160)}）`,
    )
    throw buildDownloadRefusalError(targetUrl, hostCheck.reason)
  }
  const buffer = await downloadBuffered(targetUrl)
  return await saveFromBuffer(buffer, enterpriseId, ext, kind)
}

/**
 * 把 /uploads/xxx 映射回绝对路径；解析后越出 UPLOAD_ROOT 返回 null。
 *
 * URL 的 query/fragment 不参与解析器的路径规范化，其中的 ".." 段会被
 * path.join 原样拼成穿越路径（DB 中 URL 来自用户可写的 referenceImages，
 * cleanup 按其删除文件），故删除前必须困在 uploads 根内。
 */
export function getLocalPath(relUrl: string): string | null {
  const rel = relUrl.replace(/^.*\/uploads\//, "")
  // 显式拒绝越界段（..、绝对路径、反斜杠）；下方 resolve+困根校验兜底
  if (rel.split(/[\\/]/).includes("..") || rel.includes("\\") || path.isAbsolute(rel)) {
    return null
  }
  const abs = path.resolve(UPLOAD_ROOT, rel)
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    return null
  }
  return abs
}

/**
 * 批量删除本地对象（按可访问 URL）；文件不存在视为已删除。
 * 供 cleanup cron 按保留天数清理过期图（保留 DB 中的 URL，前端用占位提示）。
 */
export async function deleteObjects(urls: string[]): Promise<number> {
  let n = 0
  for (const u of urls) {
    const abs = getLocalPath(u)
    if (!abs) continue
    try {
      await fs.unlink(abs)
      n++
    } catch {
      // 不存在视为已删除，忽略
    }
  }
  return n
}

export { UPLOAD_ROOT }
