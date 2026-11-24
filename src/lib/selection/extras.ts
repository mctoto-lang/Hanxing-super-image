import {
  N,
  S,
  arr,
  bestMp4Variant,
  firstHttp,
  httpList,
  isDirectVideoUrl,
  obj,
  parseCountText,
  strArray,
  temuDiscountPct,
  urlArray,
  type Row,
} from "./raw-utils"

/**
 * 平台专属字段投影（client-safe 纯函数）
 *
 * 各平台 Actor 带回、但没有统一列的专属数据（Amazon BSR / 五点 / 规格 / 官方 AI
 * 评论摘要，社媒作者粉丝 / 音乐 / 媒体宫格等）恒存在 raw_data。本模块在服务端把
 * raw_data 投影成各平台强类型 extras 随列表下发——列表不再携带整份 rawData，
 * 新旧 Actor 出参形状都做防御式兼容，存量行无需重抓即可展示。
 */

/** 投影时可参考的少量统一列（作为缺字段时的回退值） */
export interface ExtrasBase {
  images?: string[] | null
  videos?: string[] | null
  salesCount?: number | null
  sellerName?: string | null
  sourceUrl?: string | null
}

function nonNull<T>(v: T | null | undefined): v is T {
  return v != null
}

// ── Amazon ──────────────────────────────────────────────────────

/** Amazon 官方 AI 评论摘要里的主题词（"Customers say"） */
export interface AmazonReviewKeyword {
  name: string
  sentiment: string
  positive: number | null
  negative: number | null
  total: number | null
}

export interface AmazonExtras {
  asin: string | null
  brand: string | null
  /** 卖家（Sold by） */
  seller: string | null
  bsrRank: number | null
  bsrCategory: string | null
  bsrRanks: Array<{ rank: number; category: string }>
  /** 关键词搜索结果里的位次 */
  searchPosition: number | null
  /** 榜单名次 */
  listPosition: number | null
  listCategory: string | null
  /** "3K+ bought in past month" */
  monthlyPurchases: string | null
  features: string[]
  attributes: Array<[string, string]>
  variants: Array<{ asin: string; name: string; price: number | null }>
  variantCount: number | null
  /** 5 星 → 1 星的占比（%）；无数据为空数组 */
  ratingBreakdown: number[]
  aiReviewSummary: { text: string; keywords: AmazonReviewKeyword[] } | null
  delivery: string | null
  fastestDelivery: string | null
  inStock: boolean | null
  isChoice: boolean
  isBestSeller: boolean
  isSponsored: boolean
  isPrime: boolean
  videosCount: number | null
  couponText: string | null
}

/** 规格属性里与其它区块重复的噪音键 */
const AMAZON_NOISY_ATTR = new Set(["Best Sellers Rank", "Customer Reviews", "ASIN"])

function amazonExtras(raw: Row, base: ExtrasBase): AmazonExtras {
  const ranks = arr(raw.bestsellerRanks).length > 0 ? arr(raw.bestsellerRanks) : arr(raw.bestSellersRank)
  const listPage = obj(raw.bestsellerPageData)
  const searchPage = obj(raw.categoryPageData)
  const bsrRanks = ranks
    .map((r) => ({ rank: N(r, "rank"), category: S(r, "category") }))
    .filter((r): r is { rank: number; category: string } => r.rank != null && r.category != null)
  const breakdown = obj(raw.starsBreakdown)
  // 实测为 0~1 小数；个别行给整数百分比时按原值取整
  const pct = (k: string) => {
    const v = N(breakdown, k)
    return v == null ? null : v <= 1 ? Math.round(v * 100) : Math.round(v)
  }
  const ratingBreakdown = ["5star", "4star", "3star", "2star", "1star"].map(pct)
  const summary = obj(raw.aiReviewsSummary)
  const summaryText = S(summary, "text")
  const attributes = arr(raw.attributes)
    .map((a) => [S(a, "key"), S(a, "value")] as const)
    .filter((p): p is readonly [string, string] => p[0] != null && p[1] != null)
    .filter(([k]) => !AMAZON_NOISY_ATTR.has(k))
    .slice(0, 40)
  const variants = arr(raw.variantDetails)
    .map((v) => ({ asin: S(v, "asin"), name: S(v, "name"), price: N(obj(v.price), "value") }))
    .filter((v): v is { asin: string; name: string; price: number | null } => v.asin != null && v.name != null)
  return {
    asin: S(raw, "asin"),
    brand: S(raw, "brand") ?? base.sellerName ?? null,
    seller: S(obj(raw.seller), "name"),
    bsrRank: bsrRanks[0]?.rank ?? null,
    bsrCategory: bsrRanks[0]?.category ?? null,
    bsrRanks: bsrRanks.slice(0, 5),
    searchPosition: N(searchPage, "productPosition") ?? N(raw, "positionOverall"),
    listPosition: N(listPage, "position"),
    listCategory: S(listPage, "categoryFullName", "categoryName"),
    monthlyPurchases: S(raw, "monthlyPurchaseVolume", "purchaseVolumeText"),
    features: strArray(raw.features) ?? [],
    attributes: attributes.map(([k, v]) => [k, v] as [string, string]),
    variants: variants.slice(0, 30),
    variantCount: variants.length > 0 ? variants.length : (strArray(raw.variantAsins)?.length ?? null),
    ratingBreakdown: ratingBreakdown.every((v) => v == null) ? [] : ratingBreakdown.map((v) => v ?? 0),
    aiReviewSummary: summaryText
      ? {
          text: summaryText,
          keywords: arr(summary.keywords)
            .map(
              (k): AmazonReviewKeyword => ({
                name: S(k, "name") ?? "",
                sentiment: S(k, "sentiment") ?? "neutral",
                positive: N(obj(k.customersMentionedCount), "positive"),
                negative: N(obj(k.customersMentionedCount), "negative"),
                total: N(obj(k.customersMentionedCount), "total"),
              }),
            )
            .filter((k) => k.name !== "")
            .slice(0, 8),
        }
      : null,
    delivery: S(raw, "delivery", "deliveryText"),
    fastestDelivery: S(raw, "fastestDelivery", "fastDeliveryText"),
    inStock: typeof raw.inStock === "boolean" ? raw.inStock : null,
    isChoice: raw.isAmazonChoice === true,
    isBestSeller: raw.isBestSeller === true || searchPage.bestsellerBadge != null,
    isSponsored: raw.isSponsored === true || searchPage.isSponsored === true,
    isPrime: raw.isPrime === true,
    videosCount: N(raw, "videosCount"),
    couponText: S(raw, "couponText"),
  }
}

// ── TEMU ────────────────────────────────────────────────────────

export interface TemuExtras {
  goodsId: string | null
  mallLink: string | null
  salesTip: string | null
  discountPct: number | null
  videoUrl: string | null
  /** 单品详情 actor（监控重抓）才有 */
  inStock: boolean | null
  specifications: Array<[string, string]>
  skuCount: number | null
  returnPolicy: { freeReturns: boolean | null; returnWindowDays: number | null } | null
}

function temuExtras(raw: Row, base: ExtrasBase): TemuExtras {
  const specs = obj(raw.specifications)
  const policy = obj(raw.returnPolicy)
  const freeReturns = typeof policy.freeReturns === "boolean" ? policy.freeReturns : null
  const returnWindowDays = N(policy, "returnWindowDays")
  return {
    goodsId: S(raw, "goods_id", "goodsId"),
    mallLink: firstHttp(raw.mall_link),
    salesTip: S(raw, "sales_tip"),
    // reduction_pct 不是折扣率（实测与真实降幅不符），按价格推算（同 mapTemuCRW）
    discountPct: temuDiscountPct(raw),
    videoUrl: firstHttp(raw.video_url, raw.videoUrl) ?? base.videos?.[0] ?? null,
    inStock: typeof raw.inStock === "boolean" ? raw.inStock : null,
    specifications: Object.entries(specs)
      .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
      .slice(0, 40),
    skuCount: arr(raw.skus).length > 0 ? arr(raw.skus).length : null,
    returnPolicy:
      freeReturns != null || returnWindowDays != null ? { freeReturns, returnWindowDays } : null,
  }
}

// ── Etsy / Shopify ──────────────────────────────────────────────

export interface EtsyExtras {
  shopName: string | null
  shopUrl: string | null
  favorites: number | null
  trendingScore: number | null
  favoritesPerDay: number | null
  taxonomy: string[]
  tags: string[]
  materials: string[]
  whenMade: string | null
  shipsFromCountry: string | null
  shopRating: number | null
  /** 商品视频直链（v.etsystatic.com，不带签名） */
  videoUrl: string | null
}

function etsyExtras(raw: Row, base: ExtrasBase): EtsyExtras {
  return {
    shopName: S(raw, "shop_name") ?? base.sellerName ?? null,
    shopUrl: firstHttp(raw.shop_url),
    favorites: N(raw, "favorites") ?? parseCountText(raw.favorites),
    trendingScore: N(raw, "trending_score"),
    favoritesPerDay: N(raw, "favorites_per_day"),
    taxonomy: strArray(raw.taxonomy_path) ?? [],
    tags: (strArray(raw.tags) ?? []).slice(0, 15),
    materials: strArray(raw.materials) ?? [],
    whenMade: S(raw, "when_made"),
    shipsFromCountry: S(raw, "ships_from_country"),
    shopRating: N(raw, "shop_rating"),
    videoUrl: httpList(raw.videos)[0] ?? base.videos?.[0] ?? null,
  }
}

export interface ShopifyExtras {
  retailer: string | null
  brand: string | null
  categories: string[]
  tags: string[]
  fullyOutOfStock: boolean | null
}

function shopifyExtras(raw: Row, base: ExtrasBase): ShopifyExtras {
  return {
    retailer: S(obj(raw.source), "retailer"),
    brand: S(raw, "brand") ?? base.sellerName ?? null,
    categories: strArray(raw.categories) ?? [],
    tags: (strArray(raw.tags) ?? []).slice(0, 12),
    fullyOutOfStock: raw.fullyOutOfStock === true ? true : null,
  }
}

// ── 社媒 ────────────────────────────────────────────────────────

export interface TiktokExtras {
  durationSec: number | null
  collectCount: number | null
  repostCount: number | null
  music: { author: string | null; name: string } | null
  author: {
    username: string
    nickname: string | null
    avatar: string | null
    followers: number | null
    verified: boolean
  } | null
  isSlideshow: boolean
  slideshowImages: string[]
  hasShopProduct: boolean
  isAd: boolean
  isPinned: boolean
  isStory: boolean
  language: string | null
  location: string | null
  width: number | null
  height: number | null
  definition: string | null
}

function tiktokExtras(raw: Row): TiktokExtras {
  const author = obj(raw.authorMeta)
  const video = obj(raw.videoMeta)
  const music = obj(raw.musicMeta)
  const location = obj(raw.locationMeta)
  const username = S(author, "name")
  const musicName = S(music, "musicName")
  return {
    durationSec: N(video, "duration"),
    collectCount: N(raw, "collectCount"),
    repostCount: N(raw, "repostCount"),
    music: musicName ? { author: S(music, "musicAuthor"), name: musicName } : null,
    author: username
      ? {
          username,
          nickname: S(author, "nickName"),
          avatar: firstHttp(author.avatar),
          followers: N(author, "fans"),
          verified: author.verified === true,
        }
      : null,
    isSlideshow: raw.isSlideshow === true,
    slideshowImages: urlArray(raw.slideshowImageLinks, "downloadLink") ?? [],
    hasShopProduct: raw.hasTikTokShopProduct === true,
    isAd: raw.isAd === true || raw.isSponsored === true,
    isPinned: raw.isPinned === true,
    isStory: raw.isStory === true,
    language: S(raw, "textLanguage"),
    location: S(location, "locationName", "city", "address"),
    width: N(video, "width"),
    height: N(video, "height"),
    definition: S(video, "definition"),
  }
}

export interface InstagramExtras {
  type: string | null
  isReel: boolean
  durationSec: number | null
  alt: string | null
  location: string | null
  videoUrl: string | null
  music: { artist: string | null; name: string } | null
  paidPartnership: boolean
  isPinned: boolean
  coauthors: string[]
  author: { username: string; fullName: string | null } | null
}

function instagramExtras(raw: Row, base: ExtrasBase): InstagramExtras {
  const owner = obj(raw.owner)
  const music = obj(raw.musicInfo)
  const songName = S(music, "song_name")
  const username = S(raw, "ownerUsername") ?? S(owner, "username")
  return {
    type: S(raw, "type"),
    // Reels 的 productType 实测是 "clips"（普通图帖 "feed"）；兼容历史 "reels" 写法
    isReel:
      ["clips", "reels", "reel"].includes(S(raw, "productType") ?? "") ||
      /\/(reel|reels)\//i.test(base.sourceUrl ?? ""),
    durationSec: N(raw, "videoDuration"),
    alt: S(raw, "alt"),
    location: S(raw, "locationName"),
    videoUrl: firstHttp(raw.videoUrl) ?? base.videos?.[0] ?? null,
    music: songName ? { artist: S(music, "artist_name"), name: songName } : null,
    paidPartnership: raw.paidPartnership === true,
    isPinned: raw.isPinned === true,
    coauthors: arr(raw.coauthorProducers)
      .map((c) => S(c, "username"))
      .filter(nonNull),
    author: username ? { username, fullName: S(raw, "ownerFullName") ?? S(owner, "full_name") } : null,
  }
}

export interface PinterestExtras {
  boardName: string | null
  boardUrl: string | null
  pinnerFollowers: number | null
  pinnerName: string | null
  domain: string | null
  altText: string | null
  hashtags: string[]
  isVideo: boolean
  videoUrl: string | null
  durationSec: number | null
  videoThumb: string | null
  /** Pin 指向的外部商家链接 */
  outboundLink: string | null
}

function pinterestExtras(raw: Row, base: ExtrasBase): PinterestExtras {
  const pinner = obj(raw.pinner)
  const videoUrl = firstHttp(raw.videoUrl) ?? base.videos?.[0] ?? null
  return {
    boardName: S(raw, "boardName"),
    boardUrl: firstHttp(raw.boardUrl),
    pinnerFollowers: N(raw, "pinnerFollowers") ?? N(pinner, "followerCount"),
    pinnerName: S(raw, "pinnerName") ?? S(pinner, "fullName"),
    domain: S(raw, "domain"),
    altText: S(raw, "altText"),
    hashtags: strArray(raw.hashtags) ?? [],
    isVideo: raw.isVideo === true || videoUrl != null,
    videoUrl,
    durationSec: N(raw, "videoDurationSec"),
    videoThumb: firstHttp(raw.videoThumbnailUrl),
    outboundLink: firstHttp(raw.link),
  }
}

export interface RedditExtras {
  subreddit: string | null
  flair: string | null
  upvoteRatio: number | null
  awards: number | null
  isVideo: boolean
  isSelf: boolean
  isNsfw: boolean
  isSpoiler: boolean
  isStickied: boolean
  domain: string | null
  /** 链接帖指向的外部地址（视频帖可能是 YouTube / v.redd.it） */
  outboundUrl: string | null
  imageUrls: string[]
  subscribers: number | null
}

function redditExtras(raw: Row): RedditExtras {
  const outbound = [S(raw, "url"), S(raw, "link")].find(
    (u): u is string => u != null && /^https?:\/\//i.test(u) && !/(^|\.)reddit\.com\//i.test(u),
  )
  return {
    subreddit: S(raw, "subreddit"),
    flair: S(raw, "linkFlairText", "link_flair_text"),
    upvoteRatio: N(raw, "upvoteRatio"),
    awards: N(raw, "totalAwards"),
    isVideo: raw.isVideo === true || raw.is_video === true,
    isSelf: raw.isSelf === true || raw.is_self === true,
    isNsfw: raw.isNSFW === true || raw.over_18 === true,
    isSpoiler: raw.isSpoiler === true || raw.spoiler === true,
    isStickied: raw.isStickied === true || raw.stickied === true,
    domain: S(raw, "domain"),
    outboundUrl: outbound ?? null,
    imageUrls: httpList(raw.imageUrls).slice(0, 12),
    subscribers: N(raw, "subredditSubscribers"),
  }
}

export interface XMedia {
  type: "photo" | "video" | "gif"
  url: string
  thumb: string | null
  durationSec: number | null
}

export interface XExtras {
  author: {
    username: string
    name: string | null
    avatar: string | null
    followers: number | null
    verified: boolean
  } | null
  media: XMedia[]
  quoteCount: number | null
  bookmarkCount: number | null
  isReply: boolean
  isQuote: boolean
  isRetweet: boolean
  lang: string | null
  hashtags: string[]
  place: string | null
}

function xExtras(raw: Row): XExtras {
  const author = obj(raw.author)
  const username = S(author, "username")
  const media = arr(raw.media)
    .map((m) => {
      const t = S(m, "type")
      const type = t === "photo" ? "photo" : t === "video" ? "video" : t === "animated_gif" ? "gif" : null
      const millis = N(m, "durationMillis")
      const thumb = firstHttp(S(m, "mediaUrl"))
      return {
        type,
        // 视频的 mediaUrl 是缩略图 JPG，直链在 videoVariants（取不到 mp4 则整条剔除，
        // 避免把 JPG 当视频播放）；图片的 mediaUrl 即自身
        url: type != null && type !== "photo" ? bestMp4Variant(m.videoVariants) : thumb,
        thumb,
        durationSec: millis != null ? Math.round(millis / 1000) : null,
      }
    })
    .filter((m): m is XMedia => m.type != null && m.url != null)
  const entityTags = arr(obj(raw.entities).hashtags)
    .map((h) => S(h, "text"))
    .filter(nonNull)
  return {
    author: username
      ? {
          username,
          name: S(author, "name"),
          avatar: firstHttp(author.profilePicture),
          followers: N(author, "followers"),
          verified: author.isBlueVerified === true || author.verified === true,
        }
      : null,
    media,
    quoteCount: N(raw, "quoteCount"),
    bookmarkCount: N(raw, "bookmarkCount"),
    isReply: raw.isReply === true,
    isQuote: raw.isQuoteStatus === true,
    isRetweet: raw.isRetweet === true,
    lang: S(raw, "lang"),
    hashtags: entityTags.length > 0 ? entityTags : (strArray(raw.hashtags) ?? []),
    place: S(obj(raw.place), "fullName"),
  }
}

export interface FacebookExtras {
  author: { name: string; avatar: string | null; url: string | null } | null
  reactions: {
    like: number | null
    love: number | null
    care: number | null
    haha: number | null
    wow: number | null
    sad: number | null
    anger: number | null
  } | null
  attachments: Array<{ type: string | null; url: string }>
  isReshare: boolean
}

function facebookExtras(raw: Row): FacebookExtras {
  const author = obj(raw.author)
  const reactions = obj(raw.reactions)
  const name = S(author, "name")
  // 任一反应键非空即出整组（官方 actor 的帖子可能只有 love 没有 like）
  const hasReactions = Object.values(reactions).some((v) => v != null && v !== "")
  return {
    author: name
      ? { name, avatar: firstHttp(author.profilePicture), url: firstHttp(author.profileUrl) }
      : null,
    reactions: hasReactions
      ? {
          like: N(reactions, "like"),
          love: N(reactions, "love"),
          // 官方 actor 用 support / sorry（旧市场 actor 用 care / sad）
          care: N(reactions, "care", "support"),
          haha: N(reactions, "haha"),
          wow: N(reactions, "wow"),
          sad: N(reactions, "sad", "sorry"),
          anger: N(reactions, "anger"),
        }
      : null,
    attachments: arr(raw.attachments)
      .map((a) => ({ type: S(a, "type"), url: firstHttp(S(a, "url")) }))
      .filter((a): a is { type: string | null; url: string } => a.url != null)
      .slice(0, 12),
    isReshare: raw.isReshare === true,
  }
}

// ── 入口 ────────────────────────────────────────────────────────

export interface ResultExtras {
  amazon?: AmazonExtras
  temu?: TemuExtras
  etsy?: EtsyExtras
  shopify?: ShopifyExtras
  tiktok?: TiktokExtras
  instagram?: InstagramExtras
  pinterest?: PinterestExtras
  reddit?: RedditExtras
  x?: XExtras
  facebook?: FacebookExtras
}

/** raw_data → 平台 extras（非对象 / 未知平台返回空对象；永不抛错） */
export function extractExtras(platform: string, rawData: unknown, base: ExtrasBase = {}): ResultExtras {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) return {}
  const raw = rawData as Row
  try {
    switch (platform) {
      case "amazon":
        return { amazon: amazonExtras(raw, base) }
      case "temu":
        return { temu: temuExtras(raw, base) }
      case "etsy":
        return { etsy: etsyExtras(raw, base) }
      case "shopify":
        return { shopify: shopifyExtras(raw, base) }
      case "tiktok":
        return { tiktok: tiktokExtras(raw) }
      case "instagram":
        return { instagram: instagramExtras(raw, base) }
      case "pinterest":
        return { pinterest: pinterestExtras(raw, base) }
      case "reddit":
        return { reddit: redditExtras(raw) }
      case "x":
        return { x: xExtras(raw) }
      case "facebook":
        return { facebook: facebookExtras(raw) }
      default:
        return {}
    }
  } catch {
    return {}
  }
}

// ── 评论 extras（selection_review.raw_data 投影） ─────────────────

export interface ReviewExtras {
  title: string | null
  images: string[]
  vine: boolean
  /** 被评论的商品变体（"Color: White"） */
  variant: string | null
  country: string | null
}

/** 评论原始行 → 展示用附加字段（junglee Amazon / Etsy 等评论 actor 键名） */
export function reviewExtras(rawData: unknown): ReviewExtras {
  const raw = obj(rawData)
  const variant =
    S(raw, "variant") ??
    arr(raw.variantAttributes)
      .map((a) => {
        const k = S(a, "key")
        const v = S(a, "value")
        return k && v ? `${k}: ${v}` : null
      })
      .filter(nonNull)
      .join(", ")
  return {
    title: S(raw, "reviewTitle", "title"),
    images: httpList(raw.reviewImages).slice(0, 6),
    vine: raw.isAmazonVine === true,
    variant: variant || null,
    country: S(raw, "country"),
  }
}

// ── 视频来源判定 ────────────────────────────────────────────────

export interface VideoSource {
  /** direct = <video src> 直链；embed = 官方嵌入播放器（点击后才加载）；none = 无法内播 */
  kind: "direct" | "embed" | "none"
  src: string | null
  provider: "tiktok" | "youtube" | null
  poster: string | null
  durationSec: number | null
}

const NO_VIDEO: VideoSource = { kind: "none", src: null, provider: null, poster: null, durationSec: null }

/** YouTube 视频 ID（youtu.be / watch?v= / embed / shorts / live） */
export function youtubeIdOf(url: string): string | null {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/i,
  )
  return m ? m[1]! : null
}

/**
 * 帖子 / 商品的视频播放来源（2026-11-24 各 actor 实测）：
 *   X = 最高码率 mp4 直链；Instagram / Pinterest / TEMU / Facebook = 带签名的 CDN 直链
 *   （会过期，过期后退回封面）；TikTok = actor 不给直链，走官方嵌入；Reddit 的
 *   YouTube 链接走嵌入、v.redd.it 的 .mp4 直链尝试播放。
 */
export function resolveVideo(
  platform: string,
  item: { externalId: string | null; images?: string[] | null; videos?: string[] | null; extras?: ResultExtras | null },
): VideoSource {
  const extras = item.extras ?? {}
  const poster = item.images?.[0] ?? null
  const direct = (src: string | null | undefined, p: string | null = poster, durationSec: number | null = null): VideoSource =>
    src ? { kind: "direct", src, provider: null, poster: p, durationSec } : { ...NO_VIDEO, poster }
  switch (platform) {
    case "x": {
      const media = extras.x?.media ?? []
      const video = media.find((m) => m.type !== "photo")
      return direct(item.videos?.[0] ?? video?.url ?? null, video?.thumb ?? poster, video?.durationSec ?? null)
    }
    case "instagram":
      return direct(extras.instagram?.videoUrl ?? item.videos?.[0] ?? null, poster, extras.instagram?.durationSec ?? null)
    case "pinterest":
      return direct(
        extras.pinterest?.videoUrl ?? item.videos?.[0] ?? null,
        extras.pinterest?.videoThumb ?? poster,
        extras.pinterest?.durationSec ?? null,
      )
    case "temu":
      return direct(extras.temu?.videoUrl ?? item.videos?.[0] ?? null)
    case "etsy":
      // Etsy 商品视频是不带签名的 mp4 直链（extras 投影回落统一列）
      return direct(extras.etsy?.videoUrl ?? item.videos?.[0] ?? null)
    case "facebook":
      // 存量行 videos 列可能为空，投影里的视频附件仍可直连播放
      return direct(
        item.videos?.[0] ??
          extras.facebook?.attachments.find((a) => a.type === "video" || isDirectVideoUrl(a.url))?.url ??
          null,
      )
    case "tiktok": {
      // 图文帖没有视频；视频帖用官方嵌入（需要视频数字 ID）
      if (extras.tiktok?.isSlideshow || !item.externalId) return { ...NO_VIDEO, poster }
      return {
        kind: "embed",
        src: `https://www.tiktok.com/embed/v2/${encodeURIComponent(item.externalId)}`,
        provider: "tiktok",
        poster,
        durationSec: extras.tiktok?.durationSec ?? null,
      }
    }
    case "reddit": {
      const outbound = extras.reddit?.outboundUrl
      if (!extras.reddit?.isVideo || !outbound) return { ...NO_VIDEO, poster }
      const yt = youtubeIdOf(outbound)
      if (yt) {
        return {
          kind: "embed",
          src: `https://www.youtube-nocookie.com/embed/${yt}`,
          provider: "youtube",
          poster,
          durationSec: null,
        }
      }
      return direct(/\.(mp4|m3u8)([?#]|$)/i.test(outbound) ? outbound : null)
    }
    default:
      return { ...NO_VIDEO, poster }
  }
}
