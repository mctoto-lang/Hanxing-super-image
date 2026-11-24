/**
 * 选品平台注册表（client-safe：无服务端依赖，表单/计费预估/列表展示共用）
 *
 * 字段映射与入参形状均经 2026-11-19 Apify 实际试抓验证（Actor 随时可换，
 * 换 Actor 只改本表 + input-builders/normalizers，UI 不动）。
 * 试抓坑位备忘：
 *   - Etsy devcake maxListings 最小 30；enrichWithDetails 默认 true（贵）必须显式关
 *   - TEMU 用 CRW/temu-products-scraper（$0.01/条）：region 仅支持 US、
 *     max_items≤100、sort 五档；2026-11-20 替换 selleraim（无 sort）+ memo23（销量榜）
 *   - Shopify autofacts startUrls 必须是 [{url:"..."}] 对象数组
 *   - Instagram 主 scraper 关键词搜索返回账号档案——关键词场景改用 hashtag-scraper
 *   - TikTok clockworks 平台侧最低单 run 计费上限 $0.5（MCP 试抓限制，生产 HTTP 不受影响）
 *
 * 监控/评论 Actor 选型（2026-11-21 Apify Store 按总使用人数择优，均带 URL
 * 直抓入口）：amazon 评论 junglee 官方 18k、etsy 评论 khadinakbar（listing URL）、
 * IG apify/instagram-scraper 49.5 万 + 官方 comment 75k、TikTok clockworks 39.8 万
 * + comments 56k、FB apify 官方 posts 14.5 万 + comments 74k、X xquik 10k
 * （startUrls/replyTweetIds 双模式）、Reddit 复用 automation-lab（urls+
 * includeComments 单任务带回评论）。Etsy/TEMU 无商品页直抓入口 → Etsy 仅评论
 * 追踪、TEMU 不支持监控。Pinterest 市场搜索 2026-11-21 换 automation-lab（2.2k
 * 用户，saves/评论数字段更全 + pinUrls 监控入口）。
 *
 * 2026-11-24 Amazon 换 junglee 家族 + TEMU 补单品监控（探针实测口径）：
 *   - amazon 市场 → junglee/Amazon-crawler（33k 用户）：搜索 URL 入口、每条带商品页
 *     详情（BSR/月购买量/五点/规格/变体/官方 AI 评论摘要）；Amazon 搜索约 7 页封顶，
 *     单任务上限收到 200；$0.005/条。绝不传 countryCode/zipCode（每条多 $0.06）
 *   - amazon 发现 → junglee/amazon-bestsellers（榜单）：畅销榜 / 新品榜 × 美英日加法 ×
 *     品类（支持矩阵见 amazon-lists.ts）；带详情模式约 3.8s/条，run 超时放宽
 *   - amazon 监控 → junglee/amazon-asins-scraper（ASIN 直抓，出参与商品页同族）
 *   - amazon 评论：productUrls 必须是 [{url}] 对象数组；免费版 Apify 每次运行最多
 *     10 条、最低 $0.50/次
 *   - temu 监控 → hypebridge/temu-scraper（1.5k 用户，URL 直抓用户数最多）：带 SKU/库存/
 *     规格/图集/视频，但出参无销量与市场价；约 $0.046/次，按次 10 积分
 */
import {
  AMAZON_DEFAULT_CATEGORY,
  AMAZON_LIST_SITES,
  AMAZON_LIST_TYPES,
  AMAZON_MARKET_SITES,
  AMAZON_SITE_LABELS,
  amazonCategoryOptionData,
} from "./amazon-lists"

export const SELECTION_PLATFORMS = [
  "amazon",
  "etsy",
  "temu",
  "shopify",
  "instagram",
  "tiktok",
  "pinterest",
  "reddit",
  "x",
  "facebook",
] as const
export type SelectionPlatform = (typeof SELECTION_PLATFORMS)[number]

export type PlatformCategory = "ecommerce" | "social"

/** 该类别下的平台（顺序即展示顺序：标签条、下拉、表格均由此派生） */
export function platformsForCategory(category: PlatformCategory): SelectionPlatform[] {
  return SELECTION_PLATFORMS.filter(
    (p) => SELECTION_PLATFORM_CONFIGS[p].category === category,
  )
}

/** 结果卡片/表格侧重：决定展示哪些列 */
export type ResultKind = "product" | "post" | "store" | "trend"

export interface PlatformFieldOption {
  value: string
  label: string
  /**
   * 条件显示：仅当同表单 `field` 的当前值在 `in` 里时该选项可选（如 Amazon 榜单品类
   * 随站点变化）。服务端 sanitizeParams 按同一条件校验，绕过前端提交不支持组合会被拒。
   */
  showWhen?: { field: string; in: string[] }
}

/** 平台动态表单字段（市场/发现模式的差异都通过字段声明表达） */
export interface PlatformField {
  key: string
  label: string
  type: "text" | "number" | "select"
  placeholder?: string
  /** type=select 时的选项 */
  options?: PlatformFieldOption[]
  required?: boolean
  min?: number
  max?: number
  defaultValue?: string | number
  help?: string
  /** 发现模式的主输入（类目 / 版块等非关键词型任务的主选择）；声明后不再补关键词框 */
  primary?: boolean
}

export interface DiscoverModeConfig {
  actorId: string
  /** 发现模式名（如「Best Sellers 榜单」） */
  label: string
  description: string
  /** 该模式的表单字段（覆盖市场模式字段） */
  fields: PlatformField[]
  /** 结果侧重（pinterest 趋势=trend，shopify 店铺=store） */
  resultKind: ResultKind
  /** 发现模式每条积分费率（缺省同市场费率） */
  creditsPerResult?: number
  /** 国家来源（缺省继承市场模式配置） */
  countrySource?: CountrySource
  /** Apify 侧 run 超时秒数（缺省 600；慢 actor 如 Amazon 榜单带详情放宽） */
  timeoutSecs?: number
  /** 发现模式结果数上限 / 默认值 / 最小值（缺省沿用平台级配置） */
  maxResultsPerTask?: number
  defaultResults?: number
  minResults?: number
}

/**
 * 国家维度来源（落 selection_task.country / selection_result.country，
 * 供数据池筛选与卡片国家徽章）：
 *   field = 取表单字段值（须为 ISO 码，如 amazon country）
 *   fixed = 固定值（如 TEMU CRW actor 当前仅 US）
 * 都不配 = 该模式无国家概念（null）
 */
export interface CountrySource {
  field?: string
  fixed?: string
}

export interface SelectionPlatformConfig {
  key: SelectionPlatform
  label: string
  category: PlatformCategory
  /** 市场分析（关键词搜索）Actor */
  marketActorId: string
  /** 每条结果积分费率 */
  creditsPerResult: number
  /** 单任务结果数上限 */
  maxResultsPerTask: number
  /** 默认结果数 */
  defaultResults: number
  /** 最小结果数（Etsy Actor 平台侧最小 30） */
  minResults: number
  /** 市场模式表单字段（关键词/域名之外的可选项） */
  fields: PlatformField[]
  resultKind: ResultKind
  /** 国家维度来源（市场模式；发现模式可在 discover 里覆盖） */
  countrySource?: CountrySource
  /** 发现页能力（平台原生热门；无原生热门能力的平台缺省=关键词高热内容） */
  discover?: DiscoverModeConfig
  /** 竞品监控能力（0106）；缺省 = 该平台不支持监控 */
  monitor?: MonitorModeConfig
}

/**
 * 竞品监控能力（2026-11-21 Apify Store 按使用人数选型）：
 *   metricsActorId  指标重抓 Actor（URL 直抓入口）——null = 无 URL 入口
 *                   （Etsy 搜索型无商品页直抓，仍可仅评论追踪）
 *   reviewActorId   评论/回复抓取 Actor——null = 平台无评论抓取能力
 * reddit 特例：metrics 与评论同一 Actor 单任务带回（urls + includeComments）。
 */
export interface MonitorModeConfig {
  metricsActorId: string | null
  reviewActorId: string | null
  /**
   * 指标重抓按次积分（0108）：缺省沿用市场每条费率；单价与条数无关的 actor
   * （TEMU 单品详情约 $0.046/次）在此单独定价
   */
  metricsCreditsPerRun?: number
  /** 该平台重抓不提供的指标说明（监控页展示，如 TEMU 单品抓取不含销量） */
  metricsNote?: string
  /** 每条评论积分费率 */
  reviewCreditsPerResult: number
  /** 单次评论抓取条数上限 */
  reviewMaxPerTask: number
}

/** Amazon 关键词搜索站点选项（国家码 = 站点） */
const AMAZON_SITE_OPTIONS: PlatformFieldOption[] = AMAZON_MARKET_SITES.map((s) => ({
  value: s,
  label: AMAZON_SITE_LABELS[s],
}))

/** Amazon 榜单站点选项（德国站实测不被榜单 actor 识别） */
const AMAZON_LIST_SITE_OPTIONS: PlatformFieldOption[] = AMAZON_LIST_SITES.map((s) => ({
  value: s,
  label: AMAZON_SITE_LABELS[s],
}))

/** Amazon 榜单品类选项（仅显示所选站点实测可用的品类） */
const AMAZON_CATEGORY_OPTIONS: PlatformFieldOption[] = amazonCategoryOptionData().map((c) => ({
  value: c.value,
  label: c.label,
  showWhen: { field: "country", in: c.sites },
}))

export const SELECTION_PLATFORM_CONFIGS: Record<
  SelectionPlatform,
  SelectionPlatformConfig
> = {
  amazon: {
    key: "amazon",
    label: "Amazon",
    category: "ecommerce",
    // junglee/Amazon-crawler（2026-11-24 换 santamaria 搜索 actor）：搜索 URL 入口，
    // 每条带商品页详情；Amazon 搜索约 7 页封顶，上限 1000→200
    marketActorId: "junglee/Amazon-crawler",
    creditsPerResult: 2,
    maxResultsPerTask: 200,
    defaultResults: 60,
    minResults: 1,
    resultKind: "product",
    countrySource: { field: "country" },
    fields: [
      { key: "country", label: "站点", type: "select", defaultValue: "US",
        options: AMAZON_SITE_OPTIONS },
      { key: "minPrice", label: "最低价", type: "number", min: 0, placeholder: "如 10（站点币种）" },
      { key: "maxPrice", label: "最高价", type: "number", min: 0, placeholder: "如 100（站点币种）" },
    ],
    discover: {
      // junglee/amazon-bestsellers：畅销榜 / 新品榜 × 多站点 × 品类（见 amazon-lists.ts）
      actorId: "junglee/amazon-bestsellers",
      label: "榜单",
      description: "抓取亚马逊官方畅销榜 / 新品榜（含商品页详情：BSR、月购买量、品牌、评分分布），发现类目头部与新品。",
      resultKind: "product",
      creditsPerResult: 2,
      countrySource: { field: "country" },
      // 带详情模式约 3.8s/条，100 条约 6~7 分钟，run 超时放到 25 分钟
      timeoutSecs: 1500,
      // Amazon 榜单每类目硬上限 100 条
      maxResultsPerTask: 100,
      defaultResults: 48,
      fields: [
        { key: "listType", label: "榜单类型", type: "select", defaultValue: "bestsellers",
          options: AMAZON_LIST_TYPES },
        { key: "country", label: "站点", type: "select", defaultValue: "US",
          options: AMAZON_LIST_SITE_OPTIONS },
        { key: "category", label: "品类", type: "select", primary: true,
          defaultValue: AMAZON_DEFAULT_CATEGORY, options: AMAZON_CATEGORY_OPTIONS },
      ],
    },
    monitor: {
      // junglee/amazon-asins-scraper：ASIN 直抓（入参 asins+amazonDomain），出参与商品页同族
      metricsActorId: "junglee/amazon-asins-scraper",
      // Apify 官方，18k 用户（2026-11-21 选型 usage 最高）
      reviewActorId: "junglee/amazon-reviews-scraper",
      reviewCreditsPerResult: 2,
      // 免费版 Apify 每次运行最多返回 10 条、最低 $0.50/次；上限 50 避免预扣过高
      reviewMaxPerTask: 50,
    },
  },
  etsy: {
    key: "etsy",
    label: "Etsy",
    category: "ecommerce",
    marketActorId: "devcake/etsy-search-scraper",
    creditsPerResult: 3,
    maxResultsPerTask: 480,
    defaultResults: 48,
    minResults: 30,
    resultKind: "product",
    fields: [
      { key: "currency", label: "币种", type: "select", defaultValue: "USD",
        options: [{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }, { value: "GBP", label: "GBP" }, { value: "CAD", label: "CAD" }, { value: "AUD", label: "AUD" }, { value: "JPY", label: "JPY" }] },
    ],
    discover: {
      actorId: "axlymxp/etsy-trending-products-tracker",
      label: "趋势商品追踪",
      description: "按关键词追踪 Etsy 收藏增速最快商品（trending score），挖掘潜力款。",
      resultKind: "product",
      creditsPerResult: 4,
      countrySource: { field: "country" },
      fields: [
        { key: "country", label: "配送地区", type: "select", defaultValue: "US",
          options: [{ value: "US", label: "美国" }, { value: "GB", label: "英国" }, { value: "CA", label: "加拿大" }, { value: "AU", label: "澳大利亚" }, { value: "DE", label: "德国" }] },
      ],
    },
    monitor: {
      // devcake 搜索型无商品页直抓入口 → 无指标重抓，仅评论追踪
      metricsActorId: null,
      reviewActorId: "khadinakbar/etsy-reviews-scraper",
      reviewCreditsPerResult: 3,
      reviewMaxPerTask: 100,
    },
  },
  temu: {
    key: "temu",
    label: "TEMU",
    category: "ecommerce",
    // CRW actor（$0.01/条，2026-11-20 实测）：region 仅 US、max_items≤100、
    // sort 五档原生支持——市场搜索与销量榜共用，无需再分两个 actor
    marketActorId: "crw/temu-products-scraper",
    creditsPerResult: 2,
    maxResultsPerTask: 100,
    defaultResults: 40,
    minResults: 1,
    resultKind: "product",
    countrySource: { fixed: "US" },
    fields: [
      { key: "sort", label: "排序", type: "select", defaultValue: "relevance",
        options: [
          { value: "relevance", label: "综合排序" },
          { value: "top_sales", label: "销量优先" },
          { value: "most_recent", label: "最新上架" },
          { value: "price_low_to_high", label: "价格从低到高" },
          { value: "price_high_to_low", label: "价格从高到低" },
        ] },
    ],
    discover: {
      actorId: "crw/temu-products-scraper",
      label: "销量榜",
      description: "按品类词抓取 TEMU 销量排序商品（top sales），发现爆款。",
      resultKind: "product",
      creditsPerResult: 2,
      // sort 由 input-builder 固定为 top_sales，用户无需选
      fields: [],
    },
    monitor: {
      // hypebridge/temu-scraper（2026-11-24）：URL 直抓里使用人数最多（1.5k）；
      // crw 仅关键词入参不能监控。出参无销量/市场价，监控展示价格/评分/评论数/库存
      metricsActorId: "hypebridge/temu-scraper",
      reviewActorId: null,
      // 单次约 $0.046（启动费 $0.03 + 详情 $0.016），按 TEMU 关键词同口径（2 分 = $0.01）定 10 分
      metricsCreditsPerRun: 10,
      metricsNote: "TEMU 单品抓取不含销量与市场价，监控跟踪价格、评分、评论数与库存",
      reviewCreditsPerResult: 2,
      reviewMaxPerTask: 100,
    },
  },
  shopify: {
    key: "shopify",
    label: "Shopify 独立站",
    category: "ecommerce",
    marketActorId: "autofacts/shopify",
    creditsPerResult: 1,
    maxResultsPerTask: 500,
    defaultResults: 50,
    minResults: 1,
    resultKind: "product",
    fields: [
      { key: "query", label: "站内搜索词", type: "text", placeholder: "可选：在该店铺内搜索" },
    ],
    discover: {
      actorId: "igolaizola/shopify-store-finder",
      label: "店铺发现",
      description: "按关键词发现 Shopify 独立站（规模/地区/联系方式），找对标店铺。",
      resultKind: "store",
      creditsPerResult: 3,
      fields: [],
    },
    monitor: {
      // 店铺/商品页 URL 复用市场 Actor（startUrls 直抓）
      metricsActorId: "autofacts/shopify",
      reviewActorId: null,
      reviewCreditsPerResult: 1,
      reviewMaxPerTask: 50,
    },
  },
  instagram: {
    key: "instagram",
    label: "Instagram",
    category: "social",
    marketActorId: "apify/instagram-hashtag-scraper",
    creditsPerResult: 3,
    maxResultsPerTask: 500,
    defaultResults: 50,
    minResults: 1,
    resultKind: "post",
    fields: [],
    discover: {
      actorId: "apify/instagram-hashtag-scraper",
      label: "话题 Top 帖",
      description: "抓取话题标签下最新帖子，验证品类社媒热度与内容素材。",
      resultKind: "post",
      creditsPerResult: 3,
      fields: [],
    },
    monitor: {
      // apify/instagram-scraper：49.5 万用户（2026-11-21 选型 usage 最高），directUrls 直抓帖子
      metricsActorId: "apify/instagram-scraper",
      reviewActorId: "apify/instagram-comment-scraper",
      reviewCreditsPerResult: 2,
      reviewMaxPerTask: 100,
    },
  },
  tiktok: {
    key: "tiktok",
    label: "TikTok",
    category: "social",
    marketActorId: "clockworks/tiktok-scraper",
    creditsPerResult: 4,
    maxResultsPerTask: 500,
    defaultResults: 50,
    minResults: 1,
    resultKind: "post",
    fields: [],
    discover: {
      actorId: "clockworks/tiktok-scraper",
      label: "话题热门视频",
      description: "抓取话题标签热门视频（播放/点赞/收藏），发现短视频爆款。",
      resultKind: "post",
      creditsPerResult: 4,
      fields: [],
    },
    monitor: {
      // 39.8 万用户；postURLs 直抓视频，评论走专用 comments Actor（56k 用户）
      metricsActorId: "clockworks/tiktok-scraper",
      reviewActorId: "clockworks/tiktok-comments-scraper",
      reviewCreditsPerResult: 1,
      reviewMaxPerTask: 200,
    },
  },
  pinterest: {
    key: "pinterest",
    label: "Pinterest",
    category: "social",
    // 2026-11-21 替换 silentflow/pinterest-scraper-ppr：automation-lab
    // （2.2k 用户/5.0 分）出参更全（saves/评论数/发布时间）且支持 pinUrls
    // 直抓（竞品监控重抓入口），入参 searchQueries+maxPins。
    marketActorId: "automation-lab/pinterest-scraper",
    creditsPerResult: 2,
    maxResultsPerTask: 1000,
    defaultResults: 100,
    minResults: 1,
    resultKind: "post",
    fields: [],
    discover: {
      actorId: "afanasenko/pinterest-scraper",
      label: "Pinterest 趋势榜",
      description: "官方 Pinterest Trends 上升最快搜索词（含过去一年周度兴趣曲线），提前发现需求。",
      resultKind: "trend",
      creditsPerResult: 2,
      fields: [
        { key: "trendsRegion", label: "地区", type: "select", defaultValue: "US",
          options: [{ value: "US", label: "美国" }, { value: "GB+IE", label: "英爱" }, { value: "DE+AT+CH", label: "德奥瑞" }, { value: "FR", label: "法国" }, { value: "IT", label: "意大利" }, { value: "ES", label: "西班牙" }, { value: "BR", label: "巴西" }, { value: "MX", label: "墨西哥" }, { value: "JP", label: "日本" }] },
        { key: "trendsType", label: "榜单", type: "select", defaultValue: "growing",
          options: [{ value: "growing", label: "上升最快" }, { value: "monthly", label: "本月热搜" }, { value: "yearly", label: "年度热搜" }, { value: "seasonal", label: "季节性回潮" }] },
      ],
    },
    monitor: {
      metricsActorId: "automation-lab/pinterest-scraper",
      reviewActorId: null,
      reviewCreditsPerResult: 2,
      reviewMaxPerTask: 100,
    },
  },
  reddit: {
    key: "reddit",
    label: "Reddit",
    category: "social",
    marketActorId: "automation-lab/reddit-scraper",
    creditsPerResult: 2,
    maxResultsPerTask: 1000,
    defaultResults: 100,
    minResults: 1,
    resultKind: "post",
    fields: [
      { key: "sort", label: "排序", type: "select", defaultValue: "relevance",
        options: [{ value: "relevance", label: "相关性" }, { value: "hot", label: "热门" }, { value: "new", label: "最新" }, { value: "top", label: "最高分" }] },
      { key: "timeFilter", label: "时间范围", type: "select", defaultValue: "month",
        options: [{ value: "day", label: "一天内" }, { value: "week", label: "一周内" }, { value: "month", label: "一月内" }, { value: "year", label: "一年内" }, { value: "all", label: "不限" }] },
    ],
    discover: {
      actorId: "clearpath/reddit-subreddit-posts-scraper",
      label: "版块热帖",
      description: "抓取选品类版块热帖（hot），从真实讨论里挖需求与痛点。",
      resultKind: "post",
      creditsPerResult: 2,
      fields: [
        { key: "subreddit", label: "版块", type: "select", defaultValue: "BuyItForLife",
          options: [
            { value: "BuyItForLife", label: "BuyItForLife（耐用好物）" },
            { value: "shutupandtakemymoney", label: "shutupandtakemymoney（创意商品）" },
            { value: "DidntKnowIWantedThat", label: "DidntKnowIWantedThat（新奇发现）" },
            { value: "gadgets", label: "gadgets（数码产品）" },
            { value: "amazonfinds", label: "amazonfinds（亚马逊好物）" },
          ] },
      ],
    },
    monitor: {
      // 特例：urls 直抓帖子 + includeComments 单任务带回评论（无独立评论任务）
      metricsActorId: "automation-lab/reddit-scraper",
      reviewActorId: "automation-lab/reddit-scraper",
      reviewCreditsPerResult: 1,
      reviewMaxPerTask: 200,
    },
  },
  x: {
    key: "x",
    label: "X（Twitter）",
    category: "social",
    marketActorId: "xquik/x-tweet-scraper",
    creditsPerResult: 1,
    maxResultsPerTask: 1000,
    defaultResults: 100,
    minResults: 1,
    resultKind: "post",
    fields: [],
    discover: {
      actorId: "xquik/x-tweet-scraper",
      label: "关键词热议",
      description: "按关键词抓取推文（互动数据），验证话题讨论热度。",
      resultKind: "post",
      creditsPerResult: 1,
      fields: [],
    },
    monitor: {
      // 同一 Actor 双模式：startUrls 直抓原推 / replyTweetIds 抓回复
      metricsActorId: "xquik/x-tweet-scraper",
      reviewActorId: "xquik/x-tweet-scraper",
      reviewCreditsPerResult: 1,
      reviewMaxPerTask: 200,
    },
  },
  facebook: {
    key: "facebook",
    label: "Facebook",
    category: "social",
    marketActorId: "scraper_one/facebook-posts-search",
    creditsPerResult: 5,
    maxResultsPerTask: 200,
    defaultResults: 50,
    minResults: 1,
    resultKind: "post",
    fields: [],
    discover: {
      actorId: "scraper_one/facebook-posts-search",
      label: "关键词帖子",
      description: "按关键词搜索公开帖子（互动数据），发现社群需求信号。",
      resultKind: "post",
      creditsPerResult: 5,
      fields: [],
    },
    monitor: {
      // 重抓/评论换 apify 官方双件（14.5 万/7.4 万用户；市场搜索仍走 scraper_one 关键词入口）
      metricsActorId: "apify/facebook-posts-scraper",
      reviewActorId: "apify/facebook-comments-scraper",
      reviewCreditsPerResult: 2,
      reviewMaxPerTask: 100,
    },
  },
}

/** 任务计费费率（发现模式可覆盖；评论任务走 monitor.reviewCreditsPerResult；按次计费的指标重抓走 monitor.metricsCreditsPerRun） */
export function creditsPerResultFor(
  platform: SelectionPlatform,
  taskType: "discover" | "market" | "monitor" | "review",
): number {
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  if (taskType === "discover" && cfg.discover?.creditsPerResult != null) {
    return cfg.discover.creditsPerResult
  }
  if (taskType === "review" && cfg.monitor) {
    return cfg.monitor.reviewCreditsPerResult
  }
  if (taskType === "monitor" && cfg.monitor?.metricsCreditsPerRun != null) {
    return cfg.monitor.metricsCreditsPerRun
  }
  return cfg.creditsPerResult
}

/** 该平台可加入竞品监控（有指标重抓或评论抓取任一能力） */
export function isMonitorablePlatform(platform: SelectionPlatform): boolean {
  const m = SELECTION_PLATFORM_CONFIGS[platform].monitor
  return Boolean(m && (m.metricsActorId || m.reviewActorId))
}

/**
 * 该平台的评论随指标重抓任务一并带回（单任务带回，不另建独立 review 任务、
 * 不单独计评论费）。服务端建任务与「添加监控」弹窗的费用预估共用，避免两处
 * 特判漂移。当前仅 reddit（urls + includeComments）。
 */
export function hasInlineReviews(platform: SelectionPlatform): boolean {
  return platform === "reddit"
}

/** 积分预估（表单实时显示/提交时预扣共用口径） */
export function estimateCredits(
  platform: SelectionPlatform,
  taskType: "discover" | "market" | "monitor" | "review",
  maxResults: number,
): number {
  return Math.max(1, maxResults) * creditsPerResultFor(platform, taskType)
}

/**
 * 某平台某任务类型的结果数上下限与默认值（表单范围与提交钳制共用；发现模式
 * 未单独声明时沿用平台级配置）
 */
export function resultLimitsFor(
  platform: SelectionPlatform,
  taskType: "discover" | "market",
): { min: number; max: number; default: number } {
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  const d = taskType === "discover" ? cfg.discover : undefined
  return {
    min: d?.minResults ?? cfg.minResults,
    max: d?.maxResultsPerTask ?? cfg.maxResultsPerTask,
    default: d?.defaultResults ?? cfg.defaultResults,
  }
}

/** 每用户每日任务数上限（全局常量；后续需要可挪到权限组/企业配置） */
export const SELECTION_DAILY_TASK_LIMIT = 30

/**
 * 详情弹窗「抓取评论」的默认条数：评论类 actor 多有每次运行最低消费
 * （Amazon 免费版 $0.50/次），条数太少不划算，默认取 50 条。
 */
export const SELECTION_REVIEW_SCRAPE_DEFAULT_MAX = 50

/**
 * 组装完整表单字段（含主输入）：市场模式统一关键词开头（Shopify 例外=店铺
 * 域名），发现模式主输入由各模式声明（Amazon=榜单品类、Reddit=版块，带 primary
 * 标记；兼容旧的 categoryUrl/subreddit 键），未声明主输入的话题类平台补一个关键词框。
 */
export function getFormFields(
  platform: SelectionPlatform,
  taskType: "discover" | "market",
): PlatformField[] {
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  if (taskType === "discover" && cfg.discover) {
    const hasPrimary = cfg.discover.fields.some(
      (f) => f.primary || ["categoryUrl", "subreddit"].includes(f.key),
    )
    if (hasPrimary) return cfg.discover.fields
    const optional = platform === "pinterest"
    return [
      {
        key: "keyword",
        label: optional ? "关键词（可选，留空看全榜）" : "关键词",
        type: "text",
        required: !optional,
        placeholder: "如 phone case",
      },
      ...cfg.discover.fields,
    ]
  }
  if (platform === "shopify") {
    return [
      { key: "domain", label: "店铺域名", type: "text", required: true, placeholder: "如 allbirds.com" },
      ...cfg.fields,
    ]
  }
  return [
    { key: "keyword", label: "关键词", type: "text", required: true, placeholder: "如 phone case" },
    ...cfg.fields,
  ]
}

/** 单任务关键词等文本字段长度上限 */
export const SELECTION_KEYWORD_MAX_LEN = 255

export function isSelectionPlatform(v: string): v is SelectionPlatform {
  return (SELECTION_PLATFORMS as readonly string[]).includes(v)
}

/**
 * 从表单参数解析任务国家（ISO 码大写；无国家概念的平台返回 null）。
 * 提交时快照到 selection_task.country，入库时传播到 selection_result.country。
 * field 取值缺失时回落该字段的注册表默认值（如 Amazon 榜单默认美国站）。
 */
export function countryFor(
  platform: SelectionPlatform,
  taskType: "discover" | "market",
  params: Record<string, unknown>,
): string | null {
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  const source =
    taskType === "discover" ? (cfg.discover?.countrySource ?? cfg.countrySource) : cfg.countrySource
  if (!source) return null
  if (source.fixed) return source.fixed
  if (source.field) {
    const v = params[source.field]
    if (typeof v === "string" && v.trim()) return v.trim().toUpperCase()
    const fields = taskType === "discover" ? (cfg.discover?.fields ?? []) : cfg.fields
    const fallback = fields.find((f) => f.key === source.field)?.defaultValue
    if (typeof fallback === "string" && fallback.trim()) return fallback.trim().toUpperCase()
  }
  return null
}

/** 国家码 → 中文名（卡片徽章 Tooltip /筛选项展示用；未知码原样显示） */
export const SELECTION_COUNTRY_LABELS: Record<string, string> = {
  US: "美国",
  UK: "英国",
  GB: "英国",
  CA: "加拿大",
  AU: "澳大利亚",
  DE: "德国",
  FR: "法国",
  IT: "意大利",
  ES: "西班牙",
  JP: "日本",
  MX: "墨西哥",
  BR: "巴西",
}

export function countryLabel(code: string | null | undefined): string {
  if (!code) return ""
  return SELECTION_COUNTRY_LABELS[code.toUpperCase()] ?? code
}
