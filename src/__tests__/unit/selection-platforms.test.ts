import { describe, it, expect } from "vitest"
import {
  SELECTION_PLATFORMS,
  SELECTION_PLATFORM_CONFIGS,
  countryFor,
  creditsPerResultFor,
  estimateCredits,
  getFormFields,
  isSelectionPlatform,
  platformsForCategory,
  resultLimitsFor,
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
    // 榜单模式主输入 = 品类（primary 标记），不再补关键词框
    expect(amazonDiscover.find((f) => f.key === "category")?.primary).toBe(true)
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

describe("注册表派生口径（0108）", () => {
  it("platformsForCategory：按类别派生平台清单（标签条 / 下拉 / SQL 过滤的唯一来源）", () => {
    expect(platformsForCategory("ecommerce")).toEqual(["amazon", "etsy", "temu", "shopify"])
    expect(platformsForCategory("social")).toEqual(["instagram", "tiktok", "pinterest", "reddit", "x", "facebook"])
    // 两类合计恰为全部平台，无遗漏无重复
    expect([...platformsForCategory("ecommerce"), ...platformsForCategory("social")].sort()).toEqual(
      [...SELECTION_PLATFORMS].sort(),
    )
  })

  it("resultLimitsFor：发现模式可单独声明上下限（Amazon 榜单每类目硬上限 100）", () => {
    // Amazon 关键词搜索约 7 页封顶：上限从 1000 收到 200，默认 60
    expect(resultLimitsFor("amazon", "market")).toEqual({ min: 1, max: 200, default: 60 })
    expect(resultLimitsFor("amazon", "discover")).toEqual({ min: 1, max: 100, default: 48 })
    // 未单独声明的平台发现模式沿用平台级配置
    const temu = SELECTION_PLATFORM_CONFIGS.temu
    expect(resultLimitsFor("temu", "discover")).toEqual({
      min: temu.minResults,
      max: temu.maxResultsPerTask,
      default: temu.defaultResults,
    })
    // Etsy Actor 侧最小 30 条在发现模式下同样生效
    expect(resultLimitsFor("etsy", "discover").min).toBe(30)
  })

  it("Amazon 注册表（2026-11-24 换 junglee 家族）", () => {
    const cfg = SELECTION_PLATFORM_CONFIGS.amazon
    expect(cfg.marketActorId).toBe("junglee/Amazon-crawler")
    expect(cfg.discover?.actorId).toBe("junglee/amazon-bestsellers")
    expect(cfg.monitor?.metricsActorId).toBe("junglee/amazon-asins-scraper")
    expect(cfg.monitor?.reviewActorId).toBe("junglee/amazon-reviews-scraper")
    // 榜单站点（德国站实测不支持）
    const country = cfg.discover!.fields.find((f) => f.key === "country")
    expect(country?.options?.map((o) => o.value)).toEqual(["US", "UK", "JP", "CA", "FR"])
    // 默认品类在每个站点都可用（showWhen 覆盖全部 5 个榜单站点）
    const category = cfg.discover!.fields.find((f) => f.key === "category")
    const def = category?.defaultValue
    expect(category?.options?.find((o) => o.value === def)?.showWhen?.in).toHaveLength(5)
    // 榜单带详情较慢：run 超时放宽
    expect(cfg.discover?.timeoutSecs).toBe(1500)
    // 费率不变（用户拍板）
    expect(estimateCredits("amazon", "market", 100)).toBe(200)
    expect(estimateCredits("amazon", "discover", 100)).toBe(200)
  })

  it("TEMU 监控注册表：hypebridge 单品详情，按次 10 积分（用户拍板）", () => {
    const mon = SELECTION_PLATFORM_CONFIGS.temu.monitor
    expect(mon).toMatchObject({
      metricsActorId: "hypebridge/temu-scraper",
      reviewActorId: null,
      metricsCreditsPerRun: 10,
    })
    expect(mon?.metricsNote).toMatch(/不含销量/)
    // TEMU 关键词抓取仍是 crw（上一轮已接）
    expect(SELECTION_PLATFORM_CONFIGS.temu.marketActorId).toBe("crw/temu-products-scraper")
    expect(estimateCredits("temu", "monitor", 1)).toBe(10)
  })
})
