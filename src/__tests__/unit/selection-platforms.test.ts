import { describe, it, expect } from "vitest"
import {
  SELECTION_PLATFORMS,
  SELECTION_PLATFORM_CONFIGS,
  countryFor,
  creditsPerResultFor,
  estimateCredits,
  getFormFields,
  isSelectionPlatform,
} from "@/lib/selection/platforms"

/**
 * 选品平台注册表单测：结构不变量 + 计费口径（预扣/结算共用，错不得）
 */

describe("选品平台注册表", () => {
  it("覆盖 10 个平台（4 电商 + 6 社交）", () => {
    expect(SELECTION_PLATFORMS).toHaveLength(10)
    const ecommerce = SELECTION_PLATFORMS.filter(
      (p) => SELECTION_PLATFORM_CONFIGS[p].category === "ecommerce",
    )
    const social = SELECTION_PLATFORMS.filter(
      (p) => SELECTION_PLATFORM_CONFIGS[p].category === "social",
    )
    expect(ecommerce).toHaveLength(4)
    expect(social).toHaveLength(6)
  })

  it("每个平台配置完整（Actor/费率/上下限/默认值合法）", () => {
    for (const p of SELECTION_PLATFORMS) {
      const cfg = SELECTION_PLATFORM_CONFIGS[p]
      expect(cfg.marketActorId).toMatch(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i)
      expect(cfg.creditsPerResult).toBeGreaterThanOrEqual(1)
      expect(cfg.defaultResults).toBeGreaterThanOrEqual(cfg.minResults)
      expect(cfg.maxResultsPerTask).toBeGreaterThanOrEqual(cfg.defaultResults)
      expect(cfg.minResults).toBeGreaterThanOrEqual(1)
    }
  })

  it("Etsy 最小结果数 30（Actor 平台侧限制）", () => {
    expect(SELECTION_PLATFORM_CONFIGS.etsy.minResults).toBe(30)
  })

  it("发现模式费率覆盖生效（etsy discover 单独定价）", () => {
    expect(creditsPerResultFor("etsy", "market")).toBe(
      SELECTION_PLATFORM_CONFIGS.etsy.creditsPerResult,
    )
    expect(creditsPerResultFor("etsy", "discover")).toBe(
      SELECTION_PLATFORM_CONFIGS.etsy.discover!.creditsPerResult,
    )
    // 未单独定价的平台回落市场费率
    expect(creditsPerResultFor("instagram", "discover")).toBe(
      SELECTION_PLATFORM_CONFIGS.instagram.creditsPerResult,
    )
  })

  it("积分预估 = 条数 × 费率", () => {
    expect(estimateCredits("temu", "market", 100)).toBe(200)
    expect(estimateCredits("x", "market", 1000)).toBe(1000)
    expect(estimateCredits("etsy", "discover", 50)).toBe(200)
  })

  it("TEMU 用 CRW actor：市场/发现共用，单次 ≤100，五档排序", () => {
    const cfg = SELECTION_PLATFORM_CONFIGS.temu
    expect(cfg.marketActorId).toBe("crw/temu-products-scraper")
    expect(cfg.discover?.actorId).toBe(cfg.marketActorId)
    expect(cfg.maxResultsPerTask).toBe(100)
    const sortField = cfg.fields.find((f) => f.key === "sort")
    expect(sortField?.options).toHaveLength(5)
    // 发现模式不暴露排序（input-builder 固定 top_sales）
    expect(cfg.discover?.fields ?? []).toHaveLength(0)
  })

  it("countryFor：按注册表国家来源解析（field 取值 / fixed 常量 / 无则 null）", () => {
    expect(countryFor("temu", "market", {})).toBe("US")
    expect(countryFor("temu", "discover", {})).toBe("US")
    expect(countryFor("amazon", "market", { country: "DE" })).toBe("DE")
    expect(countryFor("amazon", "discover", {})).toBe("US") // BSR 榜单固定 .com
    expect(countryFor("etsy", "discover", { country: "GB" })).toBe("GB")
    expect(countryFor("etsy", "market", { currency: "USD" })).toBe(null)
    expect(countryFor("tiktok", "market", {})).toBe(null)
  })

  it("getFormFields：市场模式关键词主输入；Shopify 为域名；发现模式声明主输入", () => {
    const amazonMarket = getFormFields("amazon", "market")
    expect(amazonMarket[0]).toMatchObject({ key: "keyword", required: true })

    const shopifyMarket = getFormFields("shopify", "market")
    expect(shopifyMarket[0]).toMatchObject({ key: "domain", required: true })

    const amazonDiscover = getFormFields("amazon", "discover")
    expect(amazonDiscover.some((f) => f.key === "categoryUrl")).toBe(true)
    expect(amazonDiscover.some((f) => f.key === "keyword")).toBe(false)

    const redditDiscover = getFormFields("reddit", "discover")
    expect(redditDiscover.some((f) => f.key === "subreddit")).toBe(true)

    // 话题类发现模式补关键词框（pinterest 可选）
    const pinterestDiscover = getFormFields("pinterest", "discover")
    const kw = pinterestDiscover.find((f) => f.key === "keyword")
    expect(kw?.required).toBe(false)
  })

  it("isSelectionPlatform 校验", () => {
    expect(isSelectionPlatform("amazon")).toBe(true)
    expect(isSelectionPlatform("taobao")).toBe(false)
    expect(isSelectionPlatform("")).toBe(false)
  })
})
