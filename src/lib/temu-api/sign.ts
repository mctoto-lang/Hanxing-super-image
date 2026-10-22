import { createHash } from "node:crypto"

/**
 * TEMU 开放平台请求签名（agentpartner.temu.com《签名规则》）
 *
 * 规则：请求体外层参数按 key ASCII 升序排序，逐个拼接 key+value
 * （数组/对象值以紧凑 JSON 参与拼接，内层不排序），整体前后各拼一次
 * app_secret，对全文做 MD5 取 32 位大写作为 sign 字段。
 */

/** 单值 → 参与签名的字符串（布尔/数值直接字符串化；数组/对象紧凑 JSON，保持原 key 顺序） */
function signValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** 构造参与 MD5 的原文：app_secret + 排序拼接串 + app_secret */
export function buildSignSource(
  params: Record<string, unknown>,
  appSecret: string,
): string {
  const keys = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
  let source = appSecret
  for (const key of keys) source += key + signValue(params[key])
  return source + appSecret
}

/** 计算请求签名（MD5 32 位大写） */
export function signTemuRequest(
  params: Record<string, unknown>,
  appSecret: string,
): string {
  return createHash("md5")
    .update(buildSignSource(params, appSecret), "utf8")
    .digest("hex")
    .toUpperCase()
}
