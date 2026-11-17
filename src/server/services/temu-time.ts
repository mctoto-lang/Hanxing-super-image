/**
 * TEMU 数据日界统一工具。
 *
 * Temu 卖家中心的"今日/昨日/近7日"以北京时间（Asia/Shanghai）为日界；
 * 面板与入库侧此前的"今日"口径用的是服务器本地时区——生产容器为 UTC 时，
 * CST 00:00-08:00 的数据会被算进前一天：广告小时行分日错位 8 小时
 * （"今日广告消耗"只剩 08:00 后的部分）、"今日批次"过滤在凌晨采不到数据。
 * 所有 Temu 日口径一律经由本模块取 Asia/Shanghai，与服务器部署时区解耦。
 */

export const TEMU_TZ = "Asia/Shanghai"

/** Temu 日界的日期串（YYYY-MM-DD，北京时间） */
export function temuDayStr(d: Date = new Date()): string {
  return d.toLocaleDateString("sv-SE", { timeZone: TEMU_TZ })
}

/** 北京时间"今日零点"对应的绝对时间点（UTC Date） */
export function temuStartOfToday(): Date {
  return new Date(`${temuDayStr()}T00:00:00+08:00`)
}

/** 北京时间"昨日"日期串 */
export function temuYesterdayStr(): string {
  return temuDayStr(new Date(Date.now() - 24 * 3600 * 1000))
}

/** 北京时间"本周一零点"对应的绝对时间点（UTC Date；发货统计周口径起点） */
export function temuStartOfWeek(now: Date = new Date()): Date {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone: TEMU_TZ, weekday: "short" }).format(now),
  )
  // 北京时间的星期几不能取 UTC instant 的 getUTCDay（CST 00-08 点会差一天），
  // 星期序换算回退天数：周一=0、周日回退 6 天
  const diffDays = weekday === 0 ? 6 : Math.max(weekday - 1, 0)
  return new Date(new Date(`${temuDayStr(now)}T00:00:00+08:00`).getTime() - diffDays * 86_400_000)
}

/** epoch 毫秒 → 北京时间日期串（广告日报行分日用） */
export function temuDayOfTs(ts: number): string {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: TEMU_TZ })
}

/**
 * 上个自然周期的日期区间（概览卡片环比基线：对比上周期最后一天的最后一次同步快照）。
 * week = 上个自然周（周一~周日，ISO 口径，end=上周日）；month = 上个自然月（end=上月末）。
 * 末日缺数据时由调用方回退到区间内最近有数据的一天。
 */
export function previousPeriodRanges(now: Date = new Date()): {
  week: { start: string; end: string }
  month: { start: string; end: string }
} {
  const monday = temuStartOfWeek(now)
  const week = {
    start: temuDayStr(new Date(monday.getTime() - 7 * 86_400_000)),
    end: temuDayStr(new Date(monday.getTime() - 86_400_000)),
  }
  // 本月 1 日（北京时间）回退一天 = 上月末；再由上月末日拼出上月 1 日
  const firstOfMonth = new Date(`${temuDayStr(now).slice(0, 8)}01T00:00:00+08:00`)
  const monthEnd = temuDayStr(new Date(firstOfMonth.getTime() - 86_400_000))
  const month = { start: `${monthEnd.slice(0, 8)}01`, end: monthEnd }
  return { week, month }
}
