/**
 * Temu 数据日界统一工具。
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

/** epoch 毫秒 → 北京时间日期串（广告日报行分日用） */
export function temuDayOfTs(ts: number): string {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: TEMU_TZ })
}
