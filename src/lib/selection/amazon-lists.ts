/**
 * Amazon 榜单（选品发现模式）站点 × 榜单类型 × 品类 → zgbs 链接（client-safe）
 *
 * 2026-11-24 用 junglee/amazon-bestsellers 逐组合实测的结论，表单选项与入参
 * 共用本表，实测不支持的组合不进表单：
 *   - 榜单类型：畅销榜（/gp/bestsellers/<slug>）与新品榜（/gp/new-releases/<slug>）可用；
 *     飙升榜（/gp/movers-and-shakers/…）返回 bestsellers_category_not_found，不提供
 *   - 站点：美 / 英 / 日 / 加 / 法；德国站所有品类链接均不被识别，不提供
 *   - 「全站总榜」（不带品类的 /gp/bestsellers）任何站点都不出数据，不提供
 *   - 品类 slug 随站点不同（如家居 garden、运动户外只在部分站点可用），见 SUPPORTED
 *   - 旧选项里的 home-kitchen / sports-outdoors 在美国站也不被识别（正确 slug 为
 *     home-garden / sporting-goods）
 */

export type AmazonSite = "US" | "UK" | "DE" | "JP" | "CA" | "FR"

export const AMAZON_SITE_DOMAINS: Record<AmazonSite, string> = {
  US: "amazon.com",
  UK: "amazon.co.uk",
  DE: "amazon.de",
  JP: "amazon.co.jp",
  CA: "amazon.ca",
  FR: "amazon.fr",
}

export const AMAZON_SITE_LABELS: Record<AmazonSite, string> = {
  US: "美国",
  UK: "英国",
  DE: "德国",
  JP: "日本",
  CA: "加拿大",
  FR: "法国",
}

export const AMAZON_SITE_CURRENCIES: Record<AmazonSite, string> = {
  US: "USD",
  UK: "GBP",
  DE: "EUR",
  JP: "JPY",
  CA: "CAD",
  FR: "EUR",
}

/** 关键词搜索可用站点（市场模式） */
export const AMAZON_MARKET_SITES: AmazonSite[] = ["US", "UK", "DE", "JP", "CA", "FR"]

/** 榜单可用站点（德国站实测不支持） */
export const AMAZON_LIST_SITES: AmazonSite[] = ["US", "UK", "JP", "CA", "FR"]

export type AmazonListType = "bestsellers" | "new-releases"

export const AMAZON_LIST_TYPES: Array<{ value: AmazonListType; label: string }> = [
  { value: "bestsellers", label: "畅销榜 Best Sellers" },
  { value: "new-releases", label: "新品榜 New Releases" },
]

export const AMAZON_LIST_TYPE_LABELS: Record<AmazonListType, string> = {
  bestsellers: "畅销榜",
  "new-releases": "新品榜",
}

export type AmazonCategory =
  | "electronics"
  | "home-garden"
  | "kitchen"
  | "fashion"
  | "beauty"
  | "sporting-goods"
  | "toys-and-games"
  | "pet-supplies"
  | "office-products"

export const AMAZON_CATEGORIES: Array<{ value: AmazonCategory; label: string }> = [
  { value: "electronics", label: "消费电子" },
  { value: "home-garden", label: "家居花园" },
  { value: "kitchen", label: "厨房餐厅" },
  { value: "fashion", label: "服装鞋履" },
  { value: "beauty", label: "美妆护肤" },
  { value: "sporting-goods", label: "运动户外" },
  { value: "toys-and-games", label: "玩具游戏" },
  { value: "pet-supplies", label: "宠物用品" },
  { value: "office-products", label: "办公用品" },
]

/** 实测支持矩阵：站点 → 可用品类（畅销榜实测；新品榜共用同一节点树） */
const SUPPORTED: Record<AmazonSite, readonly AmazonCategory[]> = {
  US: AMAZON_CATEGORIES.map((c) => c.value),
  UK: ["electronics", "home-garden", "kitchen", "fashion", "pet-supplies"],
  DE: [],
  JP: ["electronics", "fashion", "beauty", "pet-supplies", "office-products"],
  CA: ["electronics", "kitchen", "fashion", "beauty", "pet-supplies"],
  FR: ["electronics", "kitchen", "fashion", "beauty", "pet-supplies"],
}

/** 各站点都支持的品类（表单默认值取它，保证默认组合可用） */
export const AMAZON_DEFAULT_CATEGORY: AmazonCategory = "electronics"

export function isAmazonSite(v: string): v is AmazonSite {
  return (Object.keys(AMAZON_SITE_DOMAINS) as string[]).includes(v)
}

export function amazonCategoryLabel(category: string): string {
  return AMAZON_CATEGORIES.find((c) => c.value === category)?.label ?? category
}

/** 某站点榜单可用的品类 */
export function amazonListCategories(site: string): AmazonCategory[] {
  return isAmazonSite(site) ? [...SUPPORTED[site]] : []
}

export function amazonListSupported(site: string, category: string): boolean {
  return amazonListCategories(site).includes(category as AmazonCategory)
}

/** 榜单品类表单选项（带站点条件，由注册表转成 showWhen） */
export function amazonCategoryOptionData(): Array<{
  value: AmazonCategory
  label: string
  sites: string[]
}> {
  return AMAZON_CATEGORIES.map((c) => ({
    value: c.value,
    label: c.label,
    sites: AMAZON_LIST_SITES.filter((s) => SUPPORTED[s].includes(c.value)),
  }))
}

/** 榜单链接；组合不在支持矩阵内返回 null（调用方不得提交） */
export function amazonListUrl(
  site: string,
  listType: string,
  category: string,
): string | null {
  if (!isAmazonSite(site) || !AMAZON_LIST_SITES.includes(site)) return null
  if (listType !== "bestsellers" && listType !== "new-releases") return null
  if (!amazonListSupported(site, category)) return null
  return `https://www.${AMAZON_SITE_DOMAINS[site]}/gp/${listType}/${category}`
}

export function amazonDomainForSite(site: string): string {
  return AMAZON_SITE_DOMAINS[isAmazonSite(site) ? site : "US"]
}

export function amazonCurrencyForSite(site: string): string {
  return AMAZON_SITE_CURRENCIES[isAmazonSite(site) ? site : "US"]
}

/** 从 Amazon 商品链接域名推导 ISO 币种（非 Amazon 域名返回 null） */
export function amazonCurrencyForHost(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/^smile\./, "")
  const site = (Object.keys(AMAZON_SITE_DOMAINS) as AmazonSite[]).find(
    (s) => AMAZON_SITE_DOMAINS[s] === h,
  )
  return site ? AMAZON_SITE_CURRENCIES[site] : null
}

/** junglee 家族 price.currency 可能给符号而非 ISO 码（"$"/"£"/"€"） */
export function amazonCurrencyForSymbol(symbol: string): string | null {
  const map: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "¥": "JPY" }
  return map[symbol] ?? null
}

/** 从商品链接解析 ASIN（/dp/ASIN、/gp/product/ASIN、/exec/obidos/ASIN） */
export function amazonAsinFromUrl(url: string): string | null {
  const m = url.match(/\/(?:dp|gp\/product|exec\/obidos)\/([A-Z0-9]{10})(?:[/?#]|$)/i)
  return m ? m[1]!.toUpperCase() : null
}

/** 规范商品链接（去追踪参数；ASIN 与站点已知时直接拼） */
export function canonicalAmazonUrl(input: { url?: string | null; asin?: string | null; site?: string | null }): string | null {
  const asin = input.asin ?? (input.url ? amazonAsinFromUrl(input.url) : null)
  if (!asin) return input.url ?? null
  let site = input.site && isAmazonSite(input.site) ? input.site : null
  if (!site && input.url) {
    try {
      const host = new URL(input.url).hostname
      site =
        (Object.keys(AMAZON_SITE_DOMAINS) as AmazonSite[]).find(
          (s) => AMAZON_SITE_DOMAINS[s] === host.replace(/^www\./, "").replace(/^smile\./, ""),
        ) ?? null
    } catch {
      site = null
    }
  }
  return `https://www.${amazonDomainForSite(site ?? "US")}/dp/${asin}`
}
