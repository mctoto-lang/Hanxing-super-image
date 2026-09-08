import { env } from "@/lib/env"
import { loadStorageConfig } from "./config"

/**
 * 参考图 URL 归属校验（防跨租户引用 + 把上游 AI 服务当 SSRF 代理）。
 *
 * 参考图 URL 会被原样转发给上游生图 API 拉取，必须确保：
 *  - 只指向本平台托管的存储（应用自身 /uploads 或平台 COS 桶）；
 *  - 对象 key 路径中含本企业 ID 段（存储 key 规范：${前缀}<enterpriseId>/yyyy/mm/uuid.ext），
 *    防止 A 企业引用 B 企业的图片。
 *
 * 合法形态：
 *  - data: URL（自包含，无服务端拉取）
 *  - 本平台绝对/相对 URL：host 同 NEXT_PUBLIC_APP_URL，路径含 /<enterpriseId>/ 段
 *  - 平台 COS 桶域名（canonical <bucket>.cos.<region>.myqcloud.com 或 cosBaseUrl），
 *    key 路径含 <enterpriseId> 段
 *  - /api/image/proxy?url=<encoded> 包装：解包后按上述绝对 URL 规则校验
 */

/** 路径中是否含企业 ID 段（按 / 分段精确匹配，防 ID 前缀重叠误判） */
function pathHasEntId(pathname: string, enterpriseId: string): boolean {
  return pathname.split("/").includes(enterpriseId)
}

/** 平台可信存储 host 集合（应用自身 + COS 桶域名） */
async function allowedStorageHosts(): Promise<Set<string>> {
  const hosts = new Set<string>()
  try {
    hosts.add(new URL(env.NEXT_PUBLIC_APP_URL).hostname)
  } catch {
    // NEXT_PUBLIC_APP_URL 未配置时跳过（env 校验兜底）
  }
  try {
    const cfg = await loadStorageConfig()
    if (cfg.cosBaseUrl) {
      try {
        hosts.add(new URL(cfg.cosBaseUrl).hostname)
      } catch {
        // ignore
      }
    }
    if (cfg.cosBucket && cfg.cosRegion) {
      hosts.add(`${cfg.cosBucket}.cos.${cfg.cosRegion}.myqcloud.com`)
    }
  } catch {
    // 平台配置读取失败时仅保留应用自身 host
  }
  return hosts
}

function checkAbsoluteUrl(
  url: URL,
  enterpriseId: string,
  hosts: Set<string>,
): boolean {
  if (!hosts.has(url.hostname)) return false
  return pathHasEntId(url.pathname, enterpriseId)
}

/**
 * 校验一组参考图 URL；返回 null 表示全部合法，否则返回拒绝原因。
 */
export async function validateReferenceImageUrls(
  urls: string[],
  enterpriseId: string,
): Promise<string | null> {
  if (urls.length === 0) return null
  const hosts = await allowedStorageHosts()

  for (const raw of urls) {
    if (raw.startsWith("data:")) continue

    let target = raw
    // 解包代理包装：/api/image/proxy?url=<encoded>
    if (target.startsWith("/api/image/proxy?")) {
      try {
        const inner = new URL(target, env.NEXT_PUBLIC_APP_URL).searchParams.get("url")
        if (!inner) return "参考图 URL 非法（代理参数缺失）"
        target = inner
      } catch {
        return "参考图 URL 非法"
      }
    }

    try {
      // 相对路径（/uploads/...）以应用 URL 为基解析
      const parsed = new URL(target, env.NEXT_PUBLIC_APP_URL)
      // query/fragment 中的 ".." 不参与 URL 路径规范化，但本地删除时会被
      // path.join 原样拼接成穿越路径（见 local.ts getLocalPath），直接拒绝
      if (parsed.search.includes("..") || parsed.hash.includes("..")) {
        return "参考图 URL 非法"
      }
      if (!checkAbsoluteUrl(parsed, enterpriseId, hosts)) {
        return "参考图必须来自本企业上传的图片（不支持外部 URL）"
      }
    } catch {
      return "参考图 URL 非法"
    }
  }
  return null
}

/**
 * 单个 URL 是否指向平台可信存储（应用自身或 COS 桶）。
 * 供服务端二次拉取（如导出 ZIP 内嵌 fetch）前防 SSRF：非可信 host 一律
 * 不发起请求。只做 host 白名单 + 协议收紧（应用自身 http 放行以兼容本地
 * 开发，其余仅 https）；租户段校验由写入侧 validateReferenceImageUrls 保证。
 */
export async function isPlatformStorageUrl(raw: string): Promise<boolean> {
  if (raw.startsWith("data:")) return true // 自包含，无服务端请求
  const hosts = await allowedStorageHosts()
  let appHost: string | null = null
  try {
    appHost = new URL(env.NEXT_PUBLIC_APP_URL).hostname
  } catch {
    // NEXT_PUBLIC_APP_URL 未配置时仅按白名单 host 判断
  }
  try {
    const parsed = new URL(raw, env.NEXT_PUBLIC_APP_URL)
    if (!hosts.has(parsed.hostname)) return false
    if (parsed.protocol !== "https:" && parsed.hostname !== appHost) {
      return false
    }
    return true
  } catch {
    return false
  }
}
