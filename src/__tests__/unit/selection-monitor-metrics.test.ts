import { describe, it, expect } from "vitest"
import { monitorMetrics, trendColumns, trendSeries } from "@/components/selection/monitor/monitor-metrics"
import { sanitizeParams } from "@/server/services/selection-task-service"
import { getFormFields } from "@/lib/selection/platforms"

/**
 * 监控指标口径 + 表单参数条件校验单测（0108）。
 */

describe("monitorMetrics：各平台指标与涨跌", () => {
  it("amazon：价格 / BSR（降是好事）/ 月购买 / 评分 / 评论数", () => {
    const m = monitorMetrics(
      "amazon",
      {
        price: "20.98",
        rating: "4.40",
        salesCount: 3000,
        reviewCount: 120186,
        likesCount: null,
        commentsCount: null,
        viewsCount: null,
        sharesCount: null,
        rank: 85,
      },
      {
        price: "24.99",
        rating: "4.40",
        salesCount: 2000,
        reviewCount: 110000,
        likesCount: null,
        commentsCount: null,
        viewsCount: null,
        sharesCount: null,
        rank: 120,
      },
      "USD",
    )
    expect(m.map((x) => [x.label, x.text, x.delta, x.deltaGood])).toEqual([
      ["价格", "$20.98", "−16%", null], // 价格变化中性，不着色
      ["BSR", "#85", "−29.2%", true], // 名次下降是好事
      ["月购买", "3.0K", "+50%", true],
      ["评分", "4.4", "0%", null], // 持平不着色
      ["评论数", "120.2K", "+9.3%", true],
    ])
  })

  it("无数据的指标整个不显示（TEMU 单品抓取不含销量）", () => {
    const temu = monitorMetrics(
      "temu",
      { price: "3.00", rating: "4.90", salesCount: null, reviewCount: 29097, likesCount: null, commentsCount: null, viewsCount: null, sharesCount: null, rank: null },
      null,
      "USD",
    )
    expect(temu.map((x) => x.label)).toEqual(["价格", "评分", "评论数"])
    // 首次抓取前没有任何指标
    expect(
      monitorMetrics(
        "amazon",
        { price: null, rating: null, salesCount: null, reviewCount: null, likesCount: null, commentsCount: null, viewsCount: null, sharesCount: null, rank: null },
        null,
        null,
      ),
    ).toEqual([])
  })

  it("社媒：点赞 / 评论 / 浏览 / 转发；Etsy 仅评论数", () => {
    const tiktok = monitorMetrics(
      "tiktok",
      { price: null, rating: null, salesCount: null, reviewCount: null, likesCount: 204900, commentsCount: 1600, viewsCount: 2800000, sharesCount: 6000, rank: null },
      { price: null, rating: null, salesCount: null, reviewCount: null, likesCount: 200000, commentsCount: 1600, viewsCount: null, sharesCount: 6000, rank: null },
      null,
    )
    expect(tiktok.map((x) => [x.label, x.delta, x.deltaGood])).toEqual([
      ["点赞", "+2.5%", true],
      ["评论", "0%", null],
      ["播放", null, null], // 上次无数据 → 不显示涨跌
      ["分享", "0%", null],
    ])
    expect(monitorMetrics("x", { price: null, rating: null, salesCount: null, reviewCount: null, likesCount: 1, commentsCount: 2, viewsCount: 3, sharesCount: 4, rank: null }, null, null).map((x) => x.label)).toEqual([
      "点赞",
      "评论",
      "浏览",
      "转发",
    ])
    expect(monitorMetrics("pinterest", { price: null, rating: null, salesCount: null, reviewCount: null, likesCount: 1, commentsCount: null, viewsCount: null, sharesCount: null, rank: null }, null, null).map((x) => x.label)).toEqual(["保存"])
    expect(monitorMetrics("reddit", { price: null, rating: null, salesCount: null, reviewCount: null, likesCount: 1, commentsCount: 1, viewsCount: null, sharesCount: null, rank: null }, null, null)[0]!.label).toBe("获赞")
    expect(monitorMetrics("etsy", { price: null, rating: null, salesCount: null, reviewCount: 5, likesCount: null, commentsCount: null, viewsCount: null, sharesCount: null, rank: null }, null, null).map((x) => x.label)).toEqual(["评论数"])
  })
})

describe("trendSeries / trendColumns", () => {
  const point = (price: string | null, sales: number | null, rank: number | null) => ({
    date: "2026-11-24T00:00:00Z",
    price,
    rating: null,
    salesCount: sales,
    reviewCount: 100,
    likesCount: null,
    commentsCount: null,
    viewsCount: null,
    sharesCount: null,
    rank,
  })

  it("只列出该平台有数据的序列", () => {
    const amazon = trendSeries("amazon", [point("20.98", 3000, 85), point("21.99", 2800, 90)])
    expect(amazon.dates).toHaveLength(2)
    expect(amazon.series.map((s) => s.key)).toEqual(["price", "sales", "rank", "reviews"])
    expect(amazon.series.find((s) => s.key === "price")!.values).toEqual([20.98, 21.99])
    // 评分全为空 → 不出现
    expect(amazon.series.some((s) => s.key === "rating")).toBe(false)
    const temu = trendSeries("temu", [point("3.00", null, null)])
    expect(temu.series.map((s) => s.key)).toEqual(["price", "reviews"])
    const social = trendSeries("tiktok", [{ ...point(null, null, null), likesCount: 5, viewsCount: 10 }])
    expect(social.series.map((s) => s.key)).toEqual(["likes", "views"])
    expect(trendSeries("etsy", [point(null, null, null)]).series.map((s) => s.key)).toEqual(["reviews"])
  })

  it("历史表列按平台", () => {
    expect(trendColumns("amazon").map((c) => c.label)).toEqual(["价格", "BSR", "月购买", "评分", "评论数"])
    expect(trendColumns("temu").map((c) => c.label)).toEqual(["价格", "销量", "评分", "评论数"])
    expect(trendColumns("etsy").map((c) => c.label)).toEqual(["评论数"])
    expect(trendColumns("x").map((c) => c.label)).toEqual(["点赞", "评论", "浏览", "转发"])
  })
})

describe("sanitizeParams：注册表字段声明清洗 + 选项条件（showWhen）", () => {
  const amazonDiscover = getFormFields("amazon", "discover")

  it("必填缺失报错，数字做范围校验，越权键丢弃", () => {
    const kw = getFormFields("temu", "market")
    expect(sanitizeParams(kw, { sort: "top_sales" })).toEqual({ ok: false, error: "请填写「关键词」" })
    expect(sanitizeParams(kw, { keyword: "case", hacker: "x" })).toEqual({
      ok: true,
      params: { keyword: "case", sort: "relevance" }, // 默认值补齐，越权键被丢弃
    })
    const amazonMarket = getFormFields("amazon", "market")
    expect(sanitizeParams(amazonMarket, { keyword: "x", minPrice: -5 })).toEqual({ ok: false, error: "「最低价」不得小于 0" })
    expect(sanitizeParams(amazonMarket, "not-an-object")).toEqual({ ok: false, error: "参数格式错误" })
  })

  it("Amazon 榜单：站点 × 品类不在实测支持矩阵内被拒（绕过前端同样拦住）", () => {
    // 英国站没有运动户外榜单
    const bad = sanitizeParams(amazonDiscover, {
      listType: "bestsellers",
      country: "UK",
      category: "sporting-goods",
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/暂不支持/)
    // 飙升榜不是合法选项
    expect(sanitizeParams(amazonDiscover, { listType: "movers-and-shakers", country: "US", category: "electronics" }).ok).toBe(false)
    // 德国站不在榜单站点里
    expect(sanitizeParams(amazonDiscover, { listType: "bestsellers", country: "DE", category: "electronics" }).ok).toBe(false)
    // 支持的组合通过
    expect(
      sanitizeParams(amazonDiscover, { listType: "new-releases", country: "UK", category: "kitchen" }),
    ).toEqual({
      ok: true,
      params: { listType: "new-releases", country: "UK", category: "kitchen" },
    })
  })

  it("缺省时补默认值，默认组合必须落在支持矩阵内", () => {
    const r = sanitizeParams(amazonDiscover, {})
    expect(r).toEqual({
      ok: true,
      params: { listType: "bestsellers", country: "US", category: "electronics" },
    })
  })
})
