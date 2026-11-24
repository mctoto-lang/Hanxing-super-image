/**
 * 平台标签视图的 URL 状态（client-safe）：选品发现 / 市场分析两页共用
 *
 * 筛选、排序、视图全部由 URL 驱动——刷新 / 后退 / 分享链接都能还原，
 * 分页条与筛选栏用同一套组装规则（默认值不落 URL）。
 */

export interface PoolFilterState {
  /** 当前平台标签（必填，决定整个视图口径） */
  platform: string
  country: string
  /** discover / market / monitor；空 = 全部类型 */
  taskType: string
  /** 来源任务 ID */
  task: string
  q: string
  sort: string
  dedupe: boolean
  /** 抓取日期范围（YYYY-MM-DD，含端点） */
  dateFrom: string
  dateTo: string
  /** card（默认）/ table（仅电商有表格视图） */
  view: "card" | "table"
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * YYYY-MM-DD 且是真实日期（2026-13-99 这类格式对但非真实日期的值进 SQL ::date
 * 转换会直接报错）。拆 y/m/d 后用 Date.UTC 构造并回读三项相等才有效（越界日
 * 全拒，闰日与 9999-12-31 保留）；年份 ≥1——0000-01-01 是 JS 能构造但 PG 拒绝
 * 的值，不用 toISOString 往返正是为了拒掉它。
 */
export function isCalendarDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false
  const [y, m, d] = v.split("-").map(Number)
  if (!Number.isInteger(y) || y < 1) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/** searchParams → 筛选状态（非法值回落默认；平台与排序由调用方校验后传入） */
export function parsePoolFilter(
  sp: Record<string, string | string[] | undefined>,
  resolved: { platform: string; sort: string },
): PoolFilterState {
  const dateFrom = first(sp.dateFrom)
  const dateTo = first(sp.dateTo)
  return {
    platform: resolved.platform,
    country: first(sp.country).toUpperCase(),
    taskType: first(sp.taskType),
    task: first(sp.task),
    q: first(sp.q),
    sort: resolved.sort,
    dedupe: first(sp.dedupe) !== "0",
    dateFrom: isCalendarDate(dateFrom) ? dateFrom : "",
    dateTo: isCalendarDate(dateTo) ? dateTo : "",
    view: first(sp.view) === "table" ? "table" : "card",
  }
}

/** 筛选状态 → query 参数（默认值不落 URL；空值省略） */
export function poolQuery(state: Partial<PoolFilterState>): Record<string, string | undefined> {
  const q: Record<string, string | undefined> = {}
  if (state.platform) q.platform = state.platform
  if (state.country) q.country = state.country
  if (state.taskType) q.taskType = state.taskType
  if (state.task) q.task = state.task
  if (state.q) q.q = state.q
  if (state.sort && state.sort !== "newest") q.sort = state.sort
  if (state.dateFrom) q.dateFrom = state.dateFrom
  if (state.dateTo) q.dateTo = state.dateTo
  if (state.dedupe === false) q.dedupe = "0"
  if (state.view === "table") q.view = "table"
  return q
}

/** 筛选状态 + 分页 → 路径（pageSize 非默认值时一并带上） */
export function poolHref(
  basePath: string,
  state: Partial<PoolFilterState>,
  extra: { page?: number; pageSize?: number; defaultPageSize?: number } = {},
): string {
  const q = poolQuery(state)
  if (extra.page && extra.page > 1) q.page = String(extra.page)
  if (extra.pageSize && extra.pageSize !== (extra.defaultPageSize ?? 25)) {
    q.pageSize = String(extra.pageSize)
  }
  const qs = new URLSearchParams(
    Object.entries(q).filter((pair): pair is [string, string] => pair[1] != null),
  ).toString()
  return qs ? `${basePath}?${qs}` : basePath
}

/** 我的选品排序键（URL 驱动；"use server" 文件不能导出同步函数，放这里供页面与 action 共用） */
export const BOOKMARK_SORTS = ["newest", "price_asc", "price_desc", "sales_desc", "likes_desc"] as const
export type BookmarkSort = (typeof BOOKMARK_SORTS)[number]

export const BOOKMARK_SORT_LABELS: Record<BookmarkSort, string> = {
  newest: "最近收藏",
  price_asc: "价格从低到高",
  price_desc: "价格从高到低",
  sales_desc: "销量优先",
  likes_desc: "点赞优先",
}

export function isBookmarkSort(v: string): v is BookmarkSort {
  return (BOOKMARK_SORTS as readonly string[]).includes(v)
}

/** 平台标签切换：保留其它筛选，但国家 / 来源任务 / 搜索词属于原平台，切换时清掉 */
export function platformSwitchQuery(state: PoolFilterState, nextPlatform: string): Record<string, string | undefined> {
  return poolQuery({
    platform: nextPlatform,
    sort: state.sort,
    dedupe: state.dedupe,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    view: state.view,
  })
}
