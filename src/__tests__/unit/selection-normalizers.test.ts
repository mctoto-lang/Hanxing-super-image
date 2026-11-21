import { describe, it, expect } from "vitest"
import { normalizeSelectionItem, parseCountText } from "@/lib/selection/normalizers"

/**
 * 归一化器单测：字段映射依据 2026-11-19 各 Actor 实际试抓的输出结构；
 * 防御式语义：字段缺失时统一列置 null、永不抛错。
 */

describe("parseCountText", () => {
  it("解析 K/M/W/加号后缀", () => {
    expect(parseCountText("1.2K+")).toBe(1200)
    expect(parseCountText("10K+")).toBe(10000)
    expect(parseCountText("3M")).toBe(3_000_000)
    expect(parseCountText("2W+")).toBe(20000)
    expect(parseCountText("500+")).toBe(500)
    expect(parseCountText("1,234")).toBe(1234)
  })
  it("数字直通、非法输入为 null", () => {
    expect(parseCountText(456)).toBe(456)
    expect(parseCountText("abc")).toBeNull()
    expect(parseCountText("")).toBeNull()
    expect(parseCountText(null)).toBeNull()
  })
})

describe("市场分析平台映射", () => {
  it("amazon：price 对象取 value、purchaseVolumeText 解析销量、徽标进 tags", () => {
    const r = normalizeSelectionItem("amazon", "market", {
      asin: "B08XYZ",
      title: "Wireless Earbuds",
      url: "https://www.amazon.com/dp/B08XYZ",
      stars: 4.5,
      reviewsCount: 12345,
      price: { value: 29.99, currency: "USD" },
      listPrice: { value: 39.99 },
      purchaseVolumeText: "1K+ bought in past month",
      thumbnailImage: "https://m.media-amazon.com/x.jpg",
      brand: "Acme",
      isBestSeller: true,
    })
    expect(r.externalId).toBe("B08XYZ")
    expect(r.price).toBe("29.99")
    expect(r.originalPrice).toBe("39.99")
    expect(r.currency).toBe("USD")
    expect(r.rating).toBe("4.50")
    expect(r.salesCount).toBe(1000)
    expect(r.tags).toContain("Best Seller")
    expect(r.dedupeKey).toBe("id:B08XYZ")
  })

  it("temu：CRW actor 映射（goods_id/market_price/sales_num 文本/reduction_pct）", () => {
    const r = normalizeSelectionItem("temu", "market", {
      goods_id: 601099546324807,
      title: "Phone Case",
      price: 8.99,
      market_price: 17.98,
      currency: "USD",
      reduction_pct: 50,
      sales_num: "10K+",
      rating: 4.6,
      review_count: 1234,
      image_url: "https://img.temu.com/a.jpg",
      thumb_url: "https://img.temu.com/a_t.jpg",
      link_url: "https://www.temu.com/goods.html",
      adult_goods: false,
    })
    expect(r.externalId).toBe("601099546324807")
    expect(r.dedupeKey).toBe("id:601099546324807")
    expect(r.sourceUrl).toBe("https://www.temu.com/goods.html")
    expect(r.price).toBe("8.99")
    expect(r.originalPrice).toBe("17.98")
    expect(r.salesCount).toBe(10000)
    expect(r.reviewCount).toBe(1234)
    expect(r.rating).toBe("4.60")
    expect(r.images).toEqual(["https://img.temu.com/a.jpg"])
    expect(r.tags).toContain("降50%")
    // 发现（销量榜）与市场共用 CRW 映射
    const d = normalizeSelectionItem("temu", "discover", {
      goods_id: 2,
      price: 1,
      sales_num: "3M",
      title: "x",
    })
    expect(d.salesCount).toBe(3_000_000)
    expect(d.dedupeKey).toBe("id:2")
  })

  it("etsy：listing_id 数字转字符串、畅销徽标", () => {
    const r = normalizeSelectionItem("etsy", "market", {
      listing_id: 123456,
      title: "Handmade Necklace",
      price_num: 19.99,
      currency_code: "USD",
      rating: 4.8,
      review_count: 500,
      favorites: 2300,
      shop_name: "CraftShop",
      image_url: "https://i.etsystatic.com/x.jpg",
      detail_url: "https://www.etsy.com/listing/123456",
      is_bestseller: true,
    })
    expect(r.externalId).toBe("123456")
    expect(r.likesCount).toBe(2300)
    expect(r.sellerName).toBe("CraftShop")
    expect(r.tags).toContain("畅销")
  })

  it("instagram：caption→content、互动列、ISO 时间", () => {
    const r = normalizeSelectionItem("instagram", "market", {
      id: "ig-1",
      url: "https://www.instagram.com/p/abc/",
      caption: "Love this case #phonecase",
      likesCount: 1200,
      commentsCount: 34,
      timestamp: "2026-11-01T00:00:00Z",
      displayUrl: "https://scontent.xx/a.jpg",
      hashtags: ["phonecase"],
    })
    expect(r.content).toContain("Love this case")
    expect(r.likesCount).toBe(1200)
    expect(r.publishedAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z")
    expect(r.hashtags).toEqual(["phonecase"])
  })

  it("tiktok：diggCount→点赞、authorMeta 嵌套", () => {
    const r = normalizeSelectionItem("tiktok", "market", {
      id: "tt-1",
      text: "viral gadget",
      webVideoUrl: "https://www.tiktok.com/@a/video/1",
      diggCount: 5000,
      commentCount: 100,
      shareCount: 50,
      playCount: 90000,
      createTimeISO: "2026-11-10T10:00:00Z",
      authorMeta: { nickName: "Creator", fans: 100000 },
      videoMeta: { coverUrl: "https://p16.xx/cover.jpg" },
    })
    expect(r.likesCount).toBe(5000)
    expect(r.viewsCount).toBe(90000)
    expect(r.sellerName).toBe("Creator")
  })

  it("reddit：permalink 拼接、score→点赞", () => {
    const r = normalizeSelectionItem("reddit", "market", {
      id: "rd-1",
      title: "Best phone case?",
      permalink: "/r/BuyItForLife/abc/",
      score: 300,
      numComments: 45,
      createdAt: "2026-11-05T00:00:00Z",
      subreddit: "BuyItForLife",
    })
    expect(r.sourceUrl).toBe("https://www.reddit.com/r/BuyItForLife/abc/")
    expect(r.likesCount).toBe(300)
    expect(r.category).toBe("BuyItForLife")
  })

  it("x：互动四列 + 作者", () => {
    const r = normalizeSelectionItem("x", "market", {
      id: "x-1",
      text: "just bought this",
      url: "https://x.com/a/status/1",
      likeCount: 88,
      replyCount: 9,
      retweetCount: 12,
      viewCount: 4000,
      createdAt: "2026-11-12T00:00:00Z",
      author: { username: "gadgetfan", isBlueVerified: true },
    })
    expect(r.likesCount).toBe(88)
    expect(r.sharesCount).toBe(12)
    expect(r.viewsCount).toBe(4000)
    expect(r.tags).toContain("蓝标")
  })

  it("shopify：price.current 兼容 number 与对象", () => {
    const obj = normalizeSelectionItem("shopify", "market", {
      title: "Wool Runner",
      source: { id: "123", canonicalUrl: "https://allbirds.com/p/1", currency: "USD" },
      price: { current: 98 },
      brand: "Allbirds",
      medias: [{ url: "https://cdn.x/1.jpg" }],
    })
    expect(obj.price).toBe("98.00")
    expect(obj.images).toEqual(["https://cdn.x/1.jpg"])
  })
})

describe("发现页模式映射", () => {
  it("shopify 店铺发现：规模/地区标签", () => {
    const r = normalizeSelectionItem("shopify", "discover", {
      title: "Gadget Store",
      url: "https://gadgetstore.com",
      currency: "USD",
      country: "US",
      minProductCount: 100,
      maxProductCount: 500,
      emails: ["a@b.com"],
    })
    expect(r.title).toBe("Gadget Store")
    expect(r.tags).toContain("地区 US")
    expect(r.tags).toContain("商品数 100~500")
  })

  it("etsy 趋势追踪：trending_score 标签", () => {
    const r = normalizeSelectionItem("etsy", "discover", {
      listing_id: 999,
      title: "Trending Mug",
      price: 25,
      currency: "USD",
      favorites: 800,
      trending_score: 92,
      favorites_per_day: 15,
      url: "https://www.etsy.com/listing/999",
      shop_name: "MugShop",
    })
    expect(r.tags).toContain("热度 92")
    expect(r.tags).toContain("日均收藏 15")
  })

  it("归一化永不抛错：空对象", () => {
    const r = normalizeSelectionItem("amazon", "market", {})
    expect(r.title).toBeNull()
    expect(r.price).toBeNull()
    expect(r.dedupeKey).toMatch(/^fp:/)
  })
})
