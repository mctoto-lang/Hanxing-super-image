import { describe, it, expect } from "vitest"
import { normalizeReviewItem, normalizeSelectionItem, parseCountText } from "@/lib/selection/normalizers"

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
  it("中文单位千/万/亿按倍率解析，认不出的单位（B 等）返回 null 而非截断数字", () => {
    expect(parseCountText("1.2万")).toBe(12000)
    expect(parseCountText("2千")).toBe(2000)
    expect(parseCountText("1.5亿")).toBe(150_000_000)
    expect(parseCountText("1.5B")).toBeNull()
    expect(parseCountText("2千3")).toBeNull()
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

  it("temu：CRW actor 真实出参（price 为分、price_str 为元文本，降幅按价格推算）", () => {
    const r = normalizeSelectionItem("temu", "market", {
      goods_id: 601099546324807,
      title: "Phone Case",
      price: 899,
      price_str: "$8.99",
      market_price: 1798,
      market_price_str: "$17.98",
      currency: "USD",
      // reduction_pct 实测不是折扣率（乱值不影响标签，降幅按价格推算）
      reduction_pct: 5,
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
    expect(r.tags).not.toContain("降5%")
    // 无字符串价格时分数值除以 100；market_price 不大于 price 时划线价为 null 且不出降标签
    const centsOnly = normalizeSelectionItem("temu", "market", {
      goods_id: 1,
      title: "x",
      price: 121,
      market_price: 221,
    })
    expect(centsOnly.price).toBe("1.21")
    expect(centsOnly.originalPrice).toBe("2.21")
    expect(centsOnly.tags).toContain("降45%")
    const noDiscount = normalizeSelectionItem("temu", "market", {
      goods_id: 3,
      title: "y",
      price_str: "$9.99",
      market_price_str: "$9.99",
      reduction_pct: 30,
    })
    expect(noDiscount.price).toBe("9.99")
    expect(noDiscount.originalPrice).toBeNull()
    expect(noDiscount.tags?.some((t) => t.startsWith("降"))).toBeFalsy()
    const zeroMarket = normalizeSelectionItem("temu", "market", {
      goods_id: 4,
      title: "z",
      price_str: "$2.00",
      market_price: 0,
      reduction_pct: 0,
    })
    expect(zeroMarket.price).toBe("2.00")
    expect(zeroMarket.originalPrice).toBeNull()
    expect(zeroMarket.tags?.some((t) => t.startsWith("降"))).toBeFalsy()
    // 发现（销量榜）与市场共用 CRW 映射
    const d = normalizeSelectionItem("temu", "discover", {
      goods_id: 2,
      price: 100,
      sales_num: "3M",
      title: "x",
    })
    expect(d.price).toBe("1.00")
    expect(d.salesCount).toBe(3_000_000)
    expect(d.dedupeKey).toBe("id:2")
  })

  it("etsy：listing_id 数字转字符串、畅销徽标；discount_price 带 $ 文本生效、videos 进统一列", () => {
    const r = normalizeSelectionItem("etsy", "market", {
      listing_id: 123456,
      title: "Handmade Necklace",
      price_num: 19.99,
      discount_price: "$15.99",
      currency_code: "USD",
      rating: 4.8,
      review_count: 500,
      favorites: 2300,
      shop_name: "CraftShop",
      image_url: "https://i.etsystatic.com/x.jpg",
      detail_url: "https://www.etsy.com/listing/123456",
      is_bestseller: true,
      videos: ["https://v.etsystatic.com/c/video/upload/ac_none/x.mp4"],
    })
    expect(r.externalId).toBe("123456")
    // 促销价 "$15.99" 生效：入库价为折扣价、划线价为原价
    expect(r.price).toBe("15.99")
    expect(r.originalPrice).toBe("19.99")
    expect(r.likesCount).toBe(2300)
    expect(r.sellerName).toBe("CraftShop")
    expect(r.tags).toContain("畅销")
    expect(r.videos).toEqual(["https://v.etsystatic.com/c/video/upload/ac_none/x.mp4"])
    // discount_price 高于原价或为空时按原价入库、无划线价
    const noDiscount = normalizeSelectionItem("etsy", "market", {
      listing_id: 789,
      title: "Mug",
      price_num: 25,
      discount_price: "",
    })
    expect(noDiscount.price).toBe("25.00")
    expect(noDiscount.originalPrice).toBeNull()
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

describe("Amazon junglee 家族归一化（2026-11-24 实测出参）", () => {
  /** junglee/Amazon-crawler 关键词搜索 / amazon-asins-scraper 商品页同族出参 */
  const productRow = {
    asin: "B0BTYDLTM3",
    title: "soundcore by Anker P20i True Wireless Earbuds",
    url: "https://www.amazon.com/dp/B0BTYDLTM3",
    price: { value: 20.98, currency: "$" },
    listPrice: { value: 39.99, currency: "$" },
    stars: 4.4,
    reviewsCount: 120186,
    monthlyPurchaseVolume: "3K+ bought in past month",
    brand: "Soundcore",
    thumbnailImage: "https://m.media-amazon.com/images/I/51-3N5iu8uL._AC_SY300_SX300_.jpg",
    highResolutionImages: ["https://m.media-amazon.com/images/I/51-3N5iu8uL._SL1500_.jpg"],
    breadCrumbs: "Electronics > Headphones, Earbuds & Accessories > Earbud Headphones",
    bestsellerRanks: [
      { rank: 85, category: "Electronics", url: "https://www.amazon.com/gp/bestsellers/electronics" },
      { rank: 12, category: "Earbud & In-Ear Headphones", url: "https://www.amazon.com/x" },
    ],
    inStock: true,
    isAmazonChoice: true,
    seller: { name: "AnkerDirect", id: "A294P4X9EWVXLJ" },
    categoryPageData: { pageNumber: 1, productPosition: 4, isSponsored: false },
  }

  it("市场（关键词搜索）：币种符号 $ 推导为 USD，月购买量进销量，rank 取主类目 BSR", () => {
    const r = normalizeSelectionItem("amazon", "market", productRow)
    expect(r.externalId).toBe("B0BTYDLTM3")
    expect(r.dedupeKey).toBe("id:B0BTYDLTM3")
    expect(r.sourceUrl).toBe("https://www.amazon.com/dp/B0BTYDLTM3")
    expect(r.price).toBe("20.98")
    expect(r.originalPrice).toBe("39.99")
    expect(r.currency).toBe("USD")
    expect(r.rating).toBe("4.40")
    expect(r.reviewCount).toBe(120186)
    expect(r.salesCount).toBe(3000)
    expect(r.rank).toBe(85)
    expect(r.sellerName).toBe("Soundcore")
    expect(r.images).toHaveLength(2)
    expect(r.category).toBe("Electronics")
    expect(r.categoryPath).toEqual([
      "Electronics",
      "Headphones, Earbuds & Accessories",
      "Earbud Headphones",
    ])
    expect(r.tags).toContain("Amazon's Choice")
  })

  it("监控（ASIN 直抓）：同族出参，无划线价时 originalPrice 为 null", () => {
    const r = normalizeSelectionItem("amazon", "monitor", {
      asin: "B09K5PX8RH",
      title: "The Original Tarot Cards Deck",
      url: "https://www.amazon.com/gp/product/B09K5PX8RH?smid=A14TB69FQN4LAL",
      price: { value: 17.89, currency: "$" },
      listPrice: null,
      stars: 4.7,
      reviewsCount: 2180,
      monthlyPurchaseVolume: "900+ bought in past month",
      brand: "Vitacera",
      bestsellerRanks: [{ rank: 27, category: "Fortune Telling Toys", url: "https://x" }],
      shipsFrom: "Amazon.com",
    })
    expect(r.price).toBe("17.89")
    expect(r.originalPrice).toBeNull()
    expect(r.currency).toBe("USD")
    expect(r.salesCount).toBe(900)
    expect(r.rank).toBe(27)
    // 带卖家参数的长链接规范化成 /dp/ 短链
    expect(r.sourceUrl).toBe("https://www.amazon.com/dp/B09K5PX8RH")
  })

  it("榜单（畅销榜 / 新品榜）：rank 取榜单名次，英国站币种推导为 GBP", () => {
    const bsr = normalizeSelectionItem("amazon", "discover", {
      asin: "B0FQFB8FMG",
      title: "Apple AirPods Pro 3",
      url: "https://www.amazon.com/dp/B0FQFB8FMG",
      price: { value: 149, currency: "$" },
      listPrice: { value: 249, currency: "$" },
      stars: 4.4,
      reviewsCount: 18289,
      monthlyPurchaseVolume: "10K+ bought in past month",
      brand: "Apple",
      bestsellerPageData: { categoryName: "Electronics", position: 2 },
      bestsellerRanks: [{ rank: 1, category: "Earbud & In-Ear Headphones", url: "https://x" }],
    })
    // 榜单名次（2）优先于类目 BSR（1）
    expect(bsr.rank).toBe(2)
    expect(bsr.category).toBe("Electronics")
    expect(bsr.originalPrice).toBe("249.00")
    expect(bsr.salesCount).toBe(10000)

    // 纯榜单行（不带详情）：name / thumbnailUrl / position
    const listOnly = normalizeSelectionItem("amazon", "discover", {
      name: "Amazon Basics 20-Pack AA Alkaline Batteries",
      url: "https://www.amazon.co.uk/dp/B00NTCH52W",
      asin: "B00NTCH52W",
      position: 1,
      price: { value: 5.35, currency: "£" },
      numberOfOffers: null,
      stars: 4.6,
      reviewsCount: 944222,
      thumbnailUrl: "https://images-eu.ssl-images-amazon.com/images/I/81U2sRlmzNL._AC_UL300_SR300,200_.jpg",
      categoryName: "Electronics & Photo",
      categoryFullName: "Best Sellers in Electronics & Photo",
    })
    expect(listOnly.title).toBe("Amazon Basics 20-Pack AA Alkaline Batteries")
    expect(listOnly.rank).toBe(1)
    expect(listOnly.currency).toBe("GBP")
    expect(listOnly.price).toBe("5.35")
    expect(listOnly.images).toEqual([
      "https://images-eu.ssl-images-amazon.com/images/I/81U2sRlmzNL._AC_UL300_SR300,200_.jpg",
    ])
    // 无月购买量字段 → 销量 null（不臆造）
    expect(listOnly.salesCount).toBeNull()
  })

  it("兼容旧行（santamaria 搜索 / curious_coder 榜单）", () => {
    const oldSearch = normalizeSelectionItem("amazon", "market", {
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
      positionOverall: 3,
    })
    expect(oldSearch.price).toBe("29.99")
    expect(oldSearch.currency).toBe("USD")
    expect(oldSearch.salesCount).toBe(1000)
    expect(oldSearch.tags).toContain("Best Seller")
    expect(oldSearch.rank).toBe(3)

    const oldBsr = normalizeSelectionItem("amazon", "monitor", {
      asin: "B0OLD00001",
      title: "Old bestseller row",
      link: "https://www.amazon.com/dp/B0OLD00001",
      priceAmount: 25.5,
      priceCurrency: "USD",
      stars: 4.6,
      ratingsCount: 321,
      image: "https://m.media-amazon.com/old.jpg",
      bestSellersRank: [{ rank: 7, category: "Toys & Games" }],
    })
    expect(oldBsr.price).toBe("25.50")
    expect(oldBsr.reviewCount).toBe(321)
    expect(oldBsr.rank).toBe(7)
    expect(oldBsr.sourceUrl).toBe("https://www.amazon.com/dp/B0OLD00001")
  })
})

describe("TEMU 单品详情归一化（hypebridge，监控重抓）", () => {
  it("goodsId / 价格 / 评分 / 评论数 / 图集 / 视频；无销量与市场价", () => {
    const r = normalizeSelectionItem("temu", "monitor", {
      goodsId: "601099837209625",
      title: "1pc Stainless Steel Peeler",
      price: 3.93,
      priceText: "$3.93",
      currency: "USD",
      imageUrl: "https://img.kwcdn.com/product/fancy/a.jpg",
      galleryImages: ["https://img.kwcdn.com/product/fancy/a.jpg", "https://img.kwcdn.com/product/open/b.jpeg"],
      videoUrl: "https://goods-vod.kwcdn.com/goods-video/x.f30.mp4",
      hasVideo: true,
      rating: 4.6,
      reviewCount: 5323,
      inStock: true,
      categoryPath: "Home & Kitchen > Kitchen Utensils & Supplies",
      productUrl: "https://www.temu.com/some-slug-g-601099837209625.html",
    })
    expect(r.externalId).toBe("601099837209625")
    expect(r.sourceUrl).toBe("https://www.temu.com/some-slug-g-601099837209625.html")
    expect(r.price).toBe("3.93")
    expect(r.originalPrice).toBeNull()
    expect(r.rating).toBe("4.60")
    expect(r.reviewCount).toBe(5323)
    expect(r.salesCount).toBeNull()
    expect(r.images).toHaveLength(2)
    expect(r.videos).toEqual(["https://goods-vod.kwcdn.com/goods-video/x.f30.mp4"])
    expect(r.categoryPath).toEqual(["Home & Kitchen", "Kitchen Utensils & Supplies"])
    expect(r.tags).toContain("有视频")
  })
})

describe("评论归一化（normalizeReviewItem）", () => {
  it("Amazon junglee 评论：reviewReaction（字符串数字）映射到点赞数", () => {
    const r = normalizeReviewItem({
      reviewId: "R2ABC",
      reviewDescription: "Great earbuds for the price.",
      ratingScore: 5,
      reviewReaction: "272",
    })
    expect(r.externalId).toBe("R2ABC")
    expect(r.content).toBe("Great earbuds for the price.")
    expect(r.rating).toBe("5.00")
    expect(r.likesCount).toBe(272)
  })

  it("Etsy 评论：reviewDateIso / reviewDate 映射到发布时间", () => {
    const r = normalizeReviewItem({
      id: "rev-1",
      reviewDescription: "Beautiful craftsmanship",
      rating: 5,
      reviewDate: "Nov 15, 2026",
      reviewDateIso: "2026-11-15",
    })
    expect(r.publishedAt?.toISOString()).toBe("2026-11-15T00:00:00.000Z")
  })
})

describe("社媒归一化修正（2026-11-24）", () => {
  it("tiktok：不再把网页地址存进 videos；图文帖取多图", () => {
    const video = normalizeSelectionItem("tiktok", "market", {
      id: "7710019273522973983",
      text: "viral gadget",
      webVideoUrl: "https://www.tiktok.com/@a/video/7710019273522973983",
      diggCount: 5000,
      commentCount: 100,
      shareCount: 50,
      collectCount: 800,
      playCount: 90000,
      authorMeta: { nickName: "Creator" },
      videoMeta: { coverUrl: "https://p16.xx/cover.jpg", duration: 266 },
    })
    expect(video.sourceUrl).toBe("https://www.tiktok.com/@a/video/7710019273522973983")
    // actor 不提供视频直链：videos 必须为 null（此前存的 webVideoUrl 是网页地址）
    expect(video.videos).toBeNull()
    expect(video.images).toEqual(["https://p16.xx/cover.jpg"])

    const slideshow = normalizeSelectionItem("tiktok", "market", {
      id: "7000000000000000001",
      text: "photo post",
      webVideoUrl: "https://www.tiktok.com/@b/photo/7000000000000000001",
      isSlideshow: true,
      slideshowImageLinks: [
        { downloadLink: "https://p19.xx/1.jpeg", tiktokLink: "https://www.tiktok.com/t/1" },
        { downloadLink: "https://p19.xx/2.jpeg", tiktokLink: "https://www.tiktok.com/t/2" },
      ],
      videoMeta: { coverUrl: "https://p19.xx/1.jpeg" },
    })
    expect(slideshow.images).toEqual(["https://p19.xx/1.jpeg", "https://p19.xx/2.jpeg"])
    expect(slideshow.videos).toBeNull()
  })

  it("x：提取 media 图片与最高码率 mp4、长推文正文取 noteTweet、话题从 entities 取", () => {
    const r = normalizeSelectionItem("x", "market", {
      id: "2124906543069925394",
      url: "https://x.com/EVOai_Tech/status/2124906543069925394",
      text: "truncated text…",
      noteTweet: { text: "the full long text of the note tweet #gadgets #ai" },
      likeCount: 88,
      replyCount: 9,
      retweetCount: 12,
      viewCount: 4000,
      author: { username: "gadgetfan" },
      entities: { hashtags: [{ text: "gadgets" }, { text: "ai" }] },
      media: [
        {
          type: "photo",
          mediaUrl: "https://pbs.twimg.com/media/HXownu7akAAdXdS.jpg",
          displayUrl: "pic.x.com/ITABleVHKv",
        },
        {
          type: "video",
          mediaUrl: "https://pbs.twimg.com/ext_tw_video_thumb/pu/img/abc.jpg",
          durationMillis: 12500,
          videoVariants: [
            { bitrate: 632000, contentType: "application/x-mpegURL", url: "https://video.twimg.com/x.m3u8" },
            { bitrate: 832000, contentType: "video/mp4", url: "https://video.twimg.com/low.mp4" },
            { bitrate: 2176000, contentType: "video/mp4", url: "https://video.twimg.com/high.mp4" },
          ],
        },
      ],
    })
    expect(r.content).toContain("the full long text")
    expect(r.images).toEqual(["https://pbs.twimg.com/media/HXownu7akAAdXdS.jpg"])
    expect(r.videos).toEqual(["https://video.twimg.com/high.mp4"])
    expect(r.hashtags).toEqual(["gadgets", "ai"])
  })

  it("x：话题缺 entities 时从正文抽 #话题（去重保序）", () => {
    const r = normalizeSelectionItem("x", "market", {
      id: "1",
      text: "love this #phonecase #gadgets #phonecase",
      url: "https://x.com/a/status/1",
    })
    expect(r.hashtags).toEqual(["phonecase", "gadgets"])
    expect(r.images).toBeNull()
    expect(r.videos).toBeNull()
  })

  it("facebook：附件里的图片与直链视频", () => {
    const r = normalizeSelectionItem("facebook", "market", {
      postId: "1127104320302974",
      url: "https://www.facebook.com/reel/1708024954289524/",
      postText: "post body",
      reactionsCount: 88,
      commentsCount: 12,
      sharesCount: 3,
      author: { name: "Page" },
      attachments: [
        { type: "photo", url: "https://scontent.xx.fbcdn.net/v/t1/photo.jpg?st=1" },
        { type: "video", url: "https://scontent.xx.fbcdn.net/o1/v/t2/f2/m366/clip.mp4?efg=1" },
      ],
    })
    expect(r.images).toEqual(["https://scontent.xx.fbcdn.net/v/t1/photo.jpg?st=1"])
    expect(r.videos).toEqual(["https://scontent.xx.fbcdn.net/o1/v/t2/f2/m366/clip.mp4?efg=1"])
  })

  it("reddit：来源链接取帖子自身（permalink），不取外跳 url；评论不作结果", () => {
    const link = normalizeSelectionItem("reddit", "market", {
      id: "1y1s2lj",
      title: "Finally found a Rimowa phone case",
      permalink: "https://www.reddit.com/r/DesignerReps/comments/1y1s2lj/finally_found/",
      url: "https://i.redd.it/abc.jpg",
      link: "https://i.redd.it/abc.jpg",
      domain: "i.redd.it",
      score: 75,
      numComments: 16,
      author: "ThatPakiLad",
      subreddit: "DesignerReps",
      createdAt: "2026-11-21T08:27:09.474Z",
      linkFlairText: "Discussion",
      isVideo: true,
    })
    expect(link.sourceUrl).toBe("https://www.reddit.com/r/DesignerReps/comments/1y1s2lj/finally_found/")
    expect(link.likesCount).toBe(75)
    expect(link.category).toBe("DesignerReps")
    expect(link.tags).toEqual(["Discussion", "视频"])

    // 无 permalink：url 是 reddit 域才用；否则 null
    const noPermalink = normalizeSelectionItem("reddit", "market", {
      id: "abc",
      title: "t",
      url: "https://i.redd.it/x.jpg",
    })
    expect(noPermalink.sourceUrl).toBeNull()
    const relative = normalizeSelectionItem("reddit", "market", {
      id: "rd-1",
      permalink: "/r/BuyItForLife/abc/",
    })
    expect(relative.sourceUrl).toBe("https://www.reddit.com/r/BuyItForLife/abc/")
  })

  it("pinterest：来源链接取 Pin 自身 url，不取外跳 link", () => {
    const r = normalizeSelectionItem("pinterest", "market", {
      id: "e1_AfqPShwaVw4LCIhyf",
      title: "Phone case",
      url: "https://www.pinterest.com/pin/e1_AfqPShwaVw4LCIhyf/",
      link: "https://www.etsy.com/listing/123?ref=pin",
      domain: "etsy.com",
      saves: 8,
      commentCount: 2,
      pinnerUsername: "piaoberwinter",
      imageUrl: "https://i.pinimg.com/originals/a.jpg",
      createdAt: "Sun, 08 Nov 2026 20:48:56 +0000",
    })
    expect(r.sourceUrl).toBe("https://www.pinterest.com/pin/e1_AfqPShwaVw4LCIhyf/")
    expect(r.likesCount).toBe(8)
    expect(r.sellerName).toBe("piaoberwinter")
    // link 是外跳地址时仍回落到 Pin 自身
    const legacy = normalizeSelectionItem("pinterest", "market", {
      pinId: "999",
      link: "https://shop.example.com/x",
      url: "https://www.pinterest.com/pin/999/",
    })
    expect(legacy.sourceUrl).toBe("https://www.pinterest.com/pin/999/")
  })
})
