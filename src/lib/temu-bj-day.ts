/**
 * TEMU 日界工具（北京时区 Asia/Shanghai，与部署时区、浏览器时区解耦）：
 * 客户端（筛选默认值 / DateRangePicker 回传）与服务端（拼半开毫秒区间入参）共用，
 * 本文件不得引入服务端依赖。
 */

const BJ_TZ = "Asia/Shanghai"
export const BJ_DAY_MS = 86_400_000

/** 日期范围（起止必填；结构兼容 react-day-picker 的 DateRange，避免 lib 依赖其类型） */
export interface DayRange {
  from: Date
  to: Date
}

/** 北京时区某时刻所在日的日期串 YYYY-MM-DD */
export function toBjDay(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: BJ_TZ })
}

/** 北京时区今日 00:00（+08:00） */
export function bjToday(): Date {
  return new Date(`${toBjDay(new Date())}T00:00:00+08:00`)
}

/** 近 n 天（含今天）的日期范围：from = n-1 天前、to = 今天，均为北京 00:00 时刻 */
export function lastDaysRange(n: number): { from: Date; to: Date } {
  const to = bjToday()
  return { from: new Date(to.getTime() - (Math.max(1, Math.floor(n)) - 1) * BJ_DAY_MS), to }
}

/** 起止日期串是否为真实日历日（YYYY-MM-DD 且能被解析回同一天） */
export function isBjDayString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T00:00:00+08:00`)
  return Number.isFinite(t) && toBjDay(new Date(t)) === s
}

/** 起止日期串（YYYY-MM-DD，两端含）→ 北京日界半开毫秒区间 [start, end)：
 *  start = 起始日北京 00:00，end = 结束日次日北京 00:00。
 *  日期串非法时返回 null（由 schema 先行拦截，此处兜底） */
export function bjDayRangeToMs(from: string, to: string): { start: number; end: number } | null {
  if (!isBjDayString(from) || !isBjDayString(to)) return null
  const start = Date.parse(`${from}T00:00:00+08:00`)
  const endDay = new Date(`${to}T00:00:00+08:00`)
  endDay.setUTCDate(endDay.getUTCDate() + 1)
  return { start, end: endDay.getTime() }
}

/** 起止日期（两端含）的天数：from = to 为 1 天；非法入参返回 NaN */
export function bjDaySpan(from: Date, to: Date): number {
  const ms = bjDayRangeToMs(toBjDay(from), toBjDay(to))
  return ms ? (ms.end - ms.start) / BJ_DAY_MS : NaN
}

/** 同 bjDayRangeToMs，但换算成「两端含」的毫秒端点（end = 次日 00:00 前 1ms）：
 *  官方 Begin/End 是否含端点未实证，按两端含传参在两种语义下都不漏不多 */
export function bjDayRangeToInclusiveMs(
  from: string,
  to: string,
): { start: number; end: number } | null {
  const ms = bjDayRangeToMs(from, to)
  return ms ? { start: ms.start, end: ms.end - 1 } : null
}

/* ─── 浏览器端（筛选默认值 / 日历回传） ───
 * 日历按浏览器本地日历选日：回传「用户看到的那个日期串」，服务端再按北京日界拼区间，
 * 与浏览器时区无关。调用方须在挂载后（layout effect）再取默认值——渲染期 new Date()
 * 会与 SSR 时刻不一致，引发 hydration 文本差异 */

/** Date → 浏览器本地日历的日期串 YYYY-MM-DD */
export function localDayString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1)
  const day = String(d.getDate())
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`
}

/** 近 n 天（含今天，浏览器本地日历）：from = n-1 天前、to = 今天，均为本地 00:00 */
export function localLastDays(now: Date, n: number): DayRange {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const from = new Date(to)
  from.setDate(from.getDate() - (Math.max(1, Math.floor(n)) - 1))
  return { from, to }
}

/** 起止日期（两端含）在浏览器本地日历上的天数：from = to 为 1 天 */
export function localDaySpan(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((b - a) / BJ_DAY_MS) + 1
}

/** 本地日历加 n 天（保留时分秒归零到当天 00:00） */
export function localAddDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() + n)
  return out
}
