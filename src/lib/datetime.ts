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

/** 日粒度显示（官方接口仅到日的字段，如上架时间）：YYYY-MM-DD，空值或无效返回 —。 */
export function formatDate(input: string | number | Date | null | undefined): string {
  const full = formatDateTime(input)
  return full === "—" ? full : full.slice(0, 10)
}
