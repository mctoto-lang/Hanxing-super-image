/** TEMU 全站统一时间显示口径：YYYY-MM-DD HH:mm:ss（24 小时制、补零、浏览器本地时区）。
 *  入参兼容 ISO 串 / epoch 秒或毫秒（<1e12 视为秒）/ Date；空值或无效返回 —。 */
export function formatDateTime(input: string | number | Date | null | undefined): string {
  if (input == null || input === "" || input === 0) return "—"
  const d =
    input instanceof Date
      ? input
      : new Date(typeof input === "number" ? (input < 1e12 ? input * 1000 : input) : input)
  if (Number.isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 日粒度显示（官方接口仅到日的字段，如创建时间）：YYYY-MM-DD，空值或无效返回 —。 */
export function formatDate(input: string | number | Date | null | undefined): string {
  const full = formatDateTime(input)
  return full === "—" ? full : full.slice(0, 10)
}

/** 中文全格式（TEMU 概览时间框/同步时间弹窗）：YYYY年MM月DD日HH时mm分ss秒，
 *  24 小时制补零、浏览器本地时区；空值或无效返回 —。 */
export function formatCnDateTime(input: string | number | Date | null | undefined): string {
  const full = formatDateTime(input)
  if (full === "—") return full
  const [date, time] = full.split(" ")
  const [y, m, d] = date.split("-")
  const [h, min, s] = time.split(":")
  return `${y}年${m}月${d}日${h}时${min}分${s}秒`
}
