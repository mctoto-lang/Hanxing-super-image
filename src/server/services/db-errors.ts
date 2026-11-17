/**
 * PG 错误判定（按错误码，不看 message）。
 *
 * drizzle-orm 0.45 会把驱动错误包成 DrizzleQueryError：message 是
 * `Failed query: <SQL>\nparams: ...`，不含 PG 错误文案；真实错误
 * （含 code，如唯一冲突 23505）只挂 `.cause` 上。此前散落各处的
 * `err.message.includes("unique")` 判重因此在 drizzle 包装下永远为
 * false（死分支），一律走通用兜底文案。
 */

/** 沿 err → .cause 链找 PG 错误码（防循环；裸驱动错误首跳即中） */
export function pgErrorCode(err: unknown): string | null {
  let cur: unknown = err
  const seen = new Set<unknown>()
  while (typeof cur === "object" && cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as { code?: unknown }).code
    if (typeof code === "string") return code
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/** PG 唯一约束冲突（unique_violation, 23505） */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505"
}
