import { describe, it, expect } from "vitest"
import { buildActorInput } from "@/lib/selection/input-builders"

/**
 * 入参构建器单测：映射形状对齐 2026-11-19 试抓实证的 Actor 输入约束
 * （Etsy min30 / TEMU region 小写 / Shopify 域名对象 / hashtag 去 #）。
 */

describe("市场分析入参", () => {
  it("amazon：searchQueries + 价格区间", () => {
    const b = buildActorInput({
      platform: "amazon",
      taskType: "market",
      params: { keyword: "earbuds", country: "DE", minPrice: 10, maxPrice: 50 },
      maxResults: 100,
    })
    expect(b.actorId).toBe("santamaria-automations/amazon-search-scraper")
    expect(b.runInput).toEqual({
      searchQueries: ["earbuds"],
      maxResultsPerQuery: 100,
      country: "DE",
      minPrice: 10,
      maxPrice: 50,
    })
    expect(b.keyword).toBe("earbuds")
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
  it("amazon：Best Sellers 榜单 URL + count", () => {
    const b = buildActorInput({
      platform: "amazon",
      taskType: "discover",
      params: { categoryUrl: "https://www.amazon.com/gp/bestsellers/electronics" },
      maxResults: 60,
    })
    expect(b.actorId).toBe("curious_coder/amazon-scraper")
    expect(b.runInput).toEqual({
      urls: [{ url: "https://www.amazon.com/gp/bestsellers/electronics" }],
      count: 60,
    })
    expect(b.keyword).toBe("消费电子")
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
