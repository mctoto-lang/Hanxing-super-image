"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  getTrackedTasks,
  subscribeTasks,
  untrackTask,
  MAX_TRACK_MS,
  type TrackedTask,
} from "@/lib/tasks/global-task-notifier"

/**
 * 全局任务通知中心（挂在 DashboardShell，P1-1）
 *
 * 轮询所有已登记的生成任务（跨页存活，sessionStorage 恢复），完成/失败时：
 * - 全局 toast（带「查看」跳转动作）；
 * - 页面不可见且已授权时发浏览器系统通知；
 * - router.refresh() 刷新当前页（如在资产管理页，新图随刷新出现）。
 *
 * 与创作页本地轮询的分工：本地（useTaskPolling）只负责输入框 UI 状态，
 * toast/通知统一由本中心发出，避免重复提示。
 */

const POLL_INTERVAL_MS = 4000

interface PollResult {
  status: "completed" | "failed" | "pending"
  errorMessage?: string | null
}

async function pollTask(taskId: string): Promise<PollResult | null> {
  try {
    const resp = await fetch(`/api/tasks/${taskId}/result`)
    // 会话过期被重定向到 /login：fetch 跟随后返回 200 HTML
    const contentType = resp.headers.get("content-type") ?? ""
    if (contentType.includes("text/html")) return null
    if (!resp.ok) return { status: "pending" }
    const data = (await resp.json()) as {
      status: string
      errorMessage?: string | null
    }
    if (data.status === "completed") return { status: "completed" }
    if (data.status === "failed") {
      return { status: "failed", errorMessage: data.errorMessage }
    }
    return { status: "pending" }
  } catch {
    // 网络抖动：本轮当作未完成，下轮重试
    return { status: "pending" }
  }
}

function notifySystemNotification(task: TrackedTask, onOpen: () => void) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    !document.hidden
  ) {
    return
  }
  try {
    const n = new Notification("瀚星 Super Image", {
      body: "图片生成完成，点击查看",
      tag: task.taskId,
    })
    n.onclick = () => {
      window.focus()
      onOpen()
    }
  } catch {
    // 个别浏览器 Notification 构造受限：忽略，toast 仍会送达
  }
}

export function TaskNotificationCenter() {
  const router = useRouter()
  // store 版本号：track/untrack 触发重渲染读取最新列表
  const [, bump] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => subscribeTasks(bump), [bump])

  // 轮询快照经 ref 读取，避免定时器随渲染重建
  const routerRef = React.useRef(router)
  React.useEffect(() => {
    routerRef.current = router
  })

  React.useEffect(() => {
    const timer = setInterval(async () => {
      const tasks = getTrackedTasks()
      const now = Date.now()
      // 超时任务静默清理（与任务最长生命周期一致）
      for (const t of tasks) {
        if (now - t.submittedAt > MAX_TRACK_MS) untrackTask(t.taskId)
      }
      const active = getTrackedTasks()
      if (active.length === 0) return
      const results = await Promise.all(
        active.map(async (t) => ({ task: t, result: await pollTask(t.taskId) })),
      )
      let anyDone = false
      let sessionExpired = false
      for (const { task, result } of results) {
        if (result === null) {
          sessionExpired = true
          untrackTask(task.taskId)
          continue
        }
        if (result.status === "completed") {
          anyDone = true
          untrackTask(task.taskId)
          toast.success("图片生成完成", {
            duration: 8000,
            action: {
              label: "查看",
              onClick: () =>
                routerRef.current.push(
                  task.conversationId
                    ? `/create?c=${task.conversationId}`
                    : "/create",
                ),
            },
          })
          notifySystemNotification(task, () =>
            routerRef.current.push(
              task.conversationId
                ? `/create?c=${task.conversationId}`
                : "/create",
            ),
          )
        } else if (result.status === "failed") {
          untrackTask(task.taskId)
          toast.error(
            (result.errorMessage ?? "生成失败").slice(0, 80),
          )
        }
      }
      if (sessionExpired) {
        toast.warning("登录状态已过期，生成结果请重新登录后查看")
      }
      if (anyDone) routerRef.current.refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  return null
}
