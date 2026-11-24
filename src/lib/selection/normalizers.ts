import type { SelectionPlatform } from "./platforms"
import {
  amazonCurrencyForHost,
  amazonCurrencyForSite,
  amazonCurrencyForSymbol,
  canonicalAmazonUrl,
  isAmazonSite,
} from "./amazon-lists"
import {
  N,
  S,
  arr,
  bestMp4Variant,
  firstHttp,
  hostOf,
  httpList,
  isDirectVideoUrl,
  moneyText,
  obj,
  parseCountText,
  splitPath,
  strArray,
  temuDiscountPct,
  temuPrice,
  toDate,
  unique,
  urlArray,
  type Row,
} from "./raw-utils"

/**
 * Apify 原始行 → selection_result 统一列（server-only）
 *
 * 字段映射依据各 Actor 实际试抓的 dataset 字段清单（见 platforms.ts 文件头备忘）。
 * 全部访问防御式取值：字段缺失/改版时统一列置 null，完整原始行恒存 rawData，
 * 归一化永不抛错。
 */

export { parseCountText }

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
  /** 平台名次（0108）：Amazon 榜单名次 / 主类目 BSR / 搜索位次；其余平台 null */
  rank: number | null
  sellerName: string | null
  images: string[] | null
  /** 可直接播放的媒体直链；平台不给直链时为 null（播放走嵌入，见 extras.resolveVideo） */
  videos: string[] | null
  category: string | null
  categoryPath: string[] | null
  tags: string[] | null
  hashtags: string[] | null
  publishedAt: Date | null
  rawData: Record<string, unknown>
}

/** 数字 → numeric 列字符串（两位小数） */
function money(n: number | null): string | null {
  return n == null ? null : n.toFixed(2)
}

/** 空数组归一为 null（jsonb 列存 null 而非 []，筛选与展示口径一致） */
function listOrNull(list: string[]): string[] | null {
  return list.length > 0 ? list : null
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

/**
 * Actor 错误记录行（junglee 榜单对不支持的类目返回 {error,errorDescription,input,url}）：
 * 不是结果，不入库、不计费。
 */
export function isActorErrorRow(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return true
  const row = item as Row
  return (
    typeof row.error === "string" &&
    row.error !== "" &&
    row.title == null &&
    row.name == null &&
    row.asin == null &&
    row.id == null &&
    row.reviewId == null &&
    row.text == null &&
    row.body == null
  )
}

/**
 * automation-lab/reddit-scraper 把评论作为独立行（type="comment"）与帖子（type="post"）
 * 混排在同一 dataset：评论行只进 selection_review，绝不能当帖子入库。
 */
export function isRedditCommentRow(item: unknown): boolean {
  return !!item && typeof item === "object" && (item as Row).type === "comment"
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
    rank: null,
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
    // 指标重抓（0106）：URL 直抓 actor 出参；reddit/tiktok/x/shopify 与市场映射同构，
    // amazon 走 ASIN 直抓（商品页同族）、temu 走单品详情，IG/FB 为官方帖子 actor
    const monitorMap: Partial<Record<SelectionPlatform, (row: Row) => PartialNormalized>> = {
      amazon: mapAmazonProduct,
      temu: mapTemuDetail,
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
      amazon: mapAmazonBestsellersList,
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
    amazon: mapAmazonProduct,
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

// ── Amazon（junglee 家族，2026-11-24 实测） ──────────────────────

/** 三字母才当 ISO 币种码（junglee 的 price.currency 常给符号 "$"/"£"/"€"） */
function isoCode(v: string | null): string | null {
  return v && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : null
}

/** 币种：ISO 码 > 商品链接域名 > 站点码（loadedCountryCode）> 符号映射 > USD */
function amazonCurrencyOf(row: Row, rawUrl: string | null): string {
  const fromPrice = isoCode(S(obj(row.price), "currency")) ?? isoCode(S(row, "priceCurrency"))
  if (fromPrice) return fromPrice
  const fromHost = amazonCurrencyForHost(hostOf(rawUrl))
  if (fromHost) return fromHost
  const loaded = S(row, "loadedCountryCode")
  if (loaded && isAmazonSite(loaded)) return amazonCurrencyForSite(loaded)
  return (
    amazonCurrencyForSymbol(S(obj(row.price), "currency") ?? S(row, "priceCurrency") ?? "") ??
    "USD"
  )
}

/**
 * junglee 商品页家族（Amazon-crawler 关键词搜索 / amazon-asins-scraper 监控重抓，
 * 2026-11-24 实测），兼容旧 curious_coder 行（priceAmount/ratingsCount/bestSellersRank）。
 * rank 口径：榜单名次（bestsellerPageData.position）> 主类目 BSR > 搜索位次。
 */
function mapAmazonProduct(row: Row): PartialNormalized {
  const price = N(obj(row.price), "value") ?? N(row, "priceAmount")
  const listPrice = N(obj(row.listPrice), "value") ?? N(row, "listPriceAmount")
  const ranks = arr(row.bestsellerRanks).length > 0 ? arr(row.bestsellerRanks) : arr(row.bestSellersRank)
  const listPage = obj(row.bestsellerPageData)
  const searchPage = obj(row.categoryPageData)
  const asin = S(row, "asin")
  const rawUrl = S(row, "url", "link", "unNormalizedProductUrl")
  const brand = S(row, "brand")
  return {
    externalId: asin,
    sourceUrl: canonicalAmazonUrl({ asin, url: rawUrl }),
    title: S(row, "title", "name"),
    price: money(price),
    originalPrice: listPrice != null && price != null && listPrice > price ? money(listPrice) : null,
    currency: amazonCurrencyOf(row, rawUrl),
    rating: money(N(row, "stars")),
    reviewCount: N(row, "reviewsCount", "ratingsCount"),
    // "3K+ bought in past month"（旧 santamaria 行为 purchaseVolumeText）
    salesCount: parseCountText(row.monthlyPurchaseVolume) ?? parseCountText(row.purchaseVolumeText),
    rank:
      N(listPage, "position") ??
      (ranks.length > 0 ? N(ranks[0]!, "rank") : null) ??
      N(searchPage, "productPosition") ??
      N(row, "positionOverall"),
    sellerName: brand ?? S(obj(row.seller), "name"),
    images: listOrNull(unique([
      firstHttp(row.thumbnailImage, row.imageUrl, row.image, row.imageLarge),
      ...httpList(row.highResolutionImages),
    ])),
    category:
      S(listPage, "categoryName") ??
      (ranks.length > 0 ? S(ranks[0]!, "category") : null) ??
      S(row, "categoryName", "bestSellerCategory"),
    categoryPath: splitPath(S(row, "breadCrumbs")),
    tags: tagsOf(
      row.isAmazonChoice === true ? "Amazon's Choice" : null,
      row.isBestSeller === true || searchPage.bestsellerBadge != null ? "Best Seller" : null,
      row.isSponsored === true || searchPage.isSponsored === true ? "广告" : null,
      row.inStock === false ? "缺货" : null,
    ),
  }
}

/**
 * junglee/amazon-bestsellers 榜单行：带详情模式（detailedInformation）整行即商品页
 * 家族出参，走完整映射；纯榜单行只有 name/url/asin/position/price/stars/reviewsCount/
 * thumbnailUrl/categoryName，position 即榜单名次。
 */
function mapAmazonBestsellersList(row: Row): PartialNormalized {
  if (
    row.title != null &&
    (row.bestsellerRanks != null || row.monthlyPurchaseVolume != null || row.features != null)
  ) {
    return mapAmazonProduct(row)
  }
  const page = obj(row.bestsellerPageData)
  const asin = S(row, "asin")
  const rawUrl = S(row, "url")
  return {
    externalId: asin,
    sourceUrl: canonicalAmazonUrl({ asin, url: rawUrl }),
    title: S(row, "name", "title"),
    price: money(N(obj(row.price), "value")),
    currency: amazonCurrencyOf(row, rawUrl),
    rating: money(N(row, "stars")),
    reviewCount: N(row, "reviewsCount"),
    rank: N(row, "position") ?? N(page, "position"),
    images: listOrNull(unique([...httpList([row.thumbnailUrl]), firstHttp(row.thumbnailImage)])),
    category: S(row, "categoryName") ?? S(page, "categoryName"),
  }
}

// ── 市场分析模式 ──────────────────────────────────────────────

/** devcake/etsy-search-scraper（试抓 2026-11-19） */
function mapEtsySearch(row: Row): PartialNormalized {
  const price = N(row, "price_num", "price_int", "price")
  // discount_price 是带货币符号的字符串（"$53.99"），N() 解析不了，需走金额文本解析
  const discount = N(row, "discount_price") ?? moneyText(row.discount_price)
  const videos = httpList(row.videos)
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
    videos: videos.length > 0 ? videos : null,
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
 * 输出字段：goods_id/price（分）/price_str（"$3.09"）/market_price（分）/
 * market_price_str/rating/review_count/sales_num（"10K+" 文本）/reduction_pct
 * （非折扣率，见 temuDiscountPct）/image_url/thumb_url/link_url/currency/video_url
 */
function mapTemuCRW(row: Row): PartialNormalized {
  const price = temuPrice(row, "price_str", "price")
  const marketPrice = temuPrice(row, "market_price_str", "market_price")
  const discountPct = temuDiscountPct(row)
  return {
    externalId: S(row, "goods_id", "goodsId"),
    sourceUrl: S(row, "link_url", "url"),
    title: S(row, "title"),
    price: money(price),
    originalPrice: marketPrice != null && price != null && marketPrice > price ? money(marketPrice) : null,
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
      discountPct != null ? `降${discountPct}%` : null,
      row.adult_goods === true ? "成人商品" : null,
    ),
  }
}

/**
 * hypebridge/temu-scraper 单品详情（2026-11-24 监控重抓）：goodsId/title/price/
 * rating/reviewCount/inStock/imageUrl/galleryImages/videoUrl/skus/specifications。
 * 出参无销量与市场价（监控页注明）。
 */
function mapTemuDetail(row: Row): PartialNormalized {
  const goodsId = S(row, "goodsId", "goods_id")
  const gallery = httpList(row.galleryImages)
  const cover = firstHttp(row.imageUrl)
  const video = firstHttp(row.videoUrl)
  return {
    externalId: goodsId,
    sourceUrl:
      S(row, "productUrl", "sourceUrl") ??
      (goodsId ? `https://www.temu.com/goods.html?goods_id=${goodsId}` : null),
    title: S(row, "title"),
    price: money(N(row, "price")),
    currency: S(row, "currency") ?? "USD",
    rating: money(N(row, "rating")),
    reviewCount: N(row, "reviewCount"),
    images: gallery.length > 0 ? gallery : cover ? [cover] : null,
    videos: video ? [video] : null,
    categoryPath: splitPath(S(row, "categoryPath")),
    tags: tagsOf(
      row.inStock === false ? "缺货" : null,
      row.hasVideo === true ? "有视频" : null,
    ),
  }
}

/** autofacts/shopify（试抓 2026-11-19：price.current 可为 number 或 {amount}） */
function mapShopifyProducts(row: Row): PartialNormalized {
  const source = obj(row.source)
  const priceObj = obj(row.price)
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

/**
 * clockworks/tiktok-scraper（试抓 2026-11-19）。actor 不提供视频直链：videos 置 null
 * （此前存的 webVideoUrl 是网页地址，被当图片地址用会裂图），播放走官方嵌入；
 * 图文帖（slideshowImageLinks）取多图，视频帖只有封面。
 */
function mapTiktok(row: Row): PartialNormalized {
  const author = obj(row.authorMeta)
  const video = obj(row.videoMeta)
  const cover = firstHttp(video.coverUrl, video.originalCoverUrl)
  return {
    externalId: S(row, "id"),
    sourceUrl: S(row, "webVideoUrl", "url"),
    title: null,
    content: S(row, "text"),
    likesCount: N(row, "diggCount"),
    commentsCount: N(row, "commentCount"),
    sharesCount: N(row, "shareCount"),
    viewsCount: N(row, "playCount"),
    sellerName: S(author, "nickName", "name"),
    images: urlArray(row.slideshowImageLinks, "downloadLink") ?? (cover ? [cover] : null),
    videos: null,
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
  const pinner = obj(row.pinner)
  const imageUrls = obj(row.imageUrls)
  const img =
    firstHttp(row.image, row.imageUrl, imageUrls.original) ??
    firstHttp(imageUrls["736x"], imageUrls["474x"], row.thumbnailUrl) ??
    (urlArray(row.images, "url", "src") ?? [])[0] ??
    null
  return {
    externalId: S(row, "id", "pinId"),
    // link 是外跳商家链接（无外跳时 null），只有 url 才是 Pin 自身
    sourceUrl: pinUrl(row),
    title: S(row, "title", "gridTitle"),
    content: S(row, "description"),
    likesCount: N(row, "saves", "reactions", "favoriteCount"),
    commentsCount: N(row, "commentCount", "comments"),
    sellerName: S(pinner, "username", "fullName") ?? S(row, "pinnerUsername", "pinnerName"),
    images: img ? [img] : null,
    videos: firstHttp(row.videoUrl) ? [firstHttp(row.videoUrl)!] : null,
    hashtags: strArray(row.hashtags),
    publishedAt: toDate(row.createdAt) ?? toDate(row.publishedAt),
  }
}

/** Pin 自身链接：url（须为 /pin/ 链接）> trackingLink > 按 id 重建 */
function pinUrl(row: Row): string | null {
  const direct = S(row, "url")
  if (direct && /pinterest\.[a-z.]+\/pin\//i.test(direct)) return direct
  const track = S(row, "trackingLink")
  if (track && /pinterest\.[a-z.]+\/pin\//i.test(track)) return track
  const id = S(row, "id", "pinId")
  return id ? `https://www.pinterest.com/pin/${id}/` : null
}

/**
 * apify/instagram-scraper posts 模式（监控重抓 2026-11-21 选型，49.5 万用户）。
 * 官方 IG 家族出参与 hashtag-scraper 同宗，键名防御式双兼容。
 */
function mapInstagramPost(row: Row): PartialNormalized {
  const owner = obj(row.owner)
  const shortCode = S(row, "shortCode", "shortcode")
  return {
    externalId: S(row, "id", "shortCode", "shortcode"),
    sourceUrl: S(row, "url") ?? (shortCode ? `https://www.instagram.com/p/${shortCode}/` : null),
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
  const author = obj(row.author)
  return {
    externalId: S(row, "postId", "id"),
    sourceUrl: S(row, "url", "postUrl"),
    title: null,
    content: S(row, "text", "postText", "caption"),
    likesCount: N(row, "reactionsCount", "reactionsTotalCount", "likesCount"),
    commentsCount: N(row, "commentsCount"),
    sharesCount: N(row, "sharesCount", "shareCount"),
    sellerName: S(author, "name"),
    ...fbMedia(row),
    publishedAt: toDate(row.timestamp) ?? toDate(row.date),
  }
}

/** Facebook 附件：photo 与图片地址进 images，video 与视频直链进 videos */
function fbMedia(row: Row): { images: string[] | null; videos: string[] | null } {
  const atts = arr(row.attachments)
  const images = unique(
    atts
      .filter((a) => {
        const u = S(a, "url") ?? ""
        return S(a, "type") === "photo" || (S(a, "type") == null && !isDirectVideoUrl(u))
      })
      .map((a) => firstHttp(S(a, "url"))),
  )
  const videos = unique(
    atts
      .filter((a) => {
        const u = S(a, "url") ?? ""
        return S(a, "type") === "video" || isDirectVideoUrl(u)
      })
      .map((a) => firstHttp(S(a, "url"))),
  )
  return { images: listOrNull(images), videos: listOrNull(videos) }
}

/**
 * automation-lab/reddit-scraper（试抓 2026-11-19，2026-11-24 实测复核）。
 * url/link 对链接帖是外跳地址，permalink 才是帖子自身；评论是独立行不入这里。
 */
function mapRedditSearch(row: Row): PartialNormalized {
  return {
    externalId: S(row, "id"),
    sourceUrl: redditPostUrl(row),
    title: S(row, "title"),
    content: S(row, "selfText"),
    likesCount: N(row, "score"),
    commentsCount: N(row, "numComments", "num_comments"),
    sellerName: S(row, "author"),
    images: redditImages(row),
    category: S(row, "subreddit"),
    hashtags: strArray(row.hashtags),
    publishedAt: toDate(row.createdAt) ?? toDate(row.created_utc) ?? toDate(row.created),
    tags: tagsOf(
      S(row, "linkFlairText"),
      row.isVideo === true ? "视频" : null,
      row.isNSFW === true ? "NSFW" : null,
      row.isSpoiler === true ? "剧透" : null,
      row.isStickied === true ? "置顶" : null,
    ),
  }
}

/** Reddit 帖子自身链接：permalink（相对路径补全）> 仅当 url/link 是 reddit 域时才用 */
function redditPostUrl(row: Row): string | null {
  const permalink = S(row, "permalink")
  if (permalink) {
    if (/^https?:\/\//i.test(permalink)) return permalink
    if (permalink.startsWith("/")) return `https://www.reddit.com${permalink}`
  }
  for (const k of ["url", "link"]) {
    const u = S(row, k)
    if (u && /(^|\.)reddit\.com$/i.test(hostOf(u))) return u
  }
  return null
}

/** Reddit 帖子配图：imageUrls（automation-lab）> preview 高清图 > 缩略图（self/default 等占位值跳过） */
function redditImages(row: Row): string[] | null {
  const fromList = httpList(row.imageUrls)
  if (fromList.length > 0) return fromList
  const first = arr(obj(row.preview).images)[0]
  const source = firstHttp(S(obj(obj(first).source), "url"))
  if (source) return [source]
  const thumb = S(row, "thumbnail")
  return thumb && /^https?:\/\//i.test(thumb) ? [thumb] : null
}

/** xquik/x-tweet-scraper（试抓 2026-11-19；2026-11-24 补 media 图/视频与长推文正文） */
function mapX(row: Row): PartialNormalized {
  const author = obj(row.author)
  const media = arr(row.media)
  const photos = unique(
    media
      .filter((m) => S(m, "type") === "photo")
      .map((m) => firstHttp(S(m, "mediaUrl"), S(m, "displayUrl"))),
  )
  const videoMedia = media.find((m) => {
    const t = S(m, "type")
    return t === "video" || t === "animated_gif"
  })
  const video = videoMedia ? bestMp4Variant(videoMedia.videoVariants) : null
  return {
    externalId: S(row, "id"),
    sourceUrl: S(row, "url"),
    title: null,
    // 长推文正文在 noteTweet.text（text 被截断）
    content: S(obj(row.noteTweet), "text") ?? S(row, "text"),
    likesCount: N(row, "likeCount"),
    commentsCount: N(row, "replyCount"),
    sharesCount: N(row, "retweetCount"),
    viewsCount: N(row, "viewCount"),
    sellerName: S(author, "username", "name"),
    images: listOrNull(photos),
    videos: video ? [video] : null,
    hashtags: xHashtags(row),
    publishedAt: toDate(row.createdAt),
    tags: tagsOf(author.isBlueVerified === true ? "蓝标" : null, author.verified === true ? "认证" : null),
  }
}

/** 话题：entities.hashtags[].text 优先，缺则从正文抽 #话题 */
function xHashtags(row: Row): string[] | null {
  const fromEntities = arr(obj(row.entities).hashtags)
    .map((h) => S(h, "text"))
    .filter((t): t is string => t != null)
  if (fromEntities.length > 0) return fromEntities
  const text = S(obj(row.noteTweet), "text") ?? S(row, "text")
  if (!text) return null
  const tags = [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!)
  return tags.length > 0 ? [...new Set(tags)].slice(0, 10) : null
}

/** scraper_one/facebook-posts-search（试抓 2026-11-19；2026-11-24 补附件图/视频） */
function mapFacebook(row: Row): PartialNormalized {
  const author = obj(row.author)
  return {
    externalId: S(row, "postId"),
    sourceUrl: S(row, "url"),
    title: null,
    content: S(row, "postText"),
    likesCount: N(row, "reactionsCount"),
    commentsCount: N(row, "commentsCount"),
    sharesCount: N(row, "sharesCount"),
    sellerName: S(author, "name"),
    ...fbMedia(row),
    publishedAt: toDate(row.timestamp),
  }
}

// ── 发现页模式（专用 Actor 映射） ─────────────────────────────

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
  return {
    externalId: S(row, "id"),
    sourceUrl: redditPostUrl({ ...row, url: S(row, "url") }),
    title: S(row, "title"),
    content: S(row, "selftext", "selfText"),
    likesCount: N(row, "score", "ups"),
    commentsCount: N(row, "num_comments", "numComments"),
    sellerName: S(row, "author"),
    images: redditImages({ ...row, thumbnail: S(row, "thumbnail") }),
    category: S(row, "subreddit"),
    publishedAt: toDate(row.created_utc) ?? toDate(row.created) ?? toDate(row.createdAt),
    tags: tagsOf(S(row, "link_flair_text"), row.over_18 === true ? "NSFW" : null, row.stickied === true ? "置顶" : null),
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
 * 评论/回复原始行 → selection_review 统一列（各评论 Actor 出参同宗：id/文本/作者/
 * 评分/点赞/时间，键名按平台加宽防御式取值；缺失列置 null）。
 * junglee/amazon-reviews-scraper 真实键名（2026-11-24 实测）：reviewId / reviewDescription /
 * ratingScore / date；默认不含用户名（GDPR），标题/图片/Vine 标记在 rawData（extras 读取）。
 */
export function normalizeReviewItem(row: Row): NormalizedReview {
  const author = obj(row.author)
  const authorMeta = obj(row.authorMeta)
  const commenter = row.commenter && typeof row.commenter === "object"
    ? obj(row.commenter)
    : obj(row.reviewer)
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
    "reviewDescription",
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
    // junglee/amazon-reviews-scraper 的「有用票数」（字符串数字）
    "reviewReaction",
  )
  const rating = N(row, "rating", "stars", "starRating", "ratingValue", "ratingScore")
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
    toDate(row.created_utc) ??
    // Etsy 评论 actor（reviewDateIso = "2026-11-15" / reviewDate = "Nov 15, 2026"）
    toDate(row.reviewDateIso) ??
    toDate(row.reviewDate)
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
