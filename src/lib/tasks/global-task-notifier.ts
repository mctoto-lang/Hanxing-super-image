/**
 * 全局生成任务追踪（客户端模块级 store，P1-1 跨页任务通知）
 *
 * 创作页提交任务后登记（trackTask），TaskNotificationCenter（挂在
 * DashboardShell）负责轮询与完成通知——用户切到其他模块也能收到
 * "生成完成" toast / 浏览器通知，不再因组件卸载丢失结果感知。
 *
 * sessionStorage 持久化：刷新/跨页不丢；超时（20 分钟，与任务最长
 * 生命周期一致）自动过期清理。
 */

export interface TrackedTask {
  taskId: string
  /** 完成后"查看"跳转目标会话；新对话提交时由服务端返回 */
  conversationId: string | null
  submittedAt: number
}

const STORAGE_KEY = "create:global-pending-tasks"
/** 与 use-task-polling 的 3s × 400 次上限对齐（20 分钟） */
export const MAX_TRACK_MS = 20 * 60 * 1000

const listeners = new Set<() => void>()

let tracked: TrackedTask[] = []

function load(): TrackedTask[] {
  if (typeof window === "undefined") return []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as TrackedTask[]
    const now = Date.now()
    return arr.filter((t) => now - t.submittedAt < MAX_TRACK_MS)
  } catch {
    return []
  }
}

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tracked))
  } catch {
    // 隐私模式等存储不可用：仅内存态，刷新后丢失（可接受）
  }
}

function emit() {
  for (const fn of listeners) fn()
}

/** 提交成功后登记任务（在提交点击链路内调用，顺带请求通知权限） */
export function trackTask(task: {
  taskId: string
  conversationId: string | null
}) {
  tracked = [
    ...tracked.filter((t) => t.taskId !== task.taskId),
    { ...task, submittedAt: Date.now() },
  ]
  persist()
  emit()
  // 通知权限在用户提交动作的上下文中请求（避免冷启动打扰）
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  ) {
    void Notification.requestPermission()
  }
}

export function untrackTask(taskId: string) {
  if (!tracked.some((t) => t.taskId === taskId)) return
  tracked = tracked.filter((t) => t.taskId !== taskId)
  persist()
  emit()
}

/** 当前待追踪任务（懒加载 sessionStorage，SSR 返回空） */
export function getTrackedTasks(): TrackedTask[] {
  if (tracked.length === 0 && typeof window !== "undefined") {
    tracked = load()
  }
  return tracked
}

/** store 变化订阅（返回取消函数） */
export function subscribeTasks(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
