/**
 * 原始行防御式取值工具（client-safe：normalizers / extras / 监控链接解析共用）
 *
 * Actor 出参随时可能改版或缺字段：所有取值都不得抛错，缺失返回 null / 空集合。
 */

export type Row = Record<string, unknown>

/** 依序取第一个非空字符串（有限数字转字符串） */
export function S(row: Row, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

/** 依序取第一个有限数字（容忍数字字符串）；嵌套一层对象取 {value} */
export function N(row: Row, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v)
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = (v as Row).value
      if (typeof inner === "number" && Number.isFinite(inner)) return inner
    }
  }
  return null
}

/** 嵌套对象安全取（非对象返回空对象） */
export function obj(v: unknown): Row {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {}
}

/** 对象数组安全取（丢弃非对象元素） */
export function arr(v: unknown): Row[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Row[]) : []
}

/** 字符串数组（丢弃空串；空集合归一为 null） */
export function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
  return out.length > 0 ? out : null
}

/** 数组里挑出 http(s) 链接 */
export function httpList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && /^https?:\/\//i.test(x))
    : []
}

/** 对象数组抽 url/src 等字段（Shopify medias、TikTok slideshowImageLinks 等） */
export function urlArray(v: unknown, ...keys: string[]): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const el of v) {
    if (typeof el === "string" && el.startsWith("http")) out.push(el)
    else if (el && typeof el === "object") {
      for (const k of keys) {
        const u = (el as Row)[k]
        if (typeof u === "string" && u.startsWith("http")) {
          out.push(u)
          break
        }
      }
    }
  }
  return out.length > 0 ? out : null
}

/** 依序取第一个 http(s) 链接 */
export function firstHttp(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v
  }
  return null
}

/** 去重保序（链接列表合并） */
export function unique(list: Array<string | null>): string[] {
  const out: string[] = []
  for (const u of list) {
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

/** "A > B > C" 面包屑 → ["A","B","C"]（只有一段时视为无层级，返回 null） */
export function splitPath(v: string | null): string[] | null {
  if (!v) return null
  const parts = v
    .split(" > ")
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : null
}

/** 可直接播放的视频地址（路径以 .mp4/.m3u8/.webm/.mov 结尾，带签名 query 也算） */
export function isDirectVideoUrl(u: string): boolean {
  return /\.(mp4|m3u8|webm|mov)([?#]|$)/i.test(u)
}

/** "1.2K+"/"10K+"/"3M"/"500+" / "3K+ bought in past month" / "1.2万" → 数字 */
export function parseCountText(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v)
  if (typeof v !== "string" || v.trim() === "") return null
  // 尾巴若紧跟字母/CJK/数字（"1.5B"、"2千3"）说明是认不出的单位写法，宁缺毋滥返回 null
  const m = v.replace(/,/g, "").trim().match(/^([\d.]+)\s*(K|k|M|m|W|w|千|万|亿)?\+?([\s\S]*)$/)
  if (!m) return null
  if (m[3] && /^[A-Za-z0-9\u4e00-\u9fff]/.test(m[3])) return null
  const base = Number(m[1])
  if (!Number.isFinite(base)) return null
  const mult =
    m[2] === "K" || m[2] === "k" ? 1e3 : m[2] === "M" || m[2] === "m" ? 1e6 : m[2] === "W" || m[2] === "w" ? 1e4 : m[2] === "万" ? 1e4 : m[2] === "亿" ? 1e8 : m[2] === "千" ? 1e3 : 1
  return Math.floor(base * mult)
}

/** 金额文本 "$53.99" / "US $1,234.56" → 数字（剥货币符号与千分位；无数字返回 null） */
export function moneyText(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v !== "string" || v.trim() === "") return null
  const m = v.match(/-?\d[\d,]*(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}

/**
 * TEMU CRW（crw/temu-products-scraper）金额：字符串价格（price_str = "$3.09"，元）
 * 优先；数字 price / market_price 是分，除以 100。两者都没有返回 null。
 */
export function temuPrice(row: Row, strKey: string, numKey: string): number | null {
  const fromText = moneyText(row[strKey])
  if (fromText != null) return fromText
  const cents = N(row, numKey)
  return cents != null ? cents / 100 : null
}

/**
 * TEMU CRW 行的降幅百分比：按 market_price 与 price 推算——出参里的 reduction_pct
 * 不是折扣率（实测标"降5%"实际便宜 52%~59%），算不出（缺价 / 市场价不高于售价）为 null。
 */
export function temuDiscountPct(row: Row): number | null {
  const price = temuPrice(row, "price_str", "price")
  const market = temuPrice(row, "market_price_str", "market_price")
  if (price == null || market == null || market <= price || market <= 0) return null
  return Math.round(((market - price) / market) * 100)
}

/** X videoVariants 里码率最高的 mp4 直链（mediaUrl 是缩略图 JPG，不是视频） */
export function bestMp4Variant(v: unknown): string | null {
  const variants = arr(v)
    .map((x) => ({ url: S(x, "url"), mp4: (S(x, "contentType") ?? "").includes("mp4"), bitrate: N(x, "bitrate") }))
    .filter((x) => x.url && x.mp4)
  if (variants.length === 0) return null
  return variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]!.url!
}

/** 时间戳 / ISO / RFC 字符串 → Date（秒级时间戳自动 ×1000；无效返回 null） */
export function toDate(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v < 1e12 ? v * 1000 : v)
  }
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

/** 链接主机名（解析失败返回空串） */
export function hostOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname : ""
  } catch {
    return ""
  }
}
