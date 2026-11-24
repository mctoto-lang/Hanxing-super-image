import { describe, it, expect } from "vitest"
import {
  MONITOR_URL_PLATFORMS,
  canonicalTemuUrl,
  resolveMonitorTarget,
  temuGoodsIdFromUrl,
} from "@/lib/selection/monitor-target"
import {
  AMAZON_DEFAULT_CATEGORY,
  AMAZON_LIST_SITES,
  AMAZON_LIST_TYPES,
  amazonAsinFromUrl,
  canonicalAmazonUrl,
  amazonCategoryLabel,
  amazonCurrencyForHost,
  amazonCurrencyForSite,
  amazonCurrencyForSymbol,
  amazonDomainForSite,
  amazonListCategories,
  amazonListSupported,
  amazonListUrl,
} from "@/lib/selection/amazon-lists"

/**
 * 监控目标链接解析 + Amazon 榜单矩阵单测（0108）：
 * 「添加监控」粘贴链接 → 平台 / 规范链接 / 平台 ID；Amazon 榜单站点 × 类型 × 品类
 * 的实测支持矩阵（不支持组合返回 null，调用方不得提交）。
 */

/** 解析成功时返回目标，否则直接让用例失败 */
function targetOf(url: string) {
  const r = resolveMonitorTarget(url)
  if (!r.ok) throw new Error(`应解析成功：${url} → ${r.error}`)
  return r.target
}

function errorOf(url: string): string {
  const r = resolveMonitorTarget(url)
  if (r.ok) throw new Error(`应解析失败：${url}`)
  return r.error
}

describe("resolveMonitorTarget：各平台链接解析与规范化", () => {
  it("amazon：ASIN、站点、去追踪参数", () => {
    expect(targetOf("https://www.amazon.com/gp/product/B0BTYDLTM3?smid=A294P4X9EWVXLJ&ref_=x")).toEqual({
      platform: "amazon",
      url: "https://www.amazon.com/dp/B0BTYDLTM3",
      externalId: "B0BTYDLTM3",
      country: "US",
    })
    expect(targetOf("https://www.amazon.co.uk/dp/B00NTCH52W").country).toBe("UK")
    // 省略协议、商品 ID 小写也能解析并归一成大写
    expect(targetOf("amazon.de/dp/b09k5px8rh")).toEqual({
      platform: "amazon",
      url: "https://www.amazon.de/dp/B09K5PX8RH",
      externalId: "B09K5PX8RH",
      country: "DE",
    })
  })

  it("amazon：搜索页 / 非 ASIN 链接给出明确错误", () => {
    expect(errorOf("https://www.amazon.com/s?k=earbuds")).toMatch(/ASIN/)
  })

  it("etsy / temu：路径或参数里的 ID → 规范链接", () => {
    expect(targetOf("https://www.etsy.com/listing/1255225544/handmade-necklace?ref=share")).toEqual({
      platform: "etsy",
      url: "https://www.etsy.com/listing/1255225544",
      externalId: "1255225544",
      country: null,
    })
    // TEMU：带追踪参数的 goods.html 与 …-g<id>.html 两种形态归一成同一条规范链接
    const a = targetOf("https://www.temu.com/goods.html?_bg_fs=1&goods_id=601099837209625&_oak_mp_inf=EJn4")
    const b = targetOf("https://www.temu.com/stainless-steel-peeler-g-601099837209625.html")
    expect(a).toEqual({
      platform: "temu",
      url: "https://www.temu.com/goods.html?goods_id=601099837209625",
      externalId: "601099837209625",
      country: "US",
    })
    expect(b).toEqual(a)
  })

  it("社媒：Instagram / TikTok / Pinterest / Reddit / X / Facebook", () => {
    expect(targetOf("https://www.instagram.com/reel/ABC123/?igsh=xxx")).toEqual({
      platform: "instagram",
      url: "https://www.instagram.com/p/ABC123/",
      externalId: "ABC123",
      country: null,
    })
    expect(
      targetOf("https://www.tiktok.com/@sunsoulandtarot/video/7692799546451070239?is_from_webapp=1"),
    ).toEqual({
      platform: "tiktok",
      url: "https://www.tiktok.com/@sunsoulandtarot/video/7692799546451070239",
      externalId: "7692799546451070239",
      country: null,
    })
    expect(targetOf("https://in.pinterest.com/pin/e1_AfqPShwaVw4LCIhyf/")).toEqual({
      platform: "pinterest",
      url: "https://www.pinterest.com/pin/e1_AfqPShwaVw4LCIhyf/",
      externalId: "e1_AfqPShwaVw4LCIhyf",
      country: null,
    })
    expect(
      targetOf("https://old.reddit.com/r/BuyItForLife/comments/1xdlvjo/what_is_the_best/?sort=top"),
    ).toEqual({
      platform: "reddit",
      url: "https://www.reddit.com/r/BuyItForLife/comments/1xdlvjo/",
      externalId: "1xdlvjo",
      country: null,
    })
    expect(targetOf("https://twitter.com/gadgetfan/status/2124906543069925394?s=20")).toEqual({
      platform: "x",
      url: "https://x.com/gadgetfan/status/2124906543069925394",
      externalId: "2124906543069925394",
      country: null,
    })
    expect(targetOf("https://www.facebook.com/reel/1708024954289524/")).toEqual({
      platform: "facebook",
      url: "https://www.facebook.com/reel/1708024954289524",
      externalId: "1708024954289524",
      country: null,
    })
  })

  it("错误路径：空链接 / 不支持的平台 / 无法解析的短链 / 主页", () => {
    expect(resolveMonitorTarget("   ").ok).toBe(false)
    expect(errorOf("https://www.example.com/product/1")).toMatch(/Shopify 商品请从选品发现卡片/)
    expect(errorOf("https://pin.it/abc123")).toMatch(/短链/)
    expect(resolveMonitorTarget("https://www.instagram.com/").ok).toBe(false)
    expect(resolveMonitorTarget("https://www.facebook.com/share/r/AbCdEf/123").ok).toBe(false)
    expect(resolveMonitorTarget("https://www.temu.com/search_result.html?search_key=x").ok).toBe(false)
    // 支持粘贴链接的平台清单与解析规则一致（Shopify 无固定域名特征，不在其中）
    expect(MONITOR_URL_PLATFORMS).toEqual([
      "amazon",
      "etsy",
      "temu",
      "instagram",
      "tiktok",
      "pinterest",
      "reddit",
      "x",
      "facebook",
    ])
  })
})

describe("TEMU 链接工具", () => {
  it("temuGoodsIdFromUrl / canonicalTemuUrl", () => {
    expect(temuGoodsIdFromUrl("https://www.temu.com/goods.html?goods_id=601099837209625")).toBe("601099837209625")
    expect(temuGoodsIdFromUrl("https://www.temu.com/a-b-g-601099837209625.html")).toBe("601099837209625")
    expect(temuGoodsIdFromUrl("https://www.temu.com/")).toBeNull()
    expect(canonicalTemuUrl("601099837209625")).toBe("https://www.temu.com/goods.html?goods_id=601099837209625")
    expect(canonicalTemuUrl("https://www.temu.com/x-g-601099837209625.html?ref=a")).toBe(
      "https://www.temu.com/goods.html?goods_id=601099837209625",
    )
    expect(canonicalTemuUrl(null)).toBeNull()
    expect(canonicalTemuUrl("https://www.temu.com/search_result.html?search_key=x")).toBeNull()
  })
})

describe("Amazon 榜单：实测支持矩阵", () => {
  it("榜单类型只有畅销榜与新品榜（飙升榜实测不支持）；德国站不提供", () => {
    expect(AMAZON_LIST_TYPES.map((t) => t.value)).toEqual(["bestsellers", "new-releases"])
    expect(AMAZON_LIST_SITES).toEqual(["US", "UK", "JP", "CA", "FR"])
    expect(amazonListUrl("US", "bestsellers", "electronics")).toBe("https://www.amazon.com/gp/bestsellers/electronics")
    expect(amazonListUrl("UK", "new-releases", "kitchen")).toBe("https://www.amazon.co.uk/gp/new-releases/kitchen")
    expect(amazonListUrl("JP", "bestsellers", "office-products")).toBe("https://www.amazon.co.jp/gp/bestsellers/office-products")
    expect(amazonListUrl("US", "movers-and-shakers", "electronics")).toBeNull()
    expect(amazonListUrl("DE", "bestsellers", "electronics")).toBeNull()
    expect(amazonListUrl("US", "bestsellers", "")).toBeNull()
  })

  it("品类随站点变化（表单选项的 showWhen 与此同源）", () => {
    expect(amazonListSupported("US", "sporting-goods")).toBe(true)
    expect(amazonListSupported("UK", "sporting-goods")).toBe(false)
    expect(amazonListSupported("UK", "home-garden")).toBe(true)
    expect(amazonListSupported("JP", "home-garden")).toBe(false)
    expect(amazonListSupported("CA", "office-products")).toBe(false)
    expect(amazonListCategories("FR")).toEqual(["electronics", "kitchen", "fashion", "beauty", "pet-supplies"])
    // 每个站点都支持的默认品类一定可用
    expect(AMAZON_LIST_SITES.every((s) => amazonListSupported(s, AMAZON_DEFAULT_CATEGORY))).toBe(true)
    expect(amazonCategoryLabel("home-garden")).toBe("家居花园")
    expect(amazonCategoryLabel("unknown")).toBe("unknown")
  })

  it("币种：域名 / 站点 / 符号", () => {
    expect(amazonDomainForSite("UK")).toBe("amazon.co.uk")
    expect(amazonDomainForSite("XX")).toBe("amazon.com")
    expect(amazonCurrencyForSite("JP")).toBe("JPY")
    expect(amazonCurrencyForSite("FR")).toBe("EUR")
    expect(amazonCurrencyForHost("www.amazon.co.uk")).toBe("GBP")
    expect(amazonCurrencyForHost("smile.amazon.de")).toBe("EUR")
    expect(amazonCurrencyForHost("www.etsy.com")).toBeNull()
    expect(amazonCurrencyForSymbol("£")).toBe("GBP")
    expect(amazonCurrencyForSymbol("€")).toBe("EUR")
    expect(amazonCurrencyForSymbol("?")).toBeNull()
  })

  it("amazonAsinFromUrl / canonicalAmazonUrl", () => {
    expect(amazonAsinFromUrl("https://www.amazon.com/dp/B0BTYDLTM3?th=1")).toBe("B0BTYDLTM3")
    expect(amazonAsinFromUrl("https://www.amazon.com/gp/product/B09K5PX8RH")).toBe("B09K5PX8RH")
    expect(amazonAsinFromUrl("https://www.amazon.com/s?k=x")).toBeNull()
    expect(canonicalAmazonUrl({ asin: "B0BTYDLTM3", site: "DE" })).toBe("https://www.amazon.de/dp/B0BTYDLTM3")
    expect(canonicalAmazonUrl({ url: "https://www.amazon.co.uk/dp/B00NTCH52W?ref=x" })).toBe(
      "https://www.amazon.co.uk/dp/B00NTCH52W",
    )
    // 无 ASIN 时原样返回
    expect(canonicalAmazonUrl({ url: "https://example.com/x" })).toBe("https://example.com/x")
  })
})
