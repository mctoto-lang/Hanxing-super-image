import { describe, it, expect } from "vitest"
import { PLATFORM_VIEWS, POOL_SORT_LABELS, platformView, sortOptionsFor } from "@/lib/selection/platform-views"
import { isPoolSort, POOL_SORTS } from "@/lib/selection/pool-types"
import {
  SELECTION_PLATFORMS,
  SELECTION_PLATFORM_CONFIGS,
  hasInlineReviews,
  platformsForCategory,
} from "@/lib/selection/platforms"
import {
  BOOKMARK_SORT_LABELS,
  BOOKMARK_SORTS,
  isBookmarkSort,
  isCalendarDate,
  parsePoolFilter,
  platformSwitchQuery,
  poolHref,
  poolQuery,
} from "@/lib/selection/pool-url"
import {
  SelectionInputError,
  buildActorInput,
  hasLegacyAmazonCategoryUrl,
} from "@/lib/selection/input-builders"
import { buildTaskQuery, isTaskStatusKey, taskDataHref } from "@/lib/selection/task-links"
import { formatDelta, formatDuration, formatPrice, moneyPrefix } from "@/components/selection/labels"

/**
 * 选品工具视图口径单测（0108）：平台标签视图的排序 / KPI / 表格列声明、URL 状态
 * 组装、任务跳转路由与展示格式化。
 */

describe("平台视图口径", () => {
  it("每个平台都有视图声明，且排序项都是合法的排序键", () => {
    for (const p of SELECTION_PLATFORMS) {
      const v = PLATFORM_VIEWS[p]
      expect(v.platform).toBe(p)
      expect(v.category).toBe(SELECTION_PLATFORM_CONFIGS[p].category)
      expect(v.sorts.length).toBeGreaterThan(0)
      // 首项为默认「最新抓取」
      expect(v.sorts[0]).toBe("newest")
      for (const s of v.sorts) {
        expect(isPoolSort(s)).toBe(true)
        expect(POOL_SORT_LABELS[s]).toBeTruthy()
      }
      expect(v.kpis.length).toBeGreaterThan(0)
    }
  })

  it("社媒只有卡片视图；电商四个平台都有表格列且末列是操作", () => {
    for (const p of platformsForCategory("social")) {
      expect(PLATFORM_VIEWS[p].columns).toEqual([])
      // 社媒没有「销量 / 名次」这类电商排序
      expect(PLATFORM_VIEWS[p].sorts).not.toContain("sales_desc")
      expect(PLATFORM_VIEWS[p].sorts).not.toContain("rank_asc")
    }
    for (const p of platformsForCategory("ecommerce")) {
      const cols = PLATFORM_VIEWS[p].columns
      expect(cols.length).toBeGreaterThan(3)
      expect(cols[cols.length - 1]!.kind).toBe("actions")
      // 表格列里声明的排序键必须在平台排序项内（列头点击才有地方生效）
      for (const c of cols) {
        if (c.sort) expect(PLATFORM_VIEWS[p].sorts).toContain(c.sort)
      }
    }
    // Amazon 独有：名次（榜单名次 / BSR）排序与月购买列
    expect(PLATFORM_VIEWS.amazon.sorts).toContain("rank_asc")
    expect(PLATFORM_VIEWS.amazon.columns.some((c) => c.kind === "rank")).toBe(true)
  })

  it("各平台 KPI 取自己有意义的字段（不跨平台混加）", () => {
    expect(PLATFORM_VIEWS.tiktok.kpis.map((k) => k.key)).toEqual(["count", "sumViews", "sumLikes", "sumComments", "sumShares"])
    expect(PLATFORM_VIEWS.pinterest.kpis.map((k) => k.label)).toEqual(["Pin", "保存", "评论"])
    expect(PLATFORM_VIEWS.x.kpis.some((k) => k.key === "sumViews")).toBe(true)
    expect(PLATFORM_VIEWS.amazon.kpis.map((k) => k.label)).toContain("月购买合计")
  })

  it("platformView 未知平台回落通用口径；sortOptionsFor 给出带文案的选项", () => {
    expect(platformView("nope").sorts[0]).toBe("newest")
    expect(platformView("nope").columns.length).toBeGreaterThan(0)
    expect(sortOptionsFor("temu").map((o) => o.label)).toContain("销量优先")
    expect(POOL_SORTS).toContain("shares_desc")
  })
})

describe("日历日期校验（评论/数据池日期入参共用）", () => {
  it("格式对但非真实日期的值一律拒绝（进 SQL ::date 会直接报错）", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false)
    expect(isCalendarDate("2025-02-29")).toBe(false) // 2025 不是闰年
    expect(isCalendarDate("2026-13-01")).toBe(false)
    expect(isCalendarDate("2026-11-31")).toBe(false)
    expect(isCalendarDate("0000-01-01")).toBe(false) // PG 拒绝年份 0
    expect(isCalendarDate("2026-11-99")).toBe(false)
    expect(isCalendarDate("20261124")).toBe(false)
    expect(isCalendarDate("")).toBe(false)
  })

  it("真实日期放行（含闰日与 PG 可接受的远期上界）", () => {
    expect(isCalendarDate("2026-11-24")).toBe(true)
    expect(isCalendarDate("2024-02-29")).toBe(true)
    expect(isCalendarDate("9999-12-31")).toBe(true)
    expect(isCalendarDate("2026-01-01")).toBe(true)
  })
})

describe("监控评论计费口径（弹窗预估与服务端建任务共用）", () => {
  it("hasInlineReviews：仅 reddit 评论随指标任务带回，不另建独立评论任务", () => {
    expect(hasInlineReviews("reddit")).toBe(true)
    for (const p of SELECTION_PLATFORMS.filter((p) => p !== "reddit")) {
      expect(hasInlineReviews(p)).toBe(false)
    }
  })
})

describe("Amazon 发现入参旧键（categoryUrl）残留", () => {
  it("有旧键且无新 category 键 = 无法安全执行（检测 helper）", () => {
    expect(hasLegacyAmazonCategoryUrl({ categoryUrl: "https://www.amazon.com/gp/bestsellers/beauty" })).toBe(true)
    expect(hasLegacyAmazonCategoryUrl({ categoryUrl: "https://www.amazon.com/gp/bestsellers/beauty", category: "beauty" })).toBe(false)
    expect(hasLegacyAmazonCategoryUrl({ category: "beauty" })).toBe(false)
    expect(hasLegacyAmazonCategoryUrl({})).toBe(false)
    expect(hasLegacyAmazonCategoryUrl(null)).toBe(false)
    expect(hasLegacyAmazonCategoryUrl({ categoryUrl: "  " })).toBe(false)
  })

  it("buildActorInput 拒绝残留旧键：绝不静默回落默认品类（美妆→消费电子）抓错类目", () => {
    expect(() =>
      buildActorInput({
        platform: "amazon",
        taskType: "discover",
        params: { categoryUrl: "https://www.amazon.com/gp/bestsellers/beauty" },
        maxResults: 10,
      }),
    ).toThrowError(SelectionInputError)
    // 新键正常路径不受影响
    const built = buildActorInput({
      platform: "amazon",
      taskType: "discover",
      params: { listType: "bestsellers", country: "US", category: "beauty" },
      maxResults: 10,
    })
    expect(built.actorId).toBe("junglee/amazon-bestsellers")
    expect(JSON.stringify(built.runInput)).toContain("/gp/bestsellers/beauty")
  })
})

describe("平台标签视图 URL 状态", () => {
  it("parsePoolFilter：非法值回落默认", () => {
    expect(
      parsePoolFilter(
        { country: "uk", dateFrom: "2026-13-99", dateTo: "2026-11-20", view: "table", dedupe: "0", sort: "bogus" },
        { platform: "amazon", sort: "newest" },
      ),
    ).toEqual({
      platform: "amazon",
      country: "UK",
      taskType: "",
      task: "",
      q: "",
      sort: "newest",
      dedupe: false,
      dateFrom: "",
      dateTo: "2026-11-20",
      view: "table",
    })
  })

  it("poolQuery：默认值不落 URL", () => {
    expect(poolQuery({ platform: "temu", sort: "newest", dedupe: true, view: "card" })).toEqual({ platform: "temu" })
    expect(
      poolQuery({
        platform: "temu",
        country: "US",
        taskType: "discover",
        task: "t1",
        q: "case",
        sort: "sales_desc",
        dedupe: false,
        dateFrom: "2026-11-01",
        dateTo: "2026-11-20",
        view: "table",
      }),
    ).toEqual({
      platform: "temu",
      country: "US",
      taskType: "discover",
      task: "t1",
      q: "case",
      sort: "sales_desc",
      dateFrom: "2026-11-01",
      dateTo: "2026-11-20",
      dedupe: "0",
      view: "table",
    })
  })

  it("platformSwitchQuery：切平台保留排序 / 日期 / 视图，清掉属于原平台的国家、任务、搜索词", () => {
    const q = platformSwitchQuery(
      {
        platform: "amazon",
        country: "US",
        taskType: "discover",
        task: "t1",
        q: "earbuds",
        sort: "rank_asc",
        dedupe: true,
        dateFrom: "2026-11-01",
        dateTo: "",
        view: "table",
      },
      "temu",
    )
    expect(q).toEqual({ platform: "temu", sort: "rank_asc", dateFrom: "2026-11-01", view: "table" })
  })

  it("poolHref：分页与非默认每页数量入 query", () => {
    expect(poolHref("/selection/discover", { platform: "amazon" })).toBe("/selection/discover?platform=amazon")
    expect(poolHref("/selection/discover", { platform: "amazon", sort: "price_asc" }, { page: 3, pageSize: 50 })).toBe(
      "/selection/discover?platform=amazon&sort=price_asc&page=3&pageSize=50",
    )
    expect(poolHref("/selection/discover", {}, { page: 1, pageSize: 25 })).toBe("/selection/discover")
  })

  it("我的选品排序键", () => {
    expect(BOOKMARK_SORTS).toEqual(["newest", "price_asc", "price_desc", "sales_desc", "likes_desc"])
    expect(isBookmarkSort("likes_desc")).toBe(true)
    expect(isBookmarkSort("views_desc")).toBe(false)
    expect(BOOKMARK_SORT_LABELS.newest).toBe("最近收藏")
  })
})

describe("任务跳转路由", () => {
  it("按任务类型与平台类别跳到对应页面", () => {
    // 此前恒跳 /selection/discover?task=…——社媒任务的发现页只收电商数据，点开是空的
    expect(taskDataHref({ id: "a", platform: "amazon", taskType: "market" })).toBe(
      "/selection/discover?platform=amazon&task=a",
    )
    expect(taskDataHref({ id: "b", platform: "tiktok", taskType: "discover" })).toBe(
      "/selection/market?platform=tiktok&task=b",
    )
    expect(taskDataHref({ id: "c", platform: "temu", taskType: "monitor" })).toBe("/selection/competitor?platform=temu")
    expect(taskDataHref({ id: "d", platform: "etsy", taskType: "review" })).toBe("/selection/reviews?platform=etsy")
    expect(taskDataHref({ id: "e", platform: "nope", taskType: "monitor" })).toBe("/selection/competitor")
  })

  it("状态标签键校验 + 任务列表 URL 组装", () => {
    expect(isTaskStatusKey("active")).toBe(true)
    expect(isTaskStatusKey("all")).toBe(true)
    expect(isTaskStatusKey("done")).toBe(false)
    const filter = { platform: "", taskType: "", q: "" }
    // 进行中是默认状态，不落 URL
    expect(buildTaskQuery("active", filter, {})).toBe("/selection/tasks")
    expect(buildTaskQuery("completed", filter, { platform: "temu", taskType: "market", q: "case" }, 2)).toBe(
      "/selection/tasks?status=completed&platform=temu&type=market&q=case&page=2",
    )
  })
})

describe("展示格式化", () => {
  it("金额：USD 用 $，其它币种前置 ISO 码；整数不带小数", () => {
    expect(formatPrice(20.98, "USD")).toBe("$20.98")
    expect(formatPrice(149, "USD")).toBe("$149")
    expect(formatPrice(119.99, "GBP")).toBe("GBP 119.99")
    expect(formatPrice(null)).toBe("—")
    expect(formatPrice(Number.NaN)).toBe("—")
    expect(moneyPrefix(null)).toBe("$")
    expect(moneyPrefix("JPY")).toBe("JPY ")
  })

  it("时长：秒 → m:ss", () => {
    expect(formatDuration(179.866)).toBe("3:00")
    expect(formatDuration(8)).toBe("0:08")
    expect(formatDuration(null)).toBe("")
    expect(formatDuration(-1)).toBe("")
  })

  it("涨跌百分比：正负号、一位小数、从 0 起算记为「新」", () => {
    expect(formatDelta(120, 100)).toBe("+20%")
    expect(formatDelta(90, 100)).toBe("−10%")
    expect(formatDelta(101.5, 100)).toBe("+1.5%")
    expect(formatDelta(5, 0)).toBe("新")
    expect(formatDelta(100, 100)).toBe("0%")
    expect(formatDelta(null, 100)).toBeNull()
    expect(formatDelta(100, null)).toBeNull()
  })
})
