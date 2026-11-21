import {
  SELECTION_PLATFORM_CONFIGS,
  countryFor,
  type SelectionPlatform,
} from "./platforms"

/**
 * 表单参数 → Apify Actor runInput（server-only）
 *
 * 入参形状全部经 2026-11-19 实际试抓验证；换 Actor 时只改本文件与
 * normalizers.ts。params 已由 action 层 zod 清洗（字符串 trim、数字安全）。
 */

export interface BuiltActorInput {
  actorId: string
  runInput: Record<string, unknown>
  /** 列表展示用主关键词（类目/版块/域名等非关键词型任务取对应描述） */
  keyword: string
  /** 国家快照（ISO 大写；无国家概念的平台 null），落 selection_task.country */
  country: string | null
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

const AMAZON_CATEGORY_LABELS: Record<string, string> = {
  "https://www.amazon.com/gp/bestsellers": "全站总榜",
  "https://www.amazon.com/gp/bestsellers/electronics": "消费电子",
  "https://www.amazon.com/gp/bestsellers/home-kitchen": "家居厨房",
  "https://www.amazon.com/gp/bestsellers/kitchen": "厨房餐厅",
  "https://www.amazon.com/gp/bestsellers/fashion": "服装鞋履",
  "https://www.amazon.com/gp/bestsellers/beauty": "美妆护肤",
  "https://www.amazon.com/gp/bestsellers/sports-outdoors": "运动户外",
  "https://www.amazon.com/gp/bestsellers/toys-and-games": "玩具游戏",
  "https://www.amazon.com/gp/bestsellers/pet-supplies": "宠物用品",
  "https://www.amazon.com/gp/bestsellers/office-products": "办公用品",
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
    return {
      ...built,
      country: (str(args.params, "country") ?? null)?.toUpperCase() ?? null,
    }
  }
  return {
    ...buildActorInputRaw({ ...args, taskType: args.taskType as "discover" | "market" }),
    country: countryFor(args.platform, args.taskType, args.params),
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
    throw new Error(`平台 ${platform} 无指标重抓能力（metricsActorId 未配置）`)
  }
  const keyword = str(params, "keyword") ?? "监控重抓"
  switch (platform) {
    case "amazon":
      return {
        actorId,
        runInput: { urls: [{ url: targetUrl }], count: Math.max(1, maxResults) },
        keyword,
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
      throw new Error(`平台 ${platform} 无指标重抓能力`)
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
    throw new Error(`平台 ${platform} 无评论抓取能力（reviewActorId 未配置）`)
  }
  const keyword = str(params, "keyword") ?? "评论抓取"
  const max = Math.max(1, maxResults)
  switch (platform) {
    case "amazon":
      // junglee/amazon-reviews-scraper：productUrls 数组 + maxReviews
      return { actorId, runInput: { productUrls: [targetUrl], maxReviews: max }, keyword }
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
      throw new Error(`平台 ${platform} 无评论抓取能力`)
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
        const categoryUrl =
          str(params, "categoryUrl") ?? "https://www.amazon.com/gp/bestsellers"
        return {
          actorId: cfg.discover.actorId,
          runInput: { urls: [{ url: categoryUrl }], count: maxResults },
          keyword: AMAZON_CATEGORY_LABELS[categoryUrl] ?? "Best Sellers",
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
    case "amazon":
      return {
        actorId: cfg.marketActorId,
        runInput: {
          searchQueries: [keyword],
          maxResultsPerQuery: maxResults,
          country: str(params, "country") ?? "US",
          ...(num(params, "minPrice") != null ? { minPrice: num(params, "minPrice") } : {}),
          ...(num(params, "maxPrice") != null ? { maxPrice: num(params, "maxPrice") } : {}),
        },
        keyword,
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
