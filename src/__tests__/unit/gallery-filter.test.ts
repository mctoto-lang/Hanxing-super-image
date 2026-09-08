import { describe, expect, it } from "vitest"
import {
  filterGalleryItems,
  isFilterActive,
  type GalleryItem,
} from "@/lib/assets/gallery-filter"

/**
 * 资产画廊客户端筛选单测。
 *
 * 所有时间（含范围边界）一律用带时间的本地字符串构造：日期-only
 * 字符串会被 JS 按 UTC 解析，与本地时区的 startOfDay/endOfDay 混用
 * 会让边界随时区漂移。startOfDay/endOfDay 按本地时区计算，因此测试
 * 在任何时区下结果一致。
 */

const d = (s: string) => new Date(s)

function item(partial: Partial<GalleryItem> & { taskId: string }): GalleryItem {
  return {
    prompt: "",
    images: ["u"],
    modelDisplayName: "",
    source: "create",
    createdAt: d("2026-09-01T00:00:00"),
    ...partial,
  }
}

// 09/05、09/03（当天深夜）、09/02（字符串时间）、09/01（weartry）、08/28 各一条
const items: GalleryItem[] = [
  item({ taskId: "t1", prompt: "海边日落", modelDisplayName: "模型A", createdAt: d("2026-09-05T10:00:00") }),
  item({ taskId: "t2", prompt: "白底商品图", modelDisplayName: "模型B", source: "product", createdAt: d("2026-09-03T23:30:00") }),
  item({ taskId: "t3", prompt: "街道写真", createdAt: "2026-09-02T12:00:00" }),
  item({ taskId: "t4", prompt: "穿戴模特", modelDisplayName: "模型A", source: "weartry", createdAt: d("2026-09-01T08:00:00") }),
  item({ taskId: "t5", prompt: "seaside mockup", modelDisplayName: "模型C", source: "mockup", createdAt: d("2026-08-28T12:00:00") }),
]

const ids = (list: GalleryItem[]) => list.map((i) => i.taskId)

describe("isFilterActive", () => {
  it("默认无筛选", () => {
    expect(isFilterActive({ sourceFilter: "all", keyword: "" })).toBe(false)
    expect(isFilterActive({ sourceFilter: "all", keyword: "  " })).toBe(false)
  })

  it("来源 / 关键词 / 日期任一生效（含仅 to）", () => {
    expect(isFilterActive({ sourceFilter: "product", keyword: "" })).toBe(true)
    expect(isFilterActive({ sourceFilter: "all", keyword: "x" })).toBe(true)
    expect(
      isFilterActive({
        sourceFilter: "all",
        keyword: "",
        range: { from: d("2026-09-01T00:00:00") },
      }),
    ).toBe(true)
    expect(
      isFilterActive({
        sourceFilter: "all",
        keyword: "",
        range: { to: d("2026-09-01T00:00:00") },
      }),
    ).toBe(true)
  })
})

describe("filterGalleryItems: 日期范围", () => {
  const byDate = (range: { from?: Date; to?: Date }) =>
    ids(filterGalleryItems(items, { sourceFilter: "all", keyword: "", range }))

  it("完整范围 09/02 - 09/03（含起止当天全天）", () => {
    expect(
      byDate({ from: d("2026-09-02T00:00:00"), to: d("2026-09-03T00:00:00") }),
    ).toEqual(["t2", "t3"])
  })

  it("仅 from：保留当天及之后", () => {
    expect(byDate({ from: d("2026-09-02T00:00:00") })).toEqual(["t1", "t2", "t3"])
  })

  it("仅 to：保留当天及之前，含当天深夜（23:30）", () => {
    expect(byDate({ to: d("2026-09-03T00:00:00") })).toEqual(["t2", "t3", "t4", "t5"])
  })

  it("起止同一天：00:00 与 23:59 边界均包含", () => {
    const day = [
      item({ taskId: "s0", createdAt: d("2026-09-03T00:00:00") }),
      item({ taskId: "s1", createdAt: d("2026-09-03T23:59:59") }),
      item({ taskId: "s2", createdAt: d("2026-09-02T23:59:59") }),
      item({ taskId: "s3", createdAt: d("2026-09-04T00:00:00") }),
    ]
    expect(
      ids(
        filterGalleryItems(day, {
          sourceFilter: "all",
          keyword: "",
          range: {
            from: d("2026-09-03T00:00:00"),
            to: d("2026-09-03T00:00:00"),
          },
        }),
      ),
    ).toEqual(["s0", "s1"])
  })

  it("范围不与任何图片相交时为空", () => {
    expect(
      byDate({ from: d("2026-10-01T00:00:00"), to: d("2026-10-02T00:00:00") }),
    ).toEqual([])
  })

  it("字符串型 createdAt 同样按时间过滤", () => {
    expect(byDate({ to: d("2026-09-02T00:00:00") })).toContain("t3")
    expect(byDate({ from: d("2026-09-03T00:00:00") })).not.toContain("t3")
  })
})

describe("filterGalleryItems: 来源与仅收藏", () => {
  it("按来源筛选", () => {
    expect(
      ids(filterGalleryItems(items, { sourceFilter: "product", keyword: "" })),
    ).toEqual(["t2"])
    expect(
      ids(filterGalleryItems(items, { sourceFilter: "weartry", keyword: "" })),
    ).toEqual(["t4"])
  })

  it("仅收藏按 pinnedMap 过滤（含乐观占位值）", () => {
    const pinnedMap = { t1: "p1", t5: "__pending__" }
    expect(
      ids(
        filterGalleryItems(items, {
          sourceFilter: "pinned",
          keyword: "",
          pinnedMap,
        }),
      ),
    ).toEqual(["t1", "t5"])
  })
})

describe("filterGalleryItems: 关键词与组合", () => {
  const byKeyword = (keyword: string) =>
    ids(filterGalleryItems(items, { sourceFilter: "all", keyword }))

  it("匹配提示词（中文、忽略首尾空格）", () => {
    expect(byKeyword(" 海边 ")).toEqual(["t1"])
  })

  it("匹配模型名（忽略大小写）", () => {
    expect(byKeyword("模型b")).toEqual(["t2"])
  })

  it("匹配英文提示词（忽略大小写）", () => {
    expect(byKeyword("SEASIDE")).toEqual(["t5"])
  })

  it("来源 + 日期组合过滤（范围内 create 仅 t3）", () => {
    expect(
      ids(
        filterGalleryItems(items, {
          sourceFilter: "create",
          keyword: "",
          range: {
            from: d("2026-09-01T00:00:00"),
            to: d("2026-09-04T00:00:00"),
          },
        }),
      ),
    ).toEqual(["t3"])
  })
})
