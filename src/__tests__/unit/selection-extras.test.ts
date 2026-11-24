import { describe, it, expect } from "vitest"
import { extractExtras, resolveVideo, reviewExtras, youtubeIdOf } from "@/lib/selection/extras"

/**
 * 平台专属字段投影 + 视频来源判定单测（0108）：extras 把 raw_data 投影成各平台
 * 强类型字段，新旧 actor 出参形状都做防御式兼容；存量行无需重抓即可展示。
 */

describe("Amazon extras", () => {
  const row = {
    asin: "B0BTYDLTM3",
    brand: "Soundcore",
    price: { value: 20.98, currency: "$" },
    stars: 4.4,
    starsBreakdown: { "5star": 0.72, "4star": 0.13, "3star": 0.07, "2star": 0.03, "1star": 0.05 },
    monthlyPurchaseVolume: "3K+ bought in past month",
    features: ["Powerful Bass", "30H Playtime"],
    attributes: [
      { key: "Brand Name", value: "Soundcore" },
      { key: "Best Sellers Rank", value: "#85 in Electronics" },
      { key: "ASIN", value: "B0BTYDLTM3" },
      { key: "Model Number", value: "A3949" },
    ],
    variantDetails: [{ asin: "B0D5HN8B1F", name: "Black", price: { value: 20.98, currency: "$" } }],
    variantAsins: ["B0BTYCRJSS", "B0D5HN8B1F"],
    bestsellerRanks: [
      { rank: 85, category: "Electronics", url: "https://x" },
      { rank: 12, category: "Earbud & In-Ear Headphones", url: "https://y" },
    ],
    categoryPageData: { pageNumber: 1, productPosition: 4, isSponsored: false },
    isAmazonChoice: true,
    inStock: true,
    delivery: "Saturday, November 28",
    fastestDelivery: "Tomorrow, November 24",
    videosCount: 11,
    aiReviewsSummary: {
      text: "Customers find these earbuds to be of good quality.",
      keywords: [
        {
          name: "Quality",
          sentiment: "positive",
          text: "good quality",
          customersMentionedCount: { total: 6523, positive: 5563, negative: 960 },
        },
        { name: "Reliability", sentiment: "mixed", customersMentionedCount: { total: 2728, positive: 1836, negative: 892 } },
      ],
    },
  }

  it("junglee 商品页家族：排名 / 月购买 / 规格 / 变体 / 评分分布 / 官方 AI 摘要", () => {
    const { amazon: ex } = extractExtras("amazon", row, {})
    expect(ex).toMatchObject({
      asin: "B0BTYDLTM3",
      brand: "Soundcore",
      bsrRank: 85,
      bsrCategory: "Electronics",
      searchPosition: 4,
      listPosition: null,
      monthlyPurchases: "3K+ bought in past month",
      inStock: true,
      isChoice: true,
      isSponsored: false,
      delivery: "Saturday, November 28",
      fastestDelivery: "Tomorrow, November 24",
      videosCount: 11,
    })
    expect(ex!.bsrRanks).toHaveLength(2)
    // 评分占比换算成整数百分比，5 星 → 1 星
    expect(ex!.ratingBreakdown).toEqual([72, 13, 7, 3, 5])
    // 与其它区块重复的噪音键（BSR / Customer Reviews / ASIN）剔除
    expect(ex!.attributes).toEqual([
      ["Brand Name", "Soundcore"],
      ["Model Number", "A3949"],
    ])
    expect(ex!.variants).toEqual([{ asin: "B0D5HN8B1F", name: "Black", price: 20.98 }])
    expect(ex!.variantCount).toBe(1)
    expect(ex!.features).toEqual(["Powerful Bass", "30H Playtime"])
    expect(ex!.aiReviewSummary?.text).toContain("good quality")
    expect(ex!.aiReviewSummary?.keywords[1]).toEqual({
      name: "Reliability",
      sentiment: "mixed",
      positive: 1836,
      negative: 892,
      total: 2728,
    })
  })

  it("榜单行：榜单名次与榜单类目；缺评分分布时为空数组", () => {
    const { amazon: ex } = extractExtras(
      "amazon",
      {
        asin: "B0FQFB8FMG",
        title: "AirPods Pro 3",
        brand: "Apple",
        monthlyPurchaseVolume: "10K+ bought in past month",
        bestsellerPageData: { position: 2, categoryName: "Electronics", categoryFullName: "Best Sellers in Electronics" },
        bestsellerRanks: [{ rank: 1, category: "Earbud & In-Ear Headphones", url: "https://x" }],
      },
      {},
    )
    expect(ex?.listPosition).toBe(2)
    expect(ex?.listCategory).toBe("Best Sellers in Electronics")
    expect(ex?.bsrRank).toBe(1)
    expect(ex?.ratingBreakdown).toEqual([])
    expect(ex?.aiReviewSummary).toBeNull()
  })

  it("兼容旧 santamaria 搜索行：ISO 币种、purchaseVolumeText、positionOverall", () => {
    const { amazon: ex } = extractExtras(
      "amazon",
      {
        asin: "B09K5PX8RH",
        brand: "Vitacera",
        purchaseVolumeText: "50+ bought in past month",
        positionOverall: 17,
        isAmazonChoice: true,
        isPrime: true,
        couponText: "Save 5%",
      },
      { sellerName: "回退品牌" },
    )
    expect(ex?.monthlyPurchases).toBe("50+ bought in past month")
    expect(ex?.searchPosition).toBe(17)
    expect(ex?.isChoice).toBe(true)
    expect(ex?.isPrime).toBe(true)
    expect(ex?.couponText).toBe("Save 5%")
    // 缺品牌时回落统一列 sellerName
    expect(extractExtras("amazon", { asin: "X" }, { sellerName: "回退品牌" }).amazon?.brand).toBe("回退品牌")
  })

  it("缺字段 / 非对象输入永不抛错", () => {
    expect(extractExtras("amazon", null).amazon).toBeUndefined()
    expect(extractExtras("amazon", [1, 2]).amazon).toBeUndefined()
    expect(extractExtras("unknown", { a: 1 })).toEqual({})
    const { amazon: ex } = extractExtras("amazon", { starsBreakdown: "bad", attributes: "bad", variantDetails: 7 }, {})
    expect(ex?.ratingBreakdown).toEqual([])
    expect(ex?.attributes).toEqual([])
    expect(ex?.variants).toEqual([])
  })
})

describe("TEMU / Etsy / Shopify extras", () => {
  it("temu：CRW 关键词行（店铺链接 / 销量提示 / 降幅按价格推算 / 视频）", () => {
    const { temu: ex } = extractExtras(
      "temu",
      {
        goods_id: 601099518600825,
        mall_link: "https://www.temu.com/mall.html?mall_id=1",
        sales_tip: "10K+ sold",
        // reduction_pct 不是折扣率：$1.90 对 $2.19 实际降 13%，reduction_pct 却给 1
        reduction_pct: 1,
        price: 190,
        price_str: "$1.90",
        market_price: 219,
        market_price_str: "$2.19",
        video_url: "https://goods-vod.kwcdn.com/a.mp4",
      },
      {},
    )
    expect(ex).toMatchObject({
      goodsId: "601099518600825",
      mallLink: "https://www.temu.com/mall.html?mall_id=1",
      salesTip: "10K+ sold",
      discountPct: 13,
      videoUrl: "https://goods-vod.kwcdn.com/a.mp4",
      inStock: null,
    })
    // 市场价不高于售价（或缺失）时不出降幅
    expect(extractExtras("temu", { goods_id: 2, price_str: "$1.00", market_price: 0 }, {}).temu?.discountPct).toBeNull()
  })

  it("temu：hypebridge 单品详情（库存 / 规格 / SKU 数 / 退货），视频回落统一列", () => {
    const { temu: ex } = extractExtras(
      "temu",
      {
        goodsId: "601099837209625",
        inStock: true,
        specifications: { Material: "Stainless Steel" },
        skus: [{ skuId: "a" }, { skuId: "b" }],
        returnPolicy: { returnWindowDays: 90, freeReturns: true },
      },
      { videos: ["https://goods-vod.kwcdn.com/b.mp4"] },
    )
    expect(ex).toMatchObject({
      goodsId: "601099837209625",
      inStock: true,
      specifications: [["Material", "Stainless Steel"]],
      skuCount: 2,
      returnPolicy: { freeReturns: true, returnWindowDays: 90 },
      videoUrl: "https://goods-vod.kwcdn.com/b.mp4",
    })
  })

  it("etsy / shopify：收藏 / 类目 / 标签 / 店铺 / 商品视频直链", () => {
    const { etsy } = extractExtras(
      "etsy",
      {
        shop_name: "CraftShop",
        shop_url: "https://www.etsy.com/shop/CraftShop",
        favorites: 2300,
        taxonomy_path: ["Handmade", "Jewelry"],
        tags: ["a", "b", "c"],
        materials: ["brass"],
        when_made: "Made to order",
        ships_from_country: "US",
        shop_rating: 4.8,
        videos: ["https://v.etsystatic.com/c/video/upload/ac_none/a.mp4"],
      },
      {},
    )
    expect(etsy).toMatchObject({
      shopName: "CraftShop",
      favorites: 2300,
      taxonomy: ["Handmade", "Jewelry"],
      materials: ["brass"],
      whenMade: "Made to order",
      shipsFromCountry: "US",
      shopRating: 4.8,
      videoUrl: "https://v.etsystatic.com/c/video/upload/ac_none/a.mp4",
    })
    // raw 无 videos 时回落统一列
    expect(
      extractExtras("etsy", { shop_name: "S" }, { videos: ["https://v.etsystatic.com/b.mp4"] }).etsy?.videoUrl,
    ).toBe("https://v.etsystatic.com/b.mp4")
    const { shopify } = extractExtras(
      "shopify",
      { source: { retailer: "Allbirds" }, brand: "Allbirds", categories: ["Shoes"], tags: ["wool"], fullyOutOfStock: true },
      {},
    )
    expect(shopify).toEqual({
      retailer: "Allbirds",
      brand: "Allbirds",
      categories: ["Shoes"],
      tags: ["wool"],
      fullyOutOfStock: true,
    })
  })
})

describe("社媒 extras", () => {
  it("tiktok：时长 / 收藏 / 音乐 / 作者（头像、粉丝、认证）/ 带货标记", () => {
    const { tiktok: ex } = extractExtras(
      "tiktok",
      {
        collectCount: 800,
        repostCount: 12,
        isSlideshow: false,
        hasTikTokShopProduct: true,
        isAd: true,
        musicMeta: { musicName: "Original sound", musicAuthor: "creator" },
        authorMeta: { name: "goddess7322", nickName: "Charmaine", fans: 29400, verified: true, avatar: "https://p19.xx/avatar.jpeg" },
        videoMeta: { duration: 266, width: 720, height: 1280, definition: "720p" },
        textLanguage: "en",
      },
      {},
    )
    expect(ex).toMatchObject({
      durationSec: 266,
      collectCount: 800,
      repostCount: 12,
      isSlideshow: false,
      hasShopProduct: true,
      isAd: true,
      music: { name: "Original sound", author: "creator" },
      location: null,
      width: 720,
      height: 1280,
    })
    expect(ex?.author).toMatchObject({ username: "goddess7322", nickname: "Charmaine", followers: 29400, verified: true })
  })

  it("instagram：类型 / 时长 / 位置 / 音乐 / Reels 判定（productType=clips 或来源链接）", () => {
    // 真实出参里 Reels 的 productType 是 "clips"（普通图帖 "feed"）
    const { instagram: byProduct } = extractExtras(
      "instagram",
      { type: "Video", productType: "clips", videoDuration: 14.2, videoUrl: "https://scontent.xx/v.mp4", locationName: "Tokyo", ownerUsername: "owner" },
      {},
    )
    expect(byProduct).toMatchObject({
      type: "Video",
      isReel: true,
      durationSec: 14.2,
      videoUrl: "https://scontent.xx/v.mp4",
      location: "Tokyo",
      author: { username: "owner", fullName: null },
    })
    // 兼容历史 "reels" 写法；图帖 feed 不亮徽标
    expect(extractExtras("instagram", { type: "Video", productType: "reels" }, {}).instagram?.isReel).toBe(true)
    expect(extractExtras("instagram", { type: "Image", productType: "feed" }, {}).instagram?.isReel).toBe(false)
    const { instagram: byUrl } = extractExtras("instagram", { type: "Image" }, { sourceUrl: "https://www.instagram.com/reel/ABC/" })
    expect(byUrl?.isReel).toBe(true)
    const { instagram: carousel } = extractExtras(
      "instagram",
      { type: "Sidecar", paidPartnership: true, coauthorProducers: [{ username: "co1" }], musicInfo: { song_name: "Song", artist_name: "Artist" } },
      {},
    )
    expect(carousel).toMatchObject({
      type: "Sidecar",
      paidPartnership: true,
      coauthors: ["co1"],
      music: { name: "Song", artist: "Artist" },
    })
  })

  it("pinterest / reddit / x / facebook", () => {
    const { pinterest } = extractExtras(
      "pinterest",
      {
        boardName: "Cute Phone Cases",
        boardUrl: "https://www.pinterest.com/u/board/",
        pinnerFollowers: 27,
        pinnerName: "Pink Aura",
        domain: "etsy.com",
        altText: "a phone case",
        hashtags: ["#phonecase"],
        isVideo: true,
        videoUrl: "https://v.pinimg.com/v.mp4",
        videoDurationSec: 9.5,
        videoThumbnailUrl: "https://i.pinimg.com/t.jpg",
        link: "https://www.etsy.com/listing/1",
      },
      {},
    )
    expect(pinterest).toMatchObject({
      boardName: "Cute Phone Cases",
      pinnerFollowers: 27,
      pinnerName: "Pink Aura",
      domain: "etsy.com",
      hashtags: ["#phonecase"],
      isVideo: true,
      videoUrl: "https://v.pinimg.com/v.mp4",
      durationSec: 9.5,
      videoThumb: "https://i.pinimg.com/t.jpg",
      outboundLink: "https://www.etsy.com/listing/1",
    })

    const { reddit } = extractExtras(
      "reddit",
      {
        subreddit: "AskReddit",
        linkFlairText: "Discussion",
        upvoteRatio: 0,
        totalAwards: 0,
        isVideo: true,
        domain: "youtube.com",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        isNSFW: false,
      },
      {},
    )
    expect(reddit).toMatchObject({
      subreddit: "AskReddit",
      flair: "Discussion",
      isVideo: true,
      domain: "youtube.com",
      outboundUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    })

    const { x } = extractExtras(
      "x",
      {
        author: { username: "gadgetfan", name: "Fan", followers: 1200, isBlueVerified: true, profilePicture: "https://pbs.twimg.com/a.jpg" },
        media: [
          { type: "photo", mediaUrl: "https://pbs.twimg.com/media/a.jpg" },
          {
            type: "video",
            // 视频的 mediaUrl 是缩略图 JPG，直链在 videoVariants（最高码率 mp4）
            mediaUrl: "https://pbs.twimg.com/ext_tw_video_thumb/pu/img/abc.jpg",
            durationMillis: 8000,
            videoVariants: [
              { bitrate: 632000, contentType: "application/x-mpegURL", url: "https://video.twimg.com/x.m3u8" },
              { bitrate: 832000, contentType: "video/mp4", url: "https://video.twimg.com/low.mp4" },
              { bitrate: 2176000, contentType: "video/mp4", url: "https://video.twimg.com/high.mp4" },
            ],
          },
        ],
        quoteCount: 30,
        bookmarkCount: 12,
        isReply: true,
        place: { fullName: "Tokyo, Japan" },
      },
      {},
    )
    expect(x?.author).toMatchObject({ username: "gadgetfan", followers: 1200, verified: true, avatar: "https://pbs.twimg.com/a.jpg" })
    expect(x?.media).toEqual([
      { type: "photo", url: "https://pbs.twimg.com/media/a.jpg", thumb: "https://pbs.twimg.com/media/a.jpg", durationSec: null },
      {
        type: "video",
        url: "https://video.twimg.com/high.mp4",
        thumb: "https://pbs.twimg.com/ext_tw_video_thumb/pu/img/abc.jpg",
        durationSec: 8,
      },
    ])
    expect(x).toMatchObject({ quoteCount: 30, bookmarkCount: 12, isReply: true, place: "Tokyo, Japan" })

    // 只有 m3u8 变体（无 mp4）的视频媒体被整条剔除，不把缩略图 JPG 当直链
    const m3u8Only = extractExtras(
      "x",
      { media: [{ type: "video", mediaUrl: "https://pbs.twimg.com/t.jpg", videoVariants: [{ contentType: "application/x-mpegURL", url: "https://video.twimg.com/x.m3u8" }] }] },
      {},
    )
    expect(m3u8Only.x?.media).toEqual([])

    const { facebook } = extractExtras(
      "facebook",
      {
        author: { name: "Page", profilePicture: "https://scontent.xx/a.jpg", profileUrl: "https://www.facebook.com/page" },
        // 官方 actor 真实键名：care/sad 轴给的是 support/sorry
        reactions: { like: 2731, love: 428, support: 39, sorry: 8, haha: 7, wow: 3 },
        attachments: [{ type: "video", url: "https://scontent.xx/v.mp4?x=1" }, { type: "photo" }],
        isReshare: true,
      },
      {},
    )
    expect(facebook?.author).toEqual({ name: "Page", avatar: "https://scontent.xx/a.jpg", url: "https://www.facebook.com/page" })
    expect(facebook?.reactions).toMatchObject({ like: 2731, love: 428, care: 39, sad: 8, haha: 7, wow: 3, anger: null })
    expect(facebook?.attachments).toEqual([{ type: "video", url: "https://scontent.xx/v.mp4?x=1" }])
    expect(facebook?.isReshare).toBe(true)
    // 只有 love（无 like）的帖子整组反应不丢
    expect(extractExtras("facebook", { reactions: { love: 1 } }, {}).facebook?.reactions).toMatchObject({ love: 1 })
  })
})

describe("reviewExtras", () => {
  it("junglee 评论行：标题 / 图片 / Vine / 变体 / 国家", () => {
    expect(
      reviewExtras({
        reviewTitle: "I bought a second pair",
        reviewImages: ["https://m.media-amazon.com/images/I/a.jpg", "not-a-url"],
        isAmazonVine: true,
        variantAttributes: [{ key: "Color", value: "White" }],
        country: "United States",
      }),
    ).toEqual({
      title: "I bought a second pair",
      images: ["https://m.media-amazon.com/images/I/a.jpg"],
      vine: true,
      variant: "Color: White",
      country: "United States",
    })
  })
  it("variant 字符串优先；空输入返回全空", () => {
    expect(reviewExtras({ variant: "Color: Black" }).variant).toBe("Color: Black")
    expect(reviewExtras(null)).toEqual({ title: null, images: [], vine: false, variant: null, country: null })
  })
})

describe("resolveVideo：各平台视频来源", () => {
  it("TikTok 走官方嵌入（需视频数字 ID）；图文帖无视频", () => {
    const video = resolveVideo("tiktok", { externalId: "7692799546451070239", images: ["https://p19.xx/c.jpg"] })
    expect(video).toEqual({
      kind: "embed",
      src: "https://www.tiktok.com/embed/v2/7692799546451070239",
      provider: "tiktok",
      poster: "https://p19.xx/c.jpg",
      durationSec: null,
    })
    expect(
      resolveVideo("tiktok", {
        externalId: "1",
        images: [],
        extras: { tiktok: { isSlideshow: true, slideshowImages: [], durationSec: 5 } as never },
      }).kind,
    ).toBe("none")
    expect(resolveVideo("tiktok", { externalId: null }).kind).toBe("none")
  })

  it("X 取最高码率 mp4（统一列 videos 优先，存量行 videos 为空时回落 extras 媒体）", () => {
    const direct = resolveVideo("x", {
      externalId: "1",
      images: ["https://pbs.twimg.com/media/a.jpg"],
      videos: ["https://video.twimg.com/high.mp4"],
      extras: {
        x: {
          media: [{ type: "video", url: "https://video.twimg.com/high.mp4", thumb: "https://pbs.twimg.com/t.jpg", durationSec: 8 }],
        } as never,
      },
    })
    expect(direct).toEqual({
      kind: "direct",
      src: "https://video.twimg.com/high.mp4",
      provider: null,
      poster: "https://pbs.twimg.com/t.jpg",
      durationSec: 8,
    })
    // videos 列为空的存量行：extras 媒体里的 mp4 直链即可内播（不会是缩略图 JPG）
    expect(
      resolveVideo("x", {
        externalId: "1",
        images: ["https://pbs.twimg.com/media/a.jpg"],
        extras: {
          x: {
            media: [{ type: "video", url: "https://video.twimg.com/high.mp4", thumb: "https://pbs.twimg.com/t.jpg", durationSec: 8 }],
          } as never,
        },
      }),
    ).toMatchObject({ kind: "direct", src: "https://video.twimg.com/high.mp4" })
    // 只有图片的推文没有视频
    expect(
      resolveVideo("x", { externalId: "1", images: ["https://pbs.twimg.com/media/a.jpg"], extras: { x: { media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg", thumb: null, durationSec: null }] } as never } }).kind,
    ).toBe("none")
  })

  it("Instagram / Pinterest / TEMU / Etsy / Facebook 取直链", () => {
    const ig = resolveVideo("instagram", {
      externalId: "1",
      images: ["https://scontent.xx/c.jpg"],
      extras: { instagram: { videoUrl: "https://scontent.xx/v.mp4", durationSec: 11 } as never },
    })
    expect(ig).toMatchObject({ kind: "direct", src: "https://scontent.xx/v.mp4", durationSec: 11 })
    const pin = resolveVideo("pinterest", {
      externalId: "1",
      images: [],
      extras: { pinterest: { videoUrl: "https://v.pinimg.com/v.mp4", videoThumb: "https://i.pinimg.com/t.jpg", durationSec: 2 } as never },
    })
    expect(pin).toMatchObject({ kind: "direct", poster: "https://i.pinimg.com/t.jpg" })
    expect(resolveVideo("temu", { externalId: "g", videos: ["https://goods-vod.kwcdn.com/a.mp4"] })).toMatchObject({
      kind: "direct",
      src: "https://goods-vod.kwcdn.com/a.mp4",
    })
    // Etsy：商品视频 mp4 直链（extras 投影与统一列都可用）
    expect(
      resolveVideo("etsy", { externalId: "l1", extras: { etsy: { videoUrl: "https://v.etsystatic.com/c/video/upload/ac_none/a.mp4" } as never } }),
    ).toMatchObject({ kind: "direct", src: "https://v.etsystatic.com/c/video/upload/ac_none/a.mp4" })
    expect(resolveVideo("etsy", { externalId: "l2", videos: ["https://v.etsystatic.com/b.mp4"] }).kind).toBe("direct")
    expect(resolveVideo("facebook", { externalId: "p", videos: ["https://scontent.xx/v.mp4"] }).kind).toBe("direct")
    // videos 列为空的存量 FB 视频帖：投影里的视频附件仍可直连播放
    expect(
      resolveVideo("facebook", {
        externalId: "p2",
        extras: { facebook: { attachments: [{ type: "video", url: "https://scontent.xx/v2.mp4?efg=1" }] } as never },
      }),
    ).toMatchObject({ kind: "direct", src: "https://scontent.xx/v2.mp4?efg=1" })
    expect(resolveVideo("instagram", { externalId: "1", images: [] }).kind).toBe("none")
  })

  it("Reddit：YouTube 链接走嵌入，.mp4 直链尝试播放，其余不内播", () => {
    const yt = resolveVideo("reddit", {
      externalId: "1",
      extras: {
        reddit: { isVideo: true, outboundUrl: "https://youtu.be/dQw4w9WgXcQ?si=abc", imageUrls: [] } as never,
      },
    })
    expect(yt).toEqual({
      kind: "embed",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      provider: "youtube",
      poster: null,
      durationSec: null,
    })
    expect(
      resolveVideo("reddit", {
        externalId: "1",
        extras: { reddit: { isVideo: true, outboundUrl: "https://v.redd.it/abc/DASH_720.mp4?source=fallback", imageUrls: [] } as never },
      }).kind,
    ).toBe("direct")
    // v.redd.it 的 DASH 播放列表页 / 非视频帖不内播
    expect(
      resolveVideo("reddit", {
        externalId: "1",
        extras: { reddit: { isVideo: true, outboundUrl: "https://v.redd.it/abc", imageUrls: [] } as never },
      }).kind,
    ).toBe("none")
    expect(resolveVideo("reddit", { externalId: "1", extras: { reddit: { isVideo: false, outboundUrl: null, imageUrls: [] } as never } }).kind).toBe("none")
  })

  it("未知平台：无视频", () => {
    expect(resolveVideo("shopify", { externalId: "1" })).toMatchObject({ kind: "none", src: null })
  })
})

describe("youtubeIdOf", () => {
  it("识别 youtu.be / watch?v= / embed / shorts / live", () => {
    expect(youtubeIdOf("https://youtu.be/dQw4w9WgXcQ?t=1")).toBe("dQw4w9WgXcQ")
    expect(youtubeIdOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=1")).toBe("dQw4w9WgXcQ")
    expect(youtubeIdOf("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
    expect(youtubeIdOf("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ")
    expect(youtubeIdOf("https://m.youtube.com/live/dQw4w9WgXcQ?hl=en")).toBe("dQw4w9WgXcQ")
    expect(youtubeIdOf("https://www.youtube.com/playlist?list=1")).toBeNull()
    expect(youtubeIdOf("https://v.redd.it/abc")).toBeNull()
  })
})
