import { describe, it, expect } from "vitest"
import { buildActorInput } from "@/lib/selection/input-builders"
import {
  SELECTION_PLATFORM_CONFIGS,
  creditsPerResultFor,
  isMonitorablePlatform,
} from "@/lib/selection/platforms"
import {
  isActorErrorRow,
  isRedditCommentRow,
  normalizeReviewItem,
  normalizeSelectionItem,
} from "@/lib/selection/normalizers"

/**
 * 竞品监控单元测试（0106）：monitor/review 入参形状 + 能力矩阵 +
 * 新增 normalizer（pinterest 新 actor / IG、FB 官方帖子 actor / 评论归一化）。
 */

describe("平台监控能力矩阵", () => {
  it("10 个平台全部支持监控（2026-11-24 TEMU 接入单品详情 actor）", () => {
    for (const p of [
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
    ] as const) {
      expect(isMonitorablePlatform(p)).toBe(true)
    }
    // Etsy 无指标重抓入口（仅评论）
    expect(SELECTION_PLATFORM_CONFIGS.etsy.monitor?.metricsActorId).toBeNull()
    expect(SELECTION_PLATFORM_CONFIGS.etsy.monitor?.reviewActorId).toBeTruthy()
    // TEMU：hypebridge 单品详情，无评论能力
    expect(SELECTION_PLATFORM_CONFIGS.temu.monitor?.metricsActorId).toBe("hypebridge/temu-scraper")
    expect(SELECTION_PLATFORM_CONFIGS.temu.monitor?.reviewActorId).toBeNull()
  })

  it("指标重抓费率：TEMU 按次 10 分（用户拍板），其余沿用市场费率", () => {
    expect(creditsPerResultFor("temu", "monitor")).toBe(10)
    expect(creditsPerResultFor("amazon", "monitor")).toBe(2)
    expect(creditsPerResultFor("etsy", "market")).toBe(3)
  })

  it("评论任务费率取 monitor.reviewCreditsPerResult", () => {
    expect(creditsPerResultFor("amazon", "review")).toBe(2)
    expect(creditsPerResultFor("amazon", "monitor")).toBe(2) // 沿用市场费率
    expect(creditsPerResultFor("etsy", "review")).toBe(3)
  })
})

describe("监控/评论入参组装", () => {
  const base = {
    params: {
      targetUrl: "https://example.com/x",
      externalId: "ID1",
      keyword: "目标",
      country: "us",
    },
  }

  const asinParams = {
    targetUrl: "https://www.amazon.com/gp/product/B0BTYDLTM3?smid=A294P4X9EWVXLJ",
    externalId: "B0BTYDLTM3",
    keyword: "目标",
    country: "us",
  }

  it("amazon：monitor=ASIN 直抓（规范商品链接），review=对象数组+sort", () => {
    const m = buildActorInput({ ...base, params: asinParams, platform: "amazon", taskType: "monitor", maxResults: 1 })
    expect(m.actorId).toBe("junglee/amazon-asins-scraper")
    expect(m.runInput).toEqual({ asins: ["B0BTYDLTM3"], amazonDomain: "amazon.com" })
    expect(m.country).toBe("US")
    // 轻量任务申请 1GB 运行内存（账户并发内存上限 16GB，actor 默认各要 4GB）
    expect(m.memoryMB).toBe(1024)

    // 周期监控抓最新评论；链接按 ASIN 规范化成 /dp/ 短链
    const r = buildActorInput({ ...base, params: asinParams, platform: "amazon", taskType: "review", maxResults: 30 })
    expect(r.actorId).toBe("junglee/amazon-reviews-scraper")
    // productUrls 必须是 [{url}] 对象数组（字符串数组会被入参校验拒绝）
    expect(r.runInput).toEqual({
      productUrls: [{ url: "https://www.amazon.com/dp/B0BTYDLTM3" }],
      maxReviews: 30,
      sort: "recent",
    })
    // 一次性抓评论取「最有用」
    expect(
      buildActorInput({
        ...base,
        params: { ...asinParams, reviewSort: "helpful" },
        platform: "amazon",
        taskType: "review",
        maxResults: 30,
      }).runInput,
    ).toMatchObject({ sort: "helpful" })
    // 德国站：域名随站点
    expect(
      buildActorInput({
        ...base,
        params: { ...asinParams, country: "DE" },
        platform: "amazon",
        taskType: "monitor",
        maxResults: 1,
      }).runInput,
    ).toEqual({ asins: ["B0BTYDLTM3"], amazonDomain: "amazon.de" })
  })

  it("amazon 监控：缺 externalId 时从链接解析 ASIN，解析不出则抛错", () => {
    const fromUrl = buildActorInput({
      ...base,
      params: { ...asinParams, externalId: "" },
      platform: "amazon",
      taskType: "monitor",
      maxResults: 1,
    })
    expect(fromUrl.runInput).toEqual({ asins: ["B0BTYDLTM3"], amazonDomain: "amazon.com" })
    expect(() =>
      buildActorInput({
        ...base,
        params: { ...asinParams, externalId: "", targetUrl: "https://www.amazon.com/s?k=earbuds" },
        platform: "amazon",
        taskType: "monitor",
        maxResults: 1,
      }),
    ).toThrow(/ASIN/)
  })

  it("temu：monitor=hypebridge 商品页直抓（追踪参数清洗成规范链接），按次计费", () => {
    const m = buildActorInput({
      ...base,
      params: {
        targetUrl: "https://www.temu.com/goods.html?_bg_fs=1&goods_id=601099837209625&_oak_mp_inf=EJn",
        externalId: "601099837209625",
        keyword: "目标",
        country: "US",
      },
      platform: "temu",
      taskType: "monitor",
      maxResults: 1,
    })
    expect(m.actorId).toBe("hypebridge/temu-scraper")
    expect(m.runInput).toEqual({
      startUrls: [{ url: "https://www.temu.com/goods.html?goods_id=601099837209625" }],
      maxItems: 1,
      getProductDetails: true,
    })
    expect(m.memoryMB).toBe(1024)
    // TEMU 无评论能力：review 抛错
    expect(() =>
      buildActorInput({ ...base, platform: "temu", taskType: "review", maxResults: 10 }),
    ).toThrow(/无评论抓取能力/)
  })

  it("tiktok：postURLs 直抓 + comments 专用 actor", () => {
    const m = buildActorInput({ ...base, platform: "tiktok", taskType: "monitor", maxResults: 1 })
    expect(m.actorId).toBe("clockworks/tiktok-scraper")
    expect(m.runInput).toEqual({ postURLs: [base.params.targetUrl], resultsPerPage: 1 })

    const r = buildActorInput({ ...base, platform: "tiktok", taskType: "review", maxResults: 100 })
    expect(r.actorId).toBe("clockworks/tiktok-comments-scraper")
    expect(r.runInput).toEqual({ postURLs: [base.params.targetUrl], commentsPerPost: 100 })
  })

  it("reddit：monitor 单任务 includeComments；不产 review 分流", () => {
    const m = buildActorInput({
      ...base,
      platform: "reddit",
      taskType: "monitor",
      maxResults: 1,
      params: { ...base.params, reviewMax: 80 },
    })
    expect(m.actorId).toBe("automation-lab/reddit-scraper")
    expect(m.runInput).toMatchObject({ urls: [base.params.targetUrl], includeComments: true, maxCommentsPerPost: 80 })
  })

  it("x：review 走 replyTweetIds（externalId 优先）", () => {
    const r = buildActorInput({ ...base, platform: "x", taskType: "review", maxResults: 50 })
    expect(r.actorId).toBe("xquik/x-tweet-scraper")
    expect(r.runInput).toEqual({ replyTweetIds: ["ID1"], maxItems: 50 })
  })

  it("facebook/instagram/pinterest/shopify 形状", () => {
    expect(
      buildActorInput({ ...base, platform: "facebook", taskType: "monitor", maxResults: 1 })
        .runInput,
    ).toEqual({ startUrls: [base.params.targetUrl], resultsLimit: 1 })
    expect(
      buildActorInput({ ...base, platform: "instagram", taskType: "monitor", maxResults: 1 })
        .runInput,
    ).toEqual({ resultsType: "posts", directUrls: [base.params.targetUrl], resultsLimit: 1 })
    expect(
      buildActorInput({ ...base, platform: "pinterest", taskType: "monitor", maxResults: 1 })
        .runInput,
    ).toEqual({ pinUrls: [base.params.targetUrl], maxPins: 1 })
    expect(
      buildActorInput({ ...base, platform: "shopify", taskType: "monitor", maxResults: 1 })
        .runInput,
    ).toEqual({ startUrls: [{ url: base.params.targetUrl }], maxRequestsPerCrawl: 1 })
  })

  it("Etsy 无指标重抓：monitor 抛错；review 走 listing URL", () => {
    expect(() =>
      buildActorInput({ ...base, platform: "etsy", taskType: "monitor", maxResults: 1 }),
    ).toThrow(/无指标重抓能力/)
    const r = buildActorInput({ ...base, platform: "etsy", taskType: "review", maxResults: 40 })
    expect(r.runInput).toEqual({ productUrls: [base.params.targetUrl], maxReviewsPerListing: 40 })
  })

  it("Pinterest 市场搜索换 automation-lab：searchQueries+maxPins", () => {
    const m = buildActorInput({
      platform: "pinterest",
      taskType: "market",
      params: { keyword: "phone case" },
      maxResults: 50,
    })
    expect(m.actorId).toBe("automation-lab/pinterest-scraper")
    expect(m.runInput).toEqual({ searchQueries: ["phone case"], maxPins: 50 })
  })
})

describe("监控/评论归一化", () => {
  it("pinterest 新 actor：saves/commentCount/image/publishedAt", () => {
    const n = normalizeSelectionItem("pinterest", "monitor", {
      id: "pin1",
      title: "Cozy mug",
      description: "desc",
      saves: 1200,
      commentCount: 34,
      image: "https://i.pinimg.com/a.jpg",
      publishedAt: "2026-11-01T00:00:00Z",
      pinner: { username: "pinner1" },
    })
    expect(n.externalId).toBe("pin1")
    expect(n.likesCount).toBe(1200)
    expect(n.commentsCount).toBe(34)
    expect(n.images).toEqual(["https://i.pinimg.com/a.jpg"])
    expect(n.sellerName).toBe("pinner1")
    expect(n.publishedAt).toBeTruthy()
  })

  it("IG 官方帖子 actor：likesCount/commentsCount/caption/短链回填", () => {
    const n = normalizeSelectionItem("instagram", "monitor", {
      id: "ig1",
      shortCode: "ABC123",
      caption: "nice post",
      likesCount: 50,
      commentsCount: 5,
      images: ["https://scontent.xx/a.jpg"],
      timestamp: 1730000000,
      owner: { username: "owner1" },
    })
    expect(n.sourceUrl).toBe("https://www.instagram.com/p/ABC123/")
    expect(n.likesCount).toBe(50)
    expect(n.sellerName).toBe("owner1")
    expect(n.images).toEqual(["https://scontent.xx/a.jpg"])
  })

  it("FB 官方帖子 actor：text/reactions/commentsCount", () => {
    const n = normalizeSelectionItem("facebook", "monitor", {
      postId: "fb1",
      url: "https://facebook.com/p/1",
      text: "post body",
      reactionsCount: 88,
      commentsCount: 12,
      timestamp: "2026-11-02T10:00:00Z",
      author: { name: "Page" },
    })
    expect(n.externalId).toBe("fb1")
    expect(n.likesCount).toBe(88)
    expect(n.content).toBe("post body")
  })

  it("评论归一化：junglee/amazon-reviews-scraper 真实出参（2026-11-24 实测）", () => {
    // 此前的夹具用的是编造键名（id/rating/reviewText），真实键是
    // reviewId/ratingScore/reviewDescription——旧归一化读不到，入库后正文与评分为空
    const r = normalizeReviewItem({
      reviewId: "RIW3PCEBL2M0",
      reviewTitle: "I bought a second pair",
      reviewDescription:
        "I really like the fact that you can control a lot of the functions from the case.",
      ratingScore: 5,
      date: "2026-11-21",
      isVerified: true,
      isAmazonVine: false,
      variant: "Color: White",
      reviewImages: [],
      reviewUrl: "https://www.amazon.com/gp/customer-reviews/RIW3PCEBL2M0",
      country: "United States",
    })
    expect(r).toMatchObject({
      externalId: "RIW3PCEBL2M0",
      dedupeKey: "id:RIW3PCEBL2M0",
      // 默认不含用户名（GDPR：includeGdprSensitive=false）
      authorName: null,
      rating: "5.00",
      content:
        "I really like the fact that you can control a lot of the functions from the case.",
      verified: true,
    })
    expect(r.publishedAt?.toISOString()).toContain("2026-11-21")
  })

  it("评论归一化：通用键名（id/rating/text）仍兼容", () => {
    const r = normalizeReviewItem({
      id: "rv1",
      rating: 4,
      text: "Good value",
      userName: "Alice",
      verified: true,
      helpfulVotes: 7,
    })
    expect(r).toMatchObject({
      externalId: "rv1",
      authorName: "Alice",
      rating: "4.00",
      content: "Good value",
      likesCount: 7,
      verified: true,
    })
  })

  it("Actor 错误记录行 / Reddit 评论独立行的识别", () => {
    // junglee 榜单对不支持的类目返回的记录
    expect(
      isActorErrorRow({
        error: "bestsellers_category_not_found",
        errorDescription: "Loaded invalid bestsellers category.",
        input: "https://www.amazon.com/gp/movers-and-shakers/electronics",
        url: "https://www.amazon.com/gp/movers-and-shakers/electronics",
      }),
    ).toBe(true)
    expect(isActorErrorRow(null)).toBe(true)
    expect(isActorErrorRow([1, 2])).toBe(true)
    // 正常行即使带 error 键（空串）也不是错误行
    expect(isActorErrorRow({ asin: "B0", title: "x", error: "" })).toBe(false)
    // automation-lab/reddit-scraper 把评论作为独立行与帖子混排
    expect(isRedditCommentRow({ type: "comment", id: "c1", body: "hi" })).toBe(true)
    expect(isRedditCommentRow({ type: "post", id: "p1" })).toBe(false)
    expect(isRedditCommentRow({ id: "x" })).toBe(false)
  })

  it("评论归一化：clockworks/TikTok 形状（authorMeta 嵌套 + diggCount）", () => {
    const r = normalizeReviewItem({
      commentId: "tc1",
      text: "lol",
      diggCount: 21,
      createTimeISO: "2026-11-05T08:00:00Z",
      authorMeta: { nickName: "凯" },
    })
    expect(r.externalId).toBe("tc1")
    expect(r.authorName).toBe("凯")
    expect(r.likesCount).toBe(21)
    expect(r.publishedAt?.toISOString()).toContain("2026-11-05")
  })

  it("评论归一化：reddit 嵌套形状（body/author/score/created_utc）", () => {
    const r = normalizeReviewItem({
      id: "rc1",
      body: "works great",
      author: "u_red",
      score: 9,
      created_utc: 1730000000,
    })
    expect(r.content).toBe("works great")
    expect(r.authorName).toBe("u_red")
    expect(r.likesCount).toBe(9)
  })

  it("评论归一化：无 ID 行回退指纹键（作者+正文）", () => {
    const r = normalizeReviewItem({ text: "匿名评论", name: "Zed" })
    expect(r.dedupeKey).toBe("fp:Zed|匿名评论")
  })
})
