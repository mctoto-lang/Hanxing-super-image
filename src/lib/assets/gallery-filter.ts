import { endOfDay, startOfDay } from "date-fns"

/**
 * 资产画廊筛选（纯函数，便于单测）。
 *
 * 页面数据由服务端按 createdAt 倒序取回，这里在客户端做
 * 来源/关键词/日期范围/仅收藏的即时过滤。
 */

/** 画廊条目（对应一条已完成的生成任务） */
export interface GalleryItem {
  taskId: string
  prompt: string
  images: string[]
  modelDisplayName: string
  /** 对应 generation_task.source（create/workspace/product/weartry/mockup） */
  source: string
  createdAt: Date | string
}

/** 用户收藏引用（pinned_task 行 → 任务） */
export interface PinnedTaskRef {
  taskId: string
  pinnedId: string
}

/** 瀑布流单图卡片（一个任务展开为多张） */
export interface GalleryCard {
  key: string
  flatIndex: number
  url: string
  item: GalleryItem
}

/** 分类筛选项（value 对应 generation_task.source） */
export const SOURCE_FILTERS = [
  { value: "create", label: "自由创作" },
  { value: "workspace", label: "批量生图" },
  { value: "product", label: "商品图片" },
  { value: "weartry", label: "穿戴图片" },
  { value: "mockup", label: "样机渲染" },
] as const

export type SourceFilter =
  | "all"
  | "pinned"
  | (typeof SOURCE_FILTERS)[number]["value"]

/** 卡片来源角标文案 */
export const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  SOURCE_FILTERS.map((f) => [f.value, f.label]),
)

export function sourceFilterLabel(v: SourceFilter): string {
  if (v === "all") return "全部"
  if (v === "pinned") return "仅收藏"
  return SOURCE_FILTERS.find((f) => f.value === v)?.label ?? "全部"
}

/** 日期范围（两端均可选；react-day-picker 的 DateRange 可直接赋入） */
export interface GalleryDateRange {
  from?: Date
  to?: Date
}

export interface GalleryFilter {
  sourceFilter: SourceFilter
  /** 搜索关键词（内部 trim + 忽略大小写），匹配提示词与模型名 */
  keyword: string
  /** 日期范围，起止均含当天全天（结构上兼容仅选一端的形态） */
  range?: GalleryDateRange
  /** taskId → pinnedId 收藏映射（值真值即视为已收藏，含乐观占位） */
  pinnedMap?: Readonly<Record<string, string | undefined>>
}

/** 是否有任一筛选条件生效 */
export function isFilterActive(filter: GalleryFilter): boolean {
  return (
    filter.sourceFilter !== "all" ||
    filter.keyword.trim() !== "" ||
    filter.range?.from !== undefined ||
    filter.range?.to !== undefined
  )
}

/** 过滤画廊任务（来源 / 关键词 / 日期范围 / 仅收藏） */
export function filterGalleryItems(
  items: GalleryItem[],
  filter: GalleryFilter,
): GalleryItem[] {
  if (!isFilterActive(filter)) return items
  const { from, to } = filter.range ?? {}
  const keyword = filter.keyword.trim().toLowerCase()
  return items.filter((item) => {
    if (filter.sourceFilter === "pinned") {
      if (!filter.pinnedMap?.[item.taskId]) return false
    } else if (
      filter.sourceFilter !== "all" &&
      item.source !== filter.sourceFilter
    ) {
      return false
    }
    if (keyword) {
      const haystack =
        `${item.prompt}\n${item.modelDisplayName}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    if (from || to) {
      // 起止均含当天全天
      const created = new Date(item.createdAt)
      if (from && created < startOfDay(from)) return false
      if (to && created > endOfDay(to)) return false
    }
    return true
  })
}
