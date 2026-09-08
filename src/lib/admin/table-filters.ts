/**
 * 管理端列表筛选（积分流水 / 操作日志共用）：
 * URL 参数的解析约定、日期范围换算与模块中文名映射。
 */

/** 模块 → 中文名（generation_task.source 五枚举 + chat 虚拟模块） */
export const MODULE_LABELS: Record<string, string> = {
  chat: "AI 对话",
  create: "自由创作",
  workspace: "批量生图",
  product: "商品图片",
  weartry: "穿戴图片",
  mockup: "样机渲染",
}

/** 积分流水「模块」筛选选项（消费可来自 AI 对话） */
export const CREDIT_MODULE_OPTIONS = [
  "chat",
  "create",
  "workspace",
  "product",
  "weartry",
  "mockup",
] as const

/** 操作日志「模块」筛选选项（generation_task.source 枚举） */
export const TASK_SOURCE_OPTIONS = [
  "create",
  "workspace",
  "product",
  "weartry",
  "mockup",
] as const

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 日期筛选（YYYY-MM-DD）→ 查询范围：from 含、toEnd 为次日 0 点（排除上界）。
 * 日界按 Asia/Shanghai（与数据看板统计口径一致）；非法或缺省的边界忽略。
 */
export function parseDayRange(
  from?: string,
  to?: string,
): { from?: Date; toEnd?: Date } {
  const parseDay = (key?: string) => {
    const v = (key ?? "").trim()
    if (!DAY_KEY_RE.test(v)) return undefined
    const d = new Date(`${v}T00:00:00+08:00`)
    return Number.isNaN(d.getTime()) ? undefined : d
  }
  const fromDate = parseDay(from)
  const toDate = parseDay(to)
  return {
    from: fromDate,
    toEnd: toDate ? new Date(toDate.getTime() + 86400_000) : undefined,
  }
}

/** 组装分页保留用的 query（过滤空值，供 TablePagination 的 query 参数） */
export function filterQuery(params: {
  q?: string
  module?: string
  from?: string
  to?: string
  [key: string]: string | undefined
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value) out[key] = value
  }
  return out
}
