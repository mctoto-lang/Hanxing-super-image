import {
  SELECTION_PLATFORM_CONFIGS,
  countryFor,
  type SelectionPlatform,
} from "./platforms"
import {
  AMAZON_DEFAULT_CATEGORY,
  AMAZON_LIST_TYPE_LABELS,
  AMAZON_SITE_LABELS,
  amazonAsinFromUrl,
  amazonCategoryLabel,
  amazonDomainForSite,
  amazonListUrl,
  canonicalAmazonUrl,
  isAmazonSite,
} from "./amazon-lists"
import { canonicalTemuUrl } from "./monitor-target"

/**
 * 表单参数 → Apify Actor runInput（server-only）
 *
 * 入参形状全部经实际试抓验证（2026-11-19 各平台、2026-11-24 junglee Amazon 家族 +
 * hypebridge TEMU）；换 Actor 时只改本文件与 normalizers.ts。params 已由 action
 * 层 zod 清洗（字符串 trim、数字安全）。
 */

export interface BuiltActorInput {
  actorId: string
  runInput: Record<string, unknown>
  /** 列表展示用主关键词（类目/版块/域名等非关键词型任务取对应描述） */
  keyword: string
  /** 国家快照（ISO 大写；无国家概念的平台 null），落 selection_task.country */
  country: string | null
  /** Apify 侧 run 超时秒数（缺省 600；慢 actor 由注册表放宽） */
  timeoutSecs?: number
  /**
   * 申请的运行内存 MB（缺省用 actor 默认，junglee 家族为 4096）。账户所有运行
   * 合计有内存上限（免费版 16GB），实测峰值很小的轻量任务调小以免互相挤占。
   */
  memoryMB?: number
}

/** 单品监控 / 评论抓取的运行内存（实测峰值 0.12~0.3GB，留足余量取 1024） */
const LIGHT_RUN_MEMORY_MB = 1024

/**
 * 入参解析/校验类确定性错误（ASIN 解析失败、旧版入参键残留、站点品类组合不支持等）：
 * 重试也不会自愈。调度侧据此立即暂停监控并写明原因，与瞬时故障（网络/数据库）
 * 的「回拨时钟重试」区分开（见 selection-monitor-service）。
 */
export class SelectionInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SelectionInputError"
  }
}

/**
 * 旧版 Amazon 发现入参（categoryUrl，已下线）残留检测：有旧键且无新 category 键
 * 时无法安全执行——静默回落默认品类会抓错类目并按原条数扣积分，调用方应直接拒绝
 * （提交入口与重试入口共用，见 selection-task-service）。
 */
export function hasLegacyAmazonCategoryUrl(
  params: Record<string, unknown> | null | undefined,
): boolean {
  if (params == null || typeof params !== "object") return false
  const legacy = params.categoryUrl
  if (legacy == null || String(legacy).trim() === "") return false
  const next = params.category
  return next == null || String(next).trim() === ""
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  if (typeof v !== "string") return undefined
  const s = v.trim()
  return s.length > 0 ? s : undefined
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key]
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v)
  }
  return undefined
}

/** Instagram/TikTok 话题标签去 # 前缀 */
function stripHashtag(v: string): string {
  return v.replace(/^#+/, "").trim()
}

/** Shopify 域名归一化（剥协议/路径） */
function normalizeDomain(v: string): string {
  return v.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
}

export function buildActorInput(args: {
  platform: SelectionPlatform
  taskType: "discover" | "market" | "monitor" | "review"
  params: Record<string, unknown>
  maxResults: number
}): BuiltActorInput {
  if (args.taskType === "monitor" || args.taskType === "review") {
    const built =
      args.taskType === "monitor"
        ? buildMonitorInputRaw(args.platform, args.params, args.maxResults)
        : buildReviewInputRaw(args.platform, args.params, args.maxResults)
    // 国家沿用监控目标快照（params.country 由任务创建时写入）
    // 单品监控 / 评论抓取都是单目标轻量运行；仅对实测过峰值的 actor 调小内存
    //（Amazon ASIN / 评论、TEMU 单品），其余保持 actor 默认
    const lightMemory =
      args.platform === "amazon" || args.platform === "temu"
    return {
      ...built,
      country: (str(args.params, "country") ?? null)?.toUpperCase() ?? null,
      memoryMB: built.memoryMB ?? (lightMemory ? LIGHT_RUN_MEMORY_MB : undefined),
    }
  }
  const country = countryFor(args.platform, args.taskType, args.params)
  return {
    ...buildActorInputRaw({ ...args, taskType: args.taskType as "discover" | "market" }),
    // Amazon 入参按站点决定域名，非法站点码在入参侧回落美国——国家快照随之置空，
    // 避免「抓的是美国站、快照却写着非法码」的不一致（正常表单提交走不到这里：
    // sanitizeParams 已拒绝非法选项）
    country:
      args.platform === "amazon" && country != null && !isAmazonSite(country) ? null : country,
  }
}

/**
 * 竞品监控指标重抓（taskType='monitor'）：params={targetUrl, externalId}。
 * reddit 特例：单任务同时带回评论（includeComments）。
 */
function buildMonitorInputRaw(
  platform: SelectionPlatform,
  params: Record<string, unknown>,
  maxResults: number,
): Omit<BuiltActorInput, "country"> {
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  const targetUrl = str(params, "targetUrl") ?? ""
  const actorId = cfg.monitor?.metricsActorId
  if (!actorId) {
    throw new SelectionInputError(`平台 ${platform} 无指标重抓能力（metricsActorId 未配置）`)
  }
  const keyword = str(params, "keyword") ?? "监控重抓"
  switch (platform) {
    case "amazon": {
      // junglee/amazon-asins-scraper：ASIN 直抓（externalId 优先，缺则从目标链接解析）
      const fromId = (str(params, "externalId") ?? "").trim().toUpperCase()
      const asin = /^[A-Z0-9]{10}$/.test(fromId) ? fromId : amazonAsinFromUrl(targetUrl)
      if (!asin) {
        throw new SelectionInputError("无法从监控目标解析 Amazon ASIN（目标链接不是商品详情页）")
      }
      const site = str(params, "country")
      return {
        actorId,
        runInput: { asins: [asin], amazonDomain: amazonDomainForSite(site ?? "US") },
        keyword,
      }
    }
    case "temu": {
      // hypebridge/temu-scraper：商品页 URL 直抓（链接带追踪参数时按 goodsId 重建规范链接）
      const url =
        canonicalTemuUrl(targetUrl) ?? canonicalTemuUrl(str(params, "externalId"))
      if (!url) throw new SelectionInputError("无法从监控目标解析 TEMU 商品 ID")
      return {
        actorId,
        runInput: { startUrls: [{ url }], maxItems: 1, getProductDetails: true },
        keyword,
      }
    }
    case "shopify":
      return {
        actorId,
        runInput: { startUrls: [{ url: targetUrl }], maxRequestsPerCrawl: Math.max(1, maxResults) },
        keyword,
      }
    case "instagram":
      return {
        actorId,
        runInput: { resultsType: "posts", directUrls: [targetUrl], resultsLimit: Math.max(1, maxResults) },
        keyword,
      }
    case "tiktok":
      return {
        actorId,
        runInput: { postURLs: [targetUrl], resultsPerPage: Math.max(1, maxResults) },
        keyword,
      }
    case "pinterest":
      return {
        actorId,
        runInput: { pinUrls: [targetUrl], maxPins: Math.max(1, maxResults) },
        keyword,
      }
    case "reddit":
      // 单任务带回评论：评论直接进 selection_review（收割侧路由）
      return {
        actorId,
        runInput: {
          urls: [targetUrl],
          maxPostsPerSource: Math.max(1, maxResults),
          includeComments: true,
          maxCommentsPerPost: num(params, "reviewMax") ?? 200,
        },
        keyword,
      }
    case "x":
      return {
        actorId,
        runInput: { startUrls: [targetUrl], maxItems: Math.max(1, maxResults) },
        keyword,
      }
    case "facebook":
      return {
        actorId,
        runInput: { startUrls: [targetUrl], resultsLimit: Math.max(1, maxResults) },
        keyword,
      }
    default:
      throw new SelectionInputError(`平台 ${platform} 无指标重抓能力`)
  }
}

/**
 * 评论/回复抓取（taskType='review'）：params={targetUrl, externalId, reviewMax}。
 * reddit 已随 monitor 任务带回评论，独立 review 任务同构（posts 1 条 + comments）。
 */
function buildReviewInputRaw(
  platform: SelectionPlatform,
  params: Record<string, unknown>,
  maxResults: number,
): Omit<BuiltActorInput, "country"> {
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  const targetUrl = str(params, "targetUrl") ?? ""
  const externalId = str(params, "externalId")
  const actorId = cfg.monitor?.reviewActorId
  if (!actorId) {
    throw new SelectionInputError(`平台 ${platform} 无评论抓取能力（reviewActorId 未配置）`)
  }
  const keyword = str(params, "keyword") ?? "评论抓取"
  const max = Math.max(1, maxResults)
  switch (platform) {
    case "amazon": {
      // junglee/amazon-reviews-scraper：productUrls 必须是 [{url}] 对象数组（字符串数组
      // 会被入参校验拒绝）；周期监控抓最新（recent），一次性抓取取最有用（helpful）
      const asin = /^[A-Z0-9]{10}$/i.test(externalId ?? "")
        ? externalId!.toUpperCase()
        : amazonAsinFromUrl(targetUrl)
      const productUrl = canonicalAmazonUrl({ asin, url: targetUrl }) ?? targetUrl
      const sort = str(params, "reviewSort") === "helpful" ? "helpful" : "recent"
      return { actorId, runInput: { productUrls: [{ url: productUrl }], maxReviews: max, sort }, keyword }
    }
    case "etsy":
      // khadinakbar/etsy-reviews-scraper：listing URL + maxReviewsPerListing
      return { actorId, runInput: { productUrls: [targetUrl], maxReviewsPerListing: max }, keyword }
    case "instagram":
      return { actorId, runInput: { directUrls: [targetUrl], resultsLimit: max }, keyword }
    case "tiktok":
      return { actorId, runInput: { postURLs: [targetUrl], commentsPerPost: max }, keyword }
    case "reddit":
      return {
        actorId,
        runInput: { urls: [targetUrl], maxPostsPerSource: 1, includeComments: true, maxCommentsPerPost: max },
        keyword,
      }
    case "x":
      // xquik：replyTweetIds 接受推文 ID 或 URL
      return { actorId, runInput: { replyTweetIds: [externalId ?? targetUrl], maxItems: max }, keyword }
    case "facebook":
      return { actorId, runInput: { startUrls: [targetUrl], resultsLimit: max }, keyword }
    default:
      throw new SelectionInputError(`平台 ${platform} 无评论抓取能力`)
  }
}

function buildActorInputRaw(args: {
  platform: SelectionPlatform
  taskType: "discover" | "market"
  params: Record<string, unknown>
  maxResults: number
}): Omit<BuiltActorInput, "country"> {
  const { platform, taskType, params } = args
  const maxResults = Math.max(1, Math.floor(args.maxResults))
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  const keyword = str(params, "keyword") ?? ""

  if (taskType === "discover" && cfg.discover) {
    switch (platform) {
      case "amazon": {
        // junglee/amazon-bestsellers：畅销榜 / 新品榜 × 站点 × 品类（支持矩阵见
        // amazon-lists.ts）；带详情模式拿商品页全量字段，每类目 Amazon 硬上限 100 条。
        // 旧版 categoryUrl 入参已下线：残留旧键且无新 category 键时拒绝执行，
        // 绝不静默回落默认品类（美妆→消费电子）抓错类目并扣积分
        if (hasLegacyAmazonCategoryUrl(params)) {
          throw new SelectionInputError(
            "旧版 Amazon 榜单入参（categoryUrl）已下线，请重新选择站点与品类后提交",
          )
        }
        const site = str(params, "country") ?? "US"
        const listType = str(params, "listType") ?? "bestsellers"
        const category = str(params, "category") ?? AMAZON_DEFAULT_CATEGORY
        const listUrl = amazonListUrl(site, listType, category)
        if (!listUrl) {
          throw new SelectionInputError("该站点 / 品类的 Amazon 榜单暂不支持，请更换站点或品类")
        }
        return {
          actorId: cfg.discover.actorId,
          runInput: {
            categoryUrls: [listUrl],
            maxItemsPerStartUrl: Math.min(maxResults, 100),
            depthOfCrawl: 1,
            detailedInformation: true,
          },
          keyword: `${AMAZON_LIST_TYPE_LABELS[listType as keyof typeof AMAZON_LIST_TYPE_LABELS]}·${AMAZON_SITE_LABELS[isAmazonSite(site) ? site : "US"]}·${amazonCategoryLabel(category)}`,
          timeoutSecs: cfg.discover.timeoutSecs,
        }
      }
      case "temu": {
        // CRW actor：keyword/region/sort/max_items（region 当前仅 US）
        return {
          actorId: cfg.discover.actorId,
          runInput: {
            keyword,
            region: "US",
            sort: "top_sales",
            max_items: Math.min(maxResults, 100),
          },
          keyword,
        }
      }
      case "etsy": {
        return {
          actorId: cfg.discover.actorId,
          runInput: {
            keywords: [keyword],
            maxListingsPerKeyword: maxResults,
            fetchFavorites: true,
            country: str(params, "country") ?? "US",
          },
          keyword,
        }
      }
      case "pinterest": {
        return {
          actorId: cfg.discover.actorId,
          runInput: {
            operationMode: "pinterestTrends",
            trendsRegion: str(params, "trendsRegion") ?? "US",
            trendsType: str(params, "trendsType") ?? "growing",
            trendsIncludeWeeklyInterest: true,
            trendsMaxItems: maxResults,
            ...(keyword ? { trendsKeywords: [keyword] } : {}),
          },
          keyword: keyword || "Pinterest 趋势榜",
        }
      }
      case "reddit": {
        const subreddit = str(params, "subreddit") ?? "BuyItForLife"
        return {
          actorId: cfg.discover.actorId,
          runInput: {
            subreddit,
            maxPostsPerSubreddit: maxResults,
            sort: "hot",
          },
          keyword: subreddit,
        }
      }
      case "shopify": {
        return {
          actorId: cfg.discover.actorId,
          runInput: { query: keyword, maxItems: maxResults },
          keyword,
        }
      }
      case "instagram":
        return {
          actorId: cfg.discover.actorId,
          runInput: { hashtags: [stripHashtag(keyword)], resultsLimit: maxResults },
          keyword,
        }
      case "tiktok":
        return {
          actorId: cfg.discover.actorId,
          runInput: { hashtags: [stripHashtag(keyword)], resultsPerPage: maxResults },
          keyword,
        }
      case "x":
        return {
          actorId: cfg.discover.actorId,
          runInput: { searchTerms: [keyword], maxItems: maxResults },
          keyword,
        }
      case "facebook":
        return {
          actorId: cfg.discover.actorId,
          runInput: { query: keyword, resultsCount: maxResults },
          keyword,
        }
    }
  }

  // 市场分析（关键词搜索）
  switch (platform) {
    case "amazon": {
      // junglee/Amazon-crawler：搜索页 URL 入口（站点由域名决定），每条抓商品页详情。
      // 不传 countryCode/zipCode（配送地定位每条多 $0.06，默认按域名自动选代理）
      const siteRaw = str(params, "country") ?? "US"
      const site = isAmazonSite(siteRaw) ? siteRaw : "US"
      const search = new URL(`https://www.${amazonDomainForSite(site)}/s`)
      search.searchParams.set("k", keyword)
      const minPrice = num(params, "minPrice")
      const maxPrice = num(params, "maxPrice")
      if (minPrice != null) search.searchParams.set("low-price", String(minPrice))
      if (maxPrice != null) search.searchParams.set("high-price", String(maxPrice))
      return {
        actorId: cfg.marketActorId,
        runInput: {
          categoryOrProductUrls: [{ url: search.toString() }],
          maxItemsPerStartUrl: maxResults,
          scrapeProductDetails: true,
          maxOffers: 0,
          scrapeSellers: false,
        },
        keyword,
      }
    }
    case "etsy":
      return {
        actorId: cfg.marketActorId,
        // Actor 侧最小 30 条（试抓实证），不足按 30 提交防入参报错
        runInput: {
          searchQueries: [keyword],
          maxListings: Math.max(maxResults, 30),
          enrichWithDetails: false,
          currency: str(params, "currency") ?? "USD",
        },
        keyword,
      }
    case "temu":
      // CRW actor：keyword/region/sort/max_items（region 当前仅 US）
      return {
        actorId: cfg.marketActorId,
        runInput: {
          keyword,
          region: "US",
          sort: str(params, "sort") ?? "relevance",
          max_items: Math.min(maxResults, 100),
        },
        keyword,
      }
    case "shopify": {
      const domain = normalizeDomain(str(params, "domain") ?? "")
      const query = str(params, "query")
      return {
        actorId: cfg.marketActorId,
        runInput: {
          startUrls: [{ url: `https://${domain}` }],
          maxRequestsPerCrawl: maxResults,
          ...(query ? { query } : {}),
        },
        keyword: domain,
      }
    }
    case "instagram":
      return {
        actorId: cfg.marketActorId,
        runInput: { hashtags: [stripHashtag(keyword)], resultsLimit: maxResults },
        keyword,
      }
    case "tiktok":
      return {
        actorId: cfg.marketActorId,
        runInput: { searchQueries: [keyword], resultsPerPage: maxResults },
        keyword,
      }
    case "pinterest":
      // automation-lab/pinterest-scraper（2026-11-21 换）：searchQueries+maxPins
      return {
        actorId: cfg.marketActorId,
        runInput: { searchQueries: [keyword], maxPins: maxResults },
        keyword,
      }
    case "reddit":
      return {
        actorId: cfg.marketActorId,
        runInput: {
          searchQueries: [keyword],
          maxPostsPerSource: maxResults,
          sort: str(params, "sort") ?? "relevance",
          timeFilter: str(params, "timeFilter") ?? "month",
        },
        keyword,
      }
    case "x":
      return {
        actorId: cfg.marketActorId,
        runInput: { searchTerms: [keyword], maxItems: maxResults },
        keyword,
      }
    case "facebook":
      return {
        actorId: cfg.marketActorId,
        runInput: { query: keyword, resultsCount: maxResults },
        keyword,
      }
  }
}
