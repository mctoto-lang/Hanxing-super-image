"use client"

import * as React from "react"
import Link from "next/link"
import { ExternalLink } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { usePolling } from "@/hooks/use-polling"
import { compactNumber, platformLabel } from "./labels"
import { getSelectionTaskStatusesAction } from "@/server/actions/selection"

/**
 * 进行中任务横幅（市场分析/选品发现页顶部）
 *
 * RSC 注入初始在途任务；客户端 3s 轻量轮询（getSelectionTaskStatusesAction
 * 只取 id/status/progress/fetchedCount）更新进度条，终态后整行消失——
 * 完成通知/页面数据刷新由全局 SelectionTaskNotifier 负责。
 */

interface BannerTask {
  id: string
  platform: string
  keyword: string | null
  status: string
  progress: number
  fetchedCount: number
  maxResults: number
}

export function SelectionActiveTaskBanner({ initialTasks }: { initialTasks: BannerTask[] }) {
  const [tasks, setTasks] = React.useState<BannerTask[]>(initialTasks)

  usePolling(tasks.length > 0, 3000, async () => {
    try {
      const res = await getSelectionTaskStatusesAction(tasks.map((t) => t.id))
      const byId = new Map(res.items.map((r) => [r.id, r]))
      // 终态/失查行剔除，其余返回新对象更新进度（不就地 mutate 旧行）
      setTasks((prev) =>
        prev
          .filter((t) => {
            const row = byId.get(t.id)
            if (!row) return false
            return (
              row.status !== "completed" &&
              row.status !== "failed" &&
              row.status !== "cancelled"
            )
          })
          .map((t) => {
            const row = byId.get(t.id)!
            return { ...t, progress: row.progress, fetchedCount: row.fetchedCount }
          }),
      )
    } catch {
      // 网络抖动跳过本轮
    }
  })

  if (tasks.length === 0) return null

  return (
    <div className="space-y-1.5 rounded-xl border border-sky-500/30 bg-sky-500/[0.04] p-3">
      {tasks.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">{platformLabel(t.platform)}</span>
          <span className="max-w-48 truncate text-muted-foreground" title={t.keyword ?? ""}>
            {t.keyword || "—"}
          </span>
          <Progress value={t.progress} className="h-1.5 max-w-56" />
          <span className="text-xs text-muted-foreground">
            {compactNumber(t.fetchedCount)}/{t.maxResults} 条 · {t.progress}%
          </span>
          <Link
            href="/selection/tasks"
            className="ml-auto inline-flex items-center gap-1 text-xs text-sky-600 hover:underline dark:text-sky-400"
          >
            任务页
            <ExternalLink className="size-3" />
          </Link>
        </div>
      ))}
    </div>
  )
}
