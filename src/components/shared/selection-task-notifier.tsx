"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { getSelectionTaskStatusesAction } from "@/server/actions/selection"
import {
  getTrackedSelectionTasks,
  subscribeSelectionTasks,
  untrackSelectionTask,
  SELECTION_MAX_TRACK_MS,
  type TrackedSelectionTask,
} from "@/lib/selection/notifier-store"

/**
 * 全局选品任务通知中心（挂 DashboardShell，镜像 TaskNotificationCenter 模式）
 *
 * 轮询已登记的选品抓取任务（跨页存活，sessionStorage 恢复），终态时：
 * - toast（完成=结果条数+「查看」跳任务页；失败/取消=原因）；
 * - router.refresh() 刷新当前页（任务列表/历史结果随刷新出现）。
 */

const POLL_INTERVAL_MS = 5000

export function SelectionTaskNotifier() {
  const router = useRouter()
  const [, bump] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => subscribeSelectionTasks(bump), [bump])

  const routerRef = React.useRef(router)
  React.useEffect(() => {
    routerRef.current = router
  })

  React.useEffect(() => {
    const timer = setInterval(async () => {
      const tasks = getTrackedSelectionTasks()
      const now = Date.now()
      for (const t of tasks) {
        if (now - t.submittedAt > SELECTION_MAX_TRACK_MS) untrackSelectionTask(t.taskId)
      }
      const active = getTrackedSelectionTasks()
      if (active.length === 0) return

      let result: Awaited<ReturnType<typeof getSelectionTaskStatusesAction>>
      try {
        result = await getSelectionTaskStatusesAction(active.map((t) => t.taskId))
      } catch {
        return // 会话过期/网络抖动：本轮跳过
      }
      const byId = new Map(result.items.map((r) => [r.id, r]))
      let anyDone = false
      for (const task of active) {
        const row = byId.get(task.taskId)
        if (!row) {
          // 查不到（被删/越权）：静默移除
          untrackSelectionTask(task.taskId)
          continue
        }
        if (row.status === "completed") {
          anyDone = true
          untrackSelectionTask(task.taskId)
          toast.success(`选品任务完成：${task.label}`, {
            duration: 8000,
            action: {
              label: "查看",
              onClick: () => routerRef.current.push("/selection/tasks"),
            },
          })
          notifySystem(`选品任务完成：${task.label}`, task)
        } else if (row.status === "failed") {
          anyDone = true
          untrackSelectionTask(task.taskId)
          toast.error(`选品任务失败：${task.label}（积分已退还，详见任务页）`)
        } else if (row.status === "cancelled") {
          untrackSelectionTask(task.taskId)
        }
      }
      if (anyDone) routerRef.current.refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  return null
}

function notifySystem(body: string, task: TrackedSelectionTask) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    !document.hidden
  ) {
    return
  }
  try {
    const n = new Notification("StarChart 瀚星星图", { body, tag: task.taskId })
    n.onclick = () => window.focus()
  } catch {
    // Notification 构造受限时忽略
  }
}
