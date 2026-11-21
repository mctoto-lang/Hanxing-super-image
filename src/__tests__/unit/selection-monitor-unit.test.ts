import { describe, it, expect } from "vitest"
import { buildActorInput } from "@/lib/selection/input-builders"
import {
  SELECTION_PLATFORM_CONFIGS,
  creditsPerResultFor,
  isMonitorablePlatform,
} from "@/lib/selection/platforms"
import {
  normalizeReviewItem,
  normalizeSelectionItem,
} from "@/lib/selection/normalizers"

/**
 * 竞品监控单元测试（0106）：monitor/review 入参形状 + 能力矩阵 +
 * 新增 normalizer（pinterest 新 actor / IG、FB 官方帖子 actor / 评论归一化）。
 */

describe("平台监控能力矩阵", () => {
  it("TEMU 不支持监控；其余 9 平台支持（Etsy 仅评论）", () => {
    expect(isMonitorablePlatform("temu")).toBe(false)
    for (const p of [
      "amazon",
      "etsy",
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
    // Etsy 无指标重抓入口
    expect(SELECTION_PLATFORM_CONFIGS.etsy.monitor?.metricsActorId).toBeNull()
    expect(SELECTION_PLATFORM_CONFIGS.etsy.monitor?.reviewActorId).toBeTruthy()
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

  it("amazon：monitor=urls 直抓，review=productUrls+maxReviews", () => {
    const m = buildActorInput({ ...base, platform: "amazon", taskType: "monitor", maxResults: 1 })
    expect(m.actorId).toBe("curious_coder/amazon-scraper")
    expect(m.runInput).toEqual({ urls: [{ url: base.params.targetUrl }], count: 1 })
    expect(m.country).toBe("US")

    const r = buildActorInput({ ...base, platform: "amazon", taskType: "review", maxResults: 30 })
    expect(r.actorId).toBe("junglee/amazon-reviews-scraper")
    expect(r.runInput).toEqual({ productUrls: [base.params.targetUrl], maxReviews: 30 })
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

  it("评论归一化：junglee/Amazon 形状", () => {
    const r = normalizeReviewItem({
      id: "rv1",
      rating: 4,
      reviewText: "Good value",
      userName: "Alice",
      verified: true,
      helpfulVotes: 7,
      date: "2026-11-01",
    })
    expect(r).toMatchObject({
      externalId: "rv1",
      dedupeKey: "id:rv1",
      authorName: "Alice",
      rating: "4.00",
      content: "Good value",
      likesCount: 7,
      verified: true,
    })
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
