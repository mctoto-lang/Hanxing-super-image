/**
 * fetch 网络层错误的可读化描述。
 *
 * Node/undici 的全局 fetch 在 TCP/DNS/TLS 层失败时抛 TypeError("fetch failed")，
 * 真实原因藏在 err.cause（如 Error("connect ECONNREFUSED 127.0.0.1:8000")、
 * code=ETIMEDOUT，或多地址尝试的 AggregateError）——不展开就只有一句
 * "fetch failed"，无法定位是端点不通还是图片地址不可达。
 * ai 适配器（端点调用）与 storage 适配器（图片下载）共用本 helper，
 * 报错带上原因与目标即可区分失败环节。
 */

/** 展开 undici cause（含 AggregateError 多地址尝试），提取可读原因 */
function describeCause(cause: unknown): string | null {
  if (!cause) return null
  // AggregateError（happy-eyeballs 多地址并发尝试）：取首个子错误即可定位
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return describeCause(cause.errors[0]) ?? "未知连接错误"
  }
  if (cause instanceof Error) {
    if (cause.message) return cause.message
    const code = (cause as Error & { code?: string }).code
    if (code) return code
    return "未知连接错误"
  }
  if (typeof cause === "string" && cause) return cause
  return null
}

/**
 * 识别 fetch 网络层错误并给出可读原因；非网络层错误返回 null
 * （调用方继续用原 message / 自有包装逻辑）。
 */
export function describeFetchError(err: unknown): string | null {
  if (!(err instanceof TypeError) || err.message !== "fetch failed") {
    return null
  }
  const reason = describeCause((err as Error & { cause?: unknown }).cause)
  return reason ?? "未知连接错误"
}
