/**
 * 全局选品任务追踪（客户端模块级 store，镜像 global-task-notifier 模式）
 *
 * 市场/发现页提交抓取任务后登记（trackSelectionTask），挂载于 DashboardShell
 * 的 SelectionTaskNotifier 轮询状态——切到其他模块也能收到「抓取完成」toast，
 * 完成后 router.refresh() 让任务页/历史结果随刷新出现。
 *
 * sessionStorage 持久化；超时 40 分钟（对齐单任务 30 分钟轮询超时 + 缓冲）
 * 自动过期清理。
 */

export interface TrackedSelectionTask {
  taskId: string
  /** 展示名（平台+关键词，toast 用） */
  label: string
  submittedAt: number
}

const STORAGE_KEY = "selection:pending-tasks"
export const SELECTION_MAX_TRACK_MS = 40 * 60 * 1000

const listeners = new Set<() => void>()

let tracked: TrackedSelectionTask[] = []

function load(): TrackedSelectionTask[] {
  if (typeof window === "undefined") return []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as TrackedSelectionTask[]
    const now = Date.now()
    return arr.filter((t) => now - t.submittedAt < SELECTION_MAX_TRACK_MS)
  } catch {
    return []
  }
}

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tracked))
  } catch {
    // 存储不可用时仅内存态
  }
}

function emit() {
  for (const fn of listeners) fn()
}

/** 提交成功后登记（提交点击链路内调用，顺带请求通知权限） */
export function trackSelectionTask(task: { taskId: string; label: string }) {
  // 页面刷新后内存态为空，直接覆写会丢掉 sessionStorage 里的旧追踪，先恢复再合并
  if (tracked.length === 0) tracked = load()
  tracked = [
    ...tracked.filter((t) => t.taskId !== task.taskId),
    { ...task, submittedAt: Date.now() },
  ]
  persist()
  emit()
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  ) {
    void Notification.requestPermission()
  }
}

export function untrackSelectionTask(taskId: string) {
  if (!tracked.some((t) => t.taskId === taskId)) return
  tracked = tracked.filter((t) => t.taskId !== taskId)
  persist()
  emit()
}

export function getTrackedSelectionTasks(): TrackedSelectionTask[] {
  if (tracked.length === 0 && typeof window !== "undefined") {
    tracked = load()
  }
  return tracked
}

export function subscribeSelectionTasks(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
