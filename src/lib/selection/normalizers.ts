import type { SelectionPlatform } from "./platforms"

/**
 * Apify 原始行 → selection_result 统一列（server-only）
 *
 * 字段映射依据 2026-11-19 各 Actor 实际试抓的 dataset 字段清单（见
 * platforms.ts 文件头备忘）。全部访问防御式取值：字段缺失/改版时统一列
 * 置 null，完整原始行恒存 rawData，归一化永不抛错。
 */

export interface NormalizedResult {
  externalId: string | null
  sourceUrl: string | null
  dedupeKey: string
  title: string | null
  content: string | null
  /** numeric 列以字符串落库（"29.99"） */
  price: string | null
  originalPrice: string | null
  currency: string | null
  rating: string | null
  reviewCount: number | null
  salesCount: number | null
  likesCount: number | null
  commentsCount: number | null
  sharesCount: number | null
  viewsCount: number | null
  sellerName: string | null
  images: string[] | null
  videos: string[] | null
  category: string | null
  categoryPath: string[] | null
  tags: string[] | null
  hashtags: string[] | null
  publishedAt: Date | null
  rawData: Record<string, unknown>
}

type Row = Record<string, unknown>

/** 依序取第一个非空字符串 */
function S(row: Row, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === "string" && v.trim() !== "") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

/** 依序取第一个有限数字（容忍数字字符串）；嵌套一层对象取 {value} */
function N(row: Row, ...keys: string[]): number | null {
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

/** "1.2K+"/"10K+"/"3M"/"500+" → 数字 */
export function parseCountText(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v)
  if (typeof v !== "string" || v.trim() === "") return null
  const m = v.replace(/,/g, "").trim().match(/^([\d.]+)\s*([KkMmWw]?)\+?/)
  if (!m) return null
  const base = Number(m[1])
  if (!Number.isFinite(base)) return null
  const mult =
    m[2] === "K" || m[2] === "k" ? 1e3 : m[2] === "M" || m[2] === "m" ? 1e6 : m[2] === "W" || m[2] === "w" ? 1e4 : 1
  return Math.floor(base * mult)
}

/** 数字 → numeric 列字符串（两位小数） */
function money(n: number | null): string | null {
  return n == null ? null : n.toFixed(2)
}

function toDate(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // 秒级时间戳（Reddit created / IG timestamp 秒）
    return new Date(v < 1e12 ? v * 1000 : v)
  }
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
  return out.length > 0 ? out : null
}

/** 对象数组抽 url/src 字段（Shopify medias 等） */
function urlArray(v: unknown, ...keys: string[]): string[] | null {
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

function firstHttp(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.startsWith("http")) return v
  }
  return null
}

function tagsOf(...parts: Array<string | false | null | undefined>): string[] | null {
  const out = parts.filter((p): p is string => Boolean(p))
  return out.length > 0 ? out : null
}

/** 指纹防碰撞：前 160 + 后 160 拼接（只取前缀会让开头相同的不同行被静默去重） */
function headTailFingerprint(s: string): string {
  return `${s.slice(0, 160)}|${s.slice(-160)}`
}

/** 幂等键：平台 ID > 原始链接 > 标题/正文指纹 */
function dedupeKeyFor(row: Row, externalId: string | null, sourceUrl: string | null): string {
  if (externalId) return `id:${externalId}`
  if (sourceUrl) return `url:${sourceUrl}`
  const fp = S(row, "title", "text", "caption", "postText", "keyword", "term", "name")
  return `fp:${headTailFingerprint(fp ?? JSON.stringify(row))}`
}

export function normalizeSelectionItem(
  platform: SelectionPlatform,
  taskType: "discover" | "market" | "monitor" | "review",
  row: Row,
): NormalizedResult {
  const map = pickMapper(platform, taskType)
  const partial = map(row)
  // 平台映射缺省的列统一补 null（rawData 恒存原行，列缺失只影响展示）
  const filled = {
    externalId: null,
    sourceUrl: null,
    title: null,
    content: null,
    price: null,
    originalPrice: null,
    currency: null,
    rating: null,
    reviewCount: null,
    salesCount: null,
    likesCount: null,
    commentsCount: null,
    sharesCount: null,
    viewsCount: null,
    sellerName: null,
    images: null,
    videos: null,
    category: null,
    categoryPath: null,
    tags: null,
    hashtags: null,
    publishedAt: null,
    ...partial,
  } satisfies Omit<NormalizedResult, "dedupeKey" | "rawData">
  return {
    ...filled,
    dedupeKey: dedupeKeyFor(row, filled.externalId, filled.sourceUrl),
    rawData: row,
  }
}

/** 各平台映射返回自己有的列，其余由 normalizeSelectionItem 补 null */
type PartialNormalized = Partial<Omit<NormalizedResult, "dedupeKey" | "rawData">>

function pickMapper(
  platform: SelectionPlatform,
  taskType: "discover" | "market" | "monitor" | "review",
): (row: Row) => PartialNormalized {
  if (taskType === "monitor") {
    // 指标重抓（0106）：URL 直抓 actor 出参；reddit/tiktok/x/shopify 与市场映射
    // 同构，amazon 复用发现模式 actor（curious_coder），IG/FB 为官方帖子 actor
    const monitorMap: Partial<Record<SelectionPlatform, (row: Row) => PartialNormalized>> = {
      amazon: mapAmazonBestsellers,
      shopify: mapShopifyProducts,
      instagram: mapInstagramPost,
      tiktok: mapTiktok,
      pinterest: mapPinterest,
      reddit: mapRedditSearch,
      x: mapX,
      facebook: mapFacebookPost,
    }
    const m = monitorMap[platform]
    if (m) return m
  }
  if (taskType === "discover") {
    const discoverMap: Partial<Record<SelectionPlatform, (row: Row) => PartialNormalized>> = {
      amazon: mapAmazonBestsellers,
      temu: mapTemuCRW,
      etsy: mapEtsyTrending,
      pinterest: mapPinterestTrends,
      reddit: mapRedditSubreddit,
      shopify: mapShopifyStore,
    }
    const m = discoverMap[platform]
    if (m) return m
    // instagram/tiktok/x/facebook 发现模式与市场同构
  }
  const marketMap: Record<SelectionPlatform, (row: Row) => PartialNormalized> = {
    amazon: mapAmazonSearch,
    etsy: mapEtsySearch,
    temu: mapTemuCRW,
    shopify: mapShopifyProducts,
    instagram: mapInstagram,
    tiktok: mapTiktok,
    pinterest: mapPinterest,
    reddit: mapRedditSearch,
    x: mapX,
    facebook: mapFacebook,
  }
  return marketMap[platform]
}

// ── 市场分析模式 ──────────────────────────────────────────────

/** santamaria-automations/amazon-search-scraper（试抓 2026-11-19） */
function mapAmazonSearch(row: Row): PartialNormalized {
  return {
    externalId: S(row, "asin"),
    sourceUrl: S(row, "url"),
    title: S(row, "title"),
    price: money(N(row, "price")),
    originalPrice: money(N(row, "listPrice")),
    currency: (row.price && typeof row.price === "object" ? S(row.price as Row, "currency") : null) ?? "USD",
    rating: money(N(row, "stars")),
    reviewCount: N(row, "reviewsCount"),
    salesCount: parseCountText(row.purchaseVolumeText),
    sellerName: S(row, "brand"),
    images: urlArray([row.thumbnailImage, row.imageLarge].filter(Boolean)) ?? (firstHttp(row.thumbnailImage, row.imageLarge) ? [firstHttp(row.thumbnailImage, row.imageLarge)!] : null),
    category: S(row, "bestSellerCategory"),
    tags: tagsOf(
      row.isBestSeller === true ? "Best Seller" : null,
      row.isAmazonChoice === true ? "Amazon's Choice" : null,
      row.isSponsored === true ? "广告" : null,
      row.isPrime === true ? "Prime" : null,
    ),
  }
}

/** devcake/etsy-search-scraper（试抓 2026-11-19） */
function mapEtsySearch(row: Row): PartialNormalized {
  const price = N(row, "price_num", "price_int", "price")
  const discount = N(row, "discount_price")
  return {
    externalId: S(row, "listing_id"),
    sourceUrl: S(row, "detail_url", "url"),
    title: S(row, "title"),
    price: money(discount != null && price != null && discount < price ? discount : price),
    originalPrice: discount != null && price != null && discount < price ? money(price) : null,
    currency: S(row, "currency_code") ?? "USD",
    rating: money(N(row, "rating")),
    reviewCount: N(row, "review_count"),
    likesCount: N(row, "favorites"),
    sellerName: S(row, "shop_name"),
    images: urlArray(row.images) ?? (firstHttp(row.image_url) ? [firstHttp(row.image_url)!] : null),
    category: S(row, "category_name"),
    categoryPath: strArray(row.taxonomy_path),
    tags: tagsOf(
      row.is_bestseller === true ? "畅销" : null,
      row.is_top_rated === true ? "高分" : null,
      row.is_ad === true ? "广告" : null,
      row.is_sold_out === true ? "售罄" : null,
    ),
  }
}

/**
 * crw/temu-products-scraper（2026-11-20 切换；市场搜索与销量榜 discover 共用）
 * 输出字段：goods_id/price/market_price/rating/review_count/sales_num（"10K+"
 * 文本）/reduction_pct/image_url/thumb_url/link_url/currency/video_url
 */
function mapTemuCRW(row: Row): PartialNormalized {
  return {
    externalId: S(row, "goods_id", "goodsId"),
    sourceUrl: S(row, "link_url", "url"),
    title: S(row, "title"),
    price: money(N(row, "price")),
    originalPrice: money(N(row, "market_price")),
    currency: S(row, "currency") ?? "USD",
    rating: money(N(row, "rating")),
    reviewCount: N(row, "review_count"),
    salesCount: parseCountText(row.sales_num),
    images:
      urlArray(row.images) ??
      (firstHttp(row.image_url, row.thumb_url)
        ? [firstHttp(row.image_url, row.thumb_url)!]
        : null),
    videos: firstHttp(row.video_url) ? [firstHttp(row.video_url)!] : null,
    tags: tagsOf(
      N(row, "reduction_pct") != null ? `降${N(row, "reduction_pct")}%` : null,
      row.adult_goods === true ? "成人商品" : null,
    ),
  }
}

/** autofacts/shopify（试抓 2026-11-19：price.current 可为 number 或 {amount}） */
function mapShopifyProducts(row: Row): PartialNormalized {
  const source = (row.source ?? {}) as Row
  const priceObj = (row.price ?? {}) as Row
  return {
    externalId: S(source, "id") ?? S(row, "id"),
    sourceUrl: S(source, "canonicalUrl", "url"),
    title: S(row, "title"),
    price: money(N(priceObj, "current", "amount")),
    originalPrice: money(N(priceObj, "previous")),
    currency: S(source, "currency"),
    sellerName: S(row, "brand") ?? S(source, "retailer"),
    images: urlArray(row.medias, "url", "src"),
    categoryPath: strArray(row.categories),
    tags: strArray(row.tags) ?? tagsOf(row.fullyOutOfStock === true ? "全线售罄" : null),
  }
}

/** apify/instagram-hashtag-scraper（试抓 2026-11-19） */
function mapInstagram(row: Row): PartialNormalized {
  return {
    externalId: S(row, "id", "shortCode"),
    sourceUrl: S(row, "url"),
    title: null,
    content: S(row, "caption"),
    likesCount: N(row, "likesCount"),
    commentsCount: N(row, "commentsCount"),
    sharesCount: N(row, "sharesCount"),
    viewsCount: N(row, "videoPlayCount", "igPlayCount"),
    sellerName: S(row, "ownerUsername", "ownerFullName"),
    images: urlArray(row.images) ?? (firstHttp(row.displayUrl) ? [firstHttp(row.displayUrl)!] : null),
    videos: firstHttp(row.videoUrl) ? [firstHttp(row.videoUrl)!] : null,
    hashtags: strArray(row.hashtags),
    publishedAt: toDate(row.timestamp),
  }
}

/** clockworks/tiktok-scraper（试抓 2026-11-19） */
function mapTiktok(row: Row): PartialNormalized {
  const author = (row.authorMeta ?? {}) as Row
  const video = (row.videoMeta ?? {}) as Row
  return {
    externalId: S(row, "id"),
    sourceUrl: S(row, "webVideoUrl"),
    title: null,
    content: S(row, "text"),
    likesCount: N(row, "diggCount"),
    commentsCount: N(row, "commentCount"),
    sharesCount: N(row, "shareCount"),
    viewsCount: N(row, "playCount"),
    sellerName: S(author, "nickName", "name"),
    images: firstHttp(video.coverUrl) ? [firstHttp(video.coverUrl)!] : null,
    videos: firstHttp(row.webVideoUrl) ? [firstHttp(row.webVideoUrl)!] : null,
    hashtags: strArray(row.hashtags),
    publishedAt: toDate(row.createTimeISO) ?? toDate(row.createTime),
    tags: tagsOf(row.isAd === true || row.isSponsored === true ? "广告" : null),
  }
}

/**
 * automation-lab/pinterest-scraper（2026-11-21 换；pinUrls 监控重抓共用）。
 * 保留旧 silentflow 字段键（imageUrls.original 等）双兼容，改版防御式取值。
 */
function mapPinterest(row: Row): PartialNormalized {
  const pinner = (row.pinner ?? {}) as Row
  const imageUrls = (row.imageUrls ?? {}) as Row
  const img =
    firstHttp(row.image, row.imageUrl, imageUrls.original) ??
    firstHttp(imageUrls["736x"], imageUrls["474x"]) ??
    (urlArray(row.images, "url", "src") ?? [])[0] ??
    null
  return {
    externalId: S(row, "id", "pinId"),
    sourceUrl: S(row, "link", "url", "trackingLink"),
    title: S(row, "title", "gridTitle"),
    content: S(row, "description"),
    likesCount: N(row, "saves", "reactions", "favoriteCount"),
    commentsCount: N(row, "commentCount", "comments"),
    sellerName: S(pinner, "username", "fullName"),
    images: img ? [img] : null,
    publishedAt: toDate(row.createdAt) ?? toDate(row.publishedAt),
  }
}

/**
 * apify/instagram-scraper posts 模式（监控重抓 2026-11-21 选型，49.5 万用户）。
 * 官方 IG 家族出参与 hashtag-scraper 同宗，键名防御式双兼容。
 */
function mapInstagramPost(row: Row): PartialNormalized {
  const owner = (row.owner ?? {}) as Row
  return {
    externalId: S(row, "id", "shortCode", "shortcode"),
    sourceUrl: S(row, "url") ?? (S(row, "shortCode", "shortcode") ? `https://www.instagram.com/p/${S(row, "shortCode", "shortcode")}/` : null),
    title: null,
    content: S(row, "caption"),
    likesCount: N(row, "likesCount"),
    commentsCount: N(row, "commentsCount"),
    sharesCount: N(row, "sharesCount"),
    viewsCount: N(row, "videoViewCount", "videoPlayCount", "igPlayCount"),
    sellerName: S(owner, "username", "fullName") ?? S(row, "ownerUsername"),
    images: urlArray(row.images) ?? (firstHttp(row.displayUrl) ? [firstHttp(row.displayUrl)!] : null),
    videos: firstHttp(row.videoUrl) ? [firstHttp(row.videoUrl)!] : null,
    hashtags: strArray(row.hashtags),
    publishedAt: toDate(row.timestamp),
  }
}

/**
 * apify/facebook-posts-scraper（监控重抓 2026-11-21 选型，14.5 万用户）。
 * 键名与市场 scraper_one 同宗 + 官方字段（reactions breakdown）双兼容。
 */
function mapFacebookPost(row: Row): PartialNormalized {
  const author = (row.author ?? {}) as Row
  return {
    externalId: S(row, "postId", "id"),
    sourceUrl: S(row, "url", "postUrl"),
    title: null,
    content: S(row, "text", "postText", "caption"),
    likesCount: N(row, "reactionsCount", "reactionsTotalCount", "likesCount"),
    commentsCount: N(row, "commentsCount"),
    sharesCount: N(row, "sharesCount", "shareCount"),
    sellerName: S(author, "name"),
    publishedAt: toDate(row.timestamp) ?? toDate(row.date),
  }
}

/** automation-lab/reddit-scraper（试抓 2026-11-19） */
function mapRedditSearch(row: Row): PartialNormalized {
  const permalink = S(row, "permalink")
  return {
    externalId: S(row, "id"),
    sourceUrl: S(row, "url") ?? (permalink ? `https://www.reddit.com${permalink}` : null),
    title: S(row, "title"),
    content: S(row, "selfText"),
    likesCount: N(row, "score"),
    commentsCount: N(row, "numComments"),
    sellerName: S(row, "author"),
    images: firstHttp(row.thumbnail) && !["self", "default", "spoiler", "nsfw"].includes(String(row.thumbnail)) ? [String(row.thumbnail)] : null,
    category: S(row, "subreddit"),
    publishedAt: toDate(row.createdAt),
  }
}

/** xquik/x-tweet-scraper（试抓 2026-11-19） */
function mapX(row: Row): PartialNormalized {
  const author = (row.author ?? {}) as Row
  return {
    externalId: S(row, "id"),
    sourceUrl: S(row, "url"),
    title: null,
    content: S(row, "text"),
    likesCount: N(row, "likeCount"),
    commentsCount: N(row, "replyCount"),
    sharesCount: N(row, "retweetCount"),
    viewsCount: N(row, "viewCount"),
    sellerName: S(author, "username", "name"),
    publishedAt: toDate(row.createdAt),
    tags: tagsOf(author.isBlueVerified === true ? "蓝标" : null, author.verified === true ? "认证" : null),
  }
}

/** scraper_one/facebook-posts-search（试抓 2026-11-19） */
function mapFacebook(row: Row): PartialNormalized {
  const author = (row.author ?? {}) as Row
  return {
    externalId: S(row, "postId"),
    sourceUrl: S(row, "url"),
    title: null,
    content: S(row, "postText"),
    likesCount: N(row, "reactionsCount"),
    commentsCount: N(row, "commentsCount"),
    sharesCount: N(row, "sharesCount"),
    sellerName: S(author, "name"),
    publishedAt: toDate(row.timestamp),
  }
}

// ── 发现页模式（专用 Actor 映射） ─────────────────────────────

/** curious_coder/amazon-scraper Best Sellers（schema 2026-11-19 拉取） */
function mapAmazonBestsellers(row: Row): PartialNormalized {
  return {
    externalId: S(row, "asin"),
    sourceUrl: S(row, "link", "url"),
    title: S(row, "title"),
    price: money(N(row, "priceAmount", "price")),
    currency: S(row, "priceCurrency") ?? "USD",
    rating: money(N(row, "stars")),
    reviewCount: N(row, "ratingsCount"),
    sellerName: S(row, "seller") != null ? S((row.seller ?? {}) as Row, "name") : S(row, "brand"),
    images: firstHttp(row.image) ? [firstHttp(row.image)!] : null,
    tags: tagsOf(
      Array.isArray(row.bestSellersRank) && row.bestSellersRank.length > 0
        ? `BSR #${S((row.bestSellersRank[0] as Row) ?? {}, "rank") ?? "?"}`
        : null,
    ),
  }
}

/** axlymxp/etsy-trending-products-tracker（schema 2026-11-19 拉取） */
function mapEtsyTrending(row: Row): PartialNormalized {
  return {
    externalId: S(row, "listing_id"),
    sourceUrl: S(row, "url"),
    title: S(row, "title"),
    price: money(N(row, "price")),
    currency: S(row, "currency") ?? "USD",
    reviewCount: N(row, "review_count") ?? parseCountText(row.review_count),
    likesCount: N(row, "favorites"),
    sellerName: S(row, "shop_name"),
    images: null,
    category: S(row, "keyword"),
    tags: tagsOf(
      N(row, "trending_score") != null ? `热度 ${N(row, "trending_score")}` : null,
      N(row, "favorites_per_day") != null ? `日均收藏 ${N(row, "favorites_per_day")}` : null,
      row.is_bestseller === true ? "畅销" : null,
    ),
  }
}

/** afanasenko/pinterest-scraper pinterestTrends 模式（趋势词行，schema 未公开——防御式抽取） */
function mapPinterestTrends(row: Row): PartialNormalized {
  const term = S(row, "keyword", "term", "topic", "trend", "query", "name", "title")
  return {
    externalId: S(row, "id", "pinId"),
    sourceUrl: S(row, "url"),
    title: term,
    content: null,
    category: S(row, "result_type", "type"),
    tags: tagsOf(
      N(row, "rank") != null ? `第 ${N(row, "rank")} 位` : null,
      Array.isArray(row.weekly_interest)
        ? `周度兴趣 ${row.weekly_interest.length} 周`
        : null,
    ),
  }
}

/** clearpath/reddit-subreddit-posts-scraper（schema 2026-11-19 拉取，Reddit 原生 post 对象） */
function mapRedditSubreddit(row: Row): PartialNormalized {
  const preview = (row.preview ?? {}) as Row
  let img: string | null = null
  if (Array.isArray(preview.images) && preview.images.length > 0) {
    const source = ((preview.images[0] as Row)?.source ?? {}) as Row
    img = firstHttp(source.url)
  }
  if (!img) img = firstHttp(row.thumbnail)
  return {
    externalId: S(row, "id"),
    sourceUrl: S(row, "url_overridden_by_dest", "url") ?? (S(row, "permalink") ? `https://www.reddit.com${S(row, "permalink")}` : null),
    title: S(row, "title"),
    content: S(row, "selftext", "selfText"),
    likesCount: N(row, "score", "ups"),
    commentsCount: N(row, "num_comments", "numComments"),
    sellerName: S(row, "author"),
    images: img ? [img] : null,
    category: S(row, "subreddit"),
    publishedAt: toDate(row.created_utc) ?? toDate(row.created) ?? toDate(row.createdAt),
  }
}

/** igolaizola/shopify-store-finder（schema 2026-11-19 拉取，店铺行） */
function mapShopifyStore(row: Row): PartialNormalized {
  const minP = N(row, "minProductCount")
  const maxP = N(row, "maxProductCount")
  return {
    externalId: S(row, "id", "myShopifyUrl"),
    sourceUrl: S(row, "url", "myShopifyUrl"),
    title: S(row, "title", "shop"),
    currency: S(row, "currency"),
    sellerName: S(row, "country"),
    images: firstHttp(row.image) ? [firstHttp(row.image)!] : null,
    tags: tagsOf(
      S(row, "country") ? `地区 ${S(row, "country")}` : null,
      minP != null || maxP != null ? `商品数 ${minP ?? "?"}~${maxP ?? "?"}` : null,
      Array.isArray(row.emails) && row.emails.length > 0 ? `邮箱 ${row.emails.length} 个` : null,
    ),
  }
}

// ── 评论归一化（0106：monitor 评论抓取 → selection_review） ──────

export interface NormalizedReview {
  externalId: string | null
  dedupeKey: string
  authorName: string | null
  /** numeric 列字符串 */
  rating: string | null
  content: string | null
  likesCount: number | null
  verified: boolean | null
  publishedAt: Date | null
  rawData: Record<string, unknown>
}

/**
 * 评论/回复原始行 → selection_review 统一列（各评论 Actor 出参同宗：
 * id/文本/作者/评分/点赞/时间，键名按平台加宽防御式取值；缺失列置 null）。
 */
export function normalizeReviewItem(row: Row): NormalizedReview {
  const author = (row.author ?? {}) as Row
  const authorMeta = (row.authorMeta ?? {}) as Row
  const commenter = (row.commenter ?? row.reviewer ?? {}) as Row
  const externalId = S(
    row,
    "id",
    "commentId",
    "reviewId",
    "review_id",
    "externalId",
  )
  const content = S(
    row,
    "text",
    "content",
    "body",
    "reviewText",
    "comment",
    "commentText",
    "reviewContent",
  )
  const authorName =
    S(row, "authorName", "username", "reviewerName", "ownerUsername", "author", "name", "userName") ??
    S(author, "username", "name", "nickName") ??
    S(authorMeta, "nickName", "name", "username") ??
    S(commenter, "name", "username")
  const likes = N(
    row,
    "likesCount",
    "diggCount",
    "likes",
    "score",
    "helpfulVotes",
    "likeCount",
  )
  const rating = N(row, "rating", "stars", "starRating", "ratingValue")
  const verified =
    row.verified === true ||
    row.verifiedPurchase === true ||
    row.isVerified === true
      ? true
      : null
  const publishedAt =
    toDate(row.publishedAt) ??
    toDate(row.date) ??
    toDate(row.createdAt) ??
    toDate(row.timestamp) ??
    toDate(row.createTimeISO) ??
    toDate(row.createTime) ??
    toDate(row.created_utc)
  return {
    externalId,
    dedupeKey: externalId
      ? `id:${externalId}`
      : `fp:${authorName ?? "?"}|${content?.slice(0, 120) ?? JSON.stringify(row).slice(0, 120)}`,
    authorName,
    rating: rating != null ? rating.toFixed(2) : null,
    content,
    likesCount: likes,
    verified,
    publishedAt,
    rawData: row,
  }
}
