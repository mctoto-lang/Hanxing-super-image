/**
 * 标量 id 入参校验（selection server action 入口共用）
 *
 * 非法字符串直接进 eq/inArray 的 uuid 列会让 PG 抛 invalid input syntax →
 * 500；入口先过格式，非法按各 action 既有的错误/空结果形状返回。
 * "use server" 文件只能导出 async 函数，故独立放本模块。
 */

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** 单个 uuid：合法返回原值，非法返回 null */
export function parseUuid(v: unknown): string | null {
  if (typeof v !== "string") return null
  const s = v.trim()
  return UUID_RE.test(s) ? s : null
}

/** uuid 数组：过滤非法项（非数组/全非法返回空数组） */
export function parseUuidList(vs: unknown): string[] {
  if (!Array.isArray(vs)) return []
  const out: string[] = []
  for (const v of vs) {
    const parsed = parseUuid(v)
    if (parsed != null) out.push(parsed)
  }
  return out
}
