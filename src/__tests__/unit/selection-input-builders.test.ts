import { describe, it, expect } from "vitest"
import { buildActorInput } from "@/lib/selection/input-builders"

/**
 * 入参构建器单测：映射形状对齐 2026-11-19 试抓实证的 Actor 输入约束
 * （Etsy min30 / TEMU region 小写 / Shopify 域名对象 / hashtag 去 #）。
 */

describe("市场分析入参", () => {
  it("amazon：junglee/Amazon-crawler 搜索 URL 入口（站点决定域名、价格区间进 URL）", () => {
    const b = buildActorInput({
      platform: "amazon",
      taskType: "market",
      params: { keyword: "earbuds", country: "DE", minPrice: 10, maxPrice: 50 },
      maxResults: 100,
    })
    expect(b.actorId).toBe("junglee/Amazon-crawler")
    // 不传 countryCode/zipCode（配送地定位每条多 $0.06）；不抓 offers / sellers
    expect(b.runInput).toEqual({
      categoryOrProductUrls: [
        { url: "https://www.amazon.de/s?k=earbuds&low-price=10&high-price=50" },
      ],
      maxItemsPerStartUrl: 100,
      scrapeProductDetails: true,
      maxOffers: 0,
      scrapeSellers: false,
    })
    expect(b.keyword).toBe("earbuds")
    expect(b.country).toBe("DE")
  })

  it("amazon 市场：非法站点回落美国，无价格区间则不带价格参数", () => {
    const b = buildActorInput({
      platform: "amazon",
      taskType: "market",
      params: { keyword: "phone case", country: "XX" },
      maxResults: 30,
    })
    expect((b.runInput.categoryOrProductUrls as Array<{ url: string }>)[0]!.url).toBe(
      "https://www.amazon.com/s?k=phone+case",
    )
    expect(b.country).toBeNull()
  })

  it("etsy：结果数下限 30、关详情富化（计费红线）", () => {
    const b = buildActorInput({
      platform: "etsy",
      taskType: "market",
      params: { keyword: "mug" },
      maxResults: 10, // 低于 Actor 最小 30 → 抬到 30
    })
    expect(b.runInput).toMatchObject({
      searchQueries: ["mug"],
      maxListings: 30,
      enrichWithDetails: false,
    })
  })

  it("temu：CRW actor 入参（keyword/region US/sort/max_items ≤100）", () => {
    const b = buildActorInput({
      platform: "temu",
      taskType: "market",
      params: { keyword: "phone case", sort: "top_sales" },
      maxResults: 500, // 超过 CRW 上限 100 → 钳到 100
    })
    expect(b.actorId).toBe("crw/temu-products-scraper")
    expect(b.runInput).toEqual({
      keyword: "phone case",
      region: "US",
      sort: "top_sales",
      max_items: 100,
    })
    expect(b.country).toBe("US")
  })

  it("shopify：域名归一化（剥协议/路径）+ 对象数组 startUrls", () => {
    const b = buildActorInput({
      platform: "shopify",
      taskType: "market",
      params: { domain: "https://www.allbirds.com/products/x", query: "shoes" },
      maxResults: 20,
    })
    expect(b.runInput).toMatchObject({
      startUrls: [{ url: "https://www.allbirds.com" }],
      maxRequestsPerCrawl: 20,
      query: "shoes",
    })
    expect(b.keyword).toBe("www.allbirds.com")
  })

  it("instagram：hashtag 去 # 前缀", () => {
    const b = buildActorInput({
      platform: "instagram",
      taskType: "market",
      params: { keyword: "#phonecase" },
      maxResults: 30,
    })
    expect(b.runInput).toEqual({ hashtags: ["phonecase"], resultsLimit: 30 })
  })

  it("reddit：排序/时间窗透传", () => {
    const b = buildActorInput({
      platform: "reddit",
      taskType: "market",
      params: { keyword: "gadget", sort: "top", timeFilter: "week" },
      maxResults: 80,
    })
    expect(b.runInput).toMatchObject({ sort: "top", timeFilter: "week" })
  })
})

describe("发现页入参", () => {
  it("amazon：junglee/amazon-bestsellers 畅销榜（站点 × 品类，带详情，超时放宽）", () => {
    const b = buildActorInput({
      platform: "amazon",
      taskType: "discover",
      params: { listType: "bestsellers", country: "US", category: "electronics" },
      maxResults: 60,
    })
    expect(b.actorId).toBe("junglee/amazon-bestsellers")
    expect(b.runInput).toEqual({
      categoryUrls: ["https://www.amazon.com/gp/bestsellers/electronics"],
      maxItemsPerStartUrl: 60,
      depthOfCrawl: 1,
      detailedInformation: true,
    })
    expect(b.keyword).toBe("畅销榜·美国·消费电子")
    expect(b.country).toBe("US")
    expect(b.timeoutSecs).toBe(1500)
  })

  it("amazon：新品榜 + 英国站，条数钳到每类目硬上限 100", () => {
    const b = buildActorInput({
      platform: "amazon",
      taskType: "discover",
      params: { listType: "new-releases", country: "UK", category: "kitchen" },
      maxResults: 500,
    })
    expect(b.runInput).toMatchObject({
      categoryUrls: ["https://www.amazon.co.uk/gp/new-releases/kitchen"],
      maxItemsPerStartUrl: 100,
    })
    expect(b.keyword).toBe("新品榜·英国·厨房餐厅")
    expect(b.country).toBe("UK")
  })

  it("amazon 榜单：站点 × 品类不在实测支持矩阵内 → 抛错（飙升榜 / 德国站同理）", () => {
    // 英国站没有运动户外榜单
    expect(() =>
      buildActorInput({
        platform: "amazon",
        taskType: "discover",
        params: { listType: "bestsellers", country: "UK", category: "sporting-goods" },
        maxResults: 10,
      }),
    ).toThrow(/暂不支持/)
    // 德国站榜单 actor 不识别
    expect(() =>
      buildActorInput({
        platform: "amazon",
        taskType: "discover",
        params: { listType: "bestsellers", country: "DE", category: "electronics" },
        maxResults: 10,
      }),
    ).toThrow(/暂不支持/)
    // 飙升榜实测不支持
    expect(() =>
      buildActorInput({
        platform: "amazon",
        taskType: "discover",
        params: { listType: "movers-and-shakers", country: "US", category: "electronics" },
        maxResults: 10,
      }),
    ).toThrow(/暂不支持/)
  })

  it("temu：销量榜 discover 与市场共用 CRW actor，sort 固定 top_sales", () => {
    const b = buildActorInput({
      platform: "temu",
      taskType: "discover",
      params: { keyword: "kitchen" },
      maxResults: 100,
    })
    expect(b.actorId).toBe("crw/temu-products-scraper")
    expect(b.runInput).toEqual({
      keyword: "kitchen",
      region: "US",
      sort: "top_sales",
      max_items: 100,
    })
    expect(b.country).toBe("US")
  })

  it("country 传播：amazon 市场取站点值，社媒平台为 null", () => {
    const de = buildActorInput({
      platform: "amazon",
      taskType: "market",
      params: { keyword: "mug", country: "DE" },
      maxResults: 30,
    })
    expect(de.country).toBe("DE")
    const social = buildActorInput({
      platform: "tiktok",
      taskType: "market",
      params: { keyword: "mug" },
      maxResults: 30,
    })
    expect(social.country).toBe(null)
  })

  it("pinterest：趋势榜模式，关键词可选", () => {
    const withKw = buildActorInput({
      platform: "pinterest",
      taskType: "discover",
      params: { keyword: "gift", trendsRegion: "US", trendsType: "growing" },
      maxResults: 50,
    })
    expect(withKw.runInput).toMatchObject({
      operationMode: "pinterestTrends",
      trendsKeywords: ["gift"],
    })
    const noKw = buildActorInput({
      platform: "pinterest",
      taskType: "discover",
      params: {},
      maxResults: 50,
    })
    expect(noKw.runInput).not.toHaveProperty("trendsKeywords")
    expect(noKw.keyword).toBe("Pinterest 趋势榜")
  })

  it("reddit：版块热帖 sort=hot", () => {
    const b = buildActorInput({
      platform: "reddit",
      taskType: "discover",
      params: { subreddit: "BuyItForLife" },
      maxResults: 40,
    })
    expect(b.actorId).toBe("clearpath/reddit-subreddit-posts-scraper")
    expect(b.runInput).toMatchObject({ subreddit: "BuyItForLife", sort: "hot" })
  })

  it("shopify：店铺发现 query + maxItems", () => {
    const b = buildActorInput({
      platform: "shopify",
      taskType: "discover",
      params: { keyword: "pet supplies" },
      maxResults: 30,
    })
    expect(b.actorId).toBe("igolaizola/shopify-store-finder")
    expect(b.runInput).toEqual({ query: "pet supplies", maxItems: 30 })
  })
})
