import { SELECTION_PLATFORM_CONFIGS, isSelectionPlatform } from "@/lib/selection/platforms"

/**
 * 任务「查看数据」的去处（client-safe）：按任务类型与平台类别跳到对应页面。
 * 此前恒跳 /selection/discover?task=…——社媒任务的「发现页」只收电商数据，
 * 点开是空的；监控 / 评论型任务的数据也不在数据池。
 */
export function taskDataHref(task: {
  id: string
  platform: string
  taskType: string
}): string | null {
  const p = isSelectionPlatform(task.platform) ? task.platform : null
  if (task.taskType === "monitor") {
    return p ? `/selection/competitor?platform=${p}` : "/selection/competitor"
  }
  if (task.taskType === "review") {
    return p ? `/selection/reviews?platform=${p}` : "/selection/reviews"
  }
  if (!p) return `/selection/discover?task=${task.id}`
  const social = SELECTION_PLATFORM_CONFIGS[p].category === "social"
  return social
    ? `/selection/market?platform=${p}&task=${task.id}`
    : `/selection/discover?platform=${p}&task=${task.id}`
}

/**
 * 任务列表筛选 → URL（服务端页面拼状态标签链接与客户端筛选栏共用，故放 client-safe 模块）
 */
export interface TaskFilter {
  platform: string
  taskType: string
  q: string
}

export function buildTaskQuery(
  status: string,
  filter: TaskFilter,
  patch: Partial<TaskFilter>,
  page = 1,
): string {
  const f = { ...filter, ...patch }
  const params = new URLSearchParams()
  if (status && status !== "active") params.set("status", status)
  if (f.platform) params.set("platform", f.platform)
  if (f.taskType) params.set("type", f.taskType)
  if (f.q) params.set("q", f.q)
  if (page > 1) params.set("page", String(page))
  const qs = params.toString()
  return qs ? `/selection/tasks?${qs}` : "/selection/tasks"
}

/** 数据任务页状态标签（key = URL status 参数） */
export const TASK_STATUS_TABS = [
  { key: "active", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
  { key: "cancelled", label: "已取消" },
  { key: "all", label: "全部" },
] as const
export type TaskStatusKey = (typeof TASK_STATUS_TABS)[number]["key"]

export function isTaskStatusKey(v: string): v is TaskStatusKey {
  return (TASK_STATUS_TABS as ReadonlyArray<{ key: string }>).some((t) => t.key === v)
}

export const TASK_TYPE_OPTIONS = [
  { value: "discover", label: "选品发现" },
  { value: "market", label: "市场分析" },
  { value: "monitor", label: "竞品监控" },
  { value: "review", label: "评论抓取" },
] as const
export const TASK_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  TASK_TYPE_OPTIONS.map((t) => [t.value, t.label]),
)
