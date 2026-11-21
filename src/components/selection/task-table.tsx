"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { X, RotateCcw, BarChart3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TableEmpty } from "@/components/shared/table-empty"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { usePolling } from "@/hooks/use-polling"
import { formatDateTime } from "@/lib/datetime"
import { countryLabel } from "@/lib/selection/platforms"
import {
  SELECTION_STATUS_BADGE,
  SELECTION_STATUS_LABELS,
  SELECTION_TASK_TYPE_LABELS,
  compactNumber,
  platformLabel,
} from "./labels"
import {
  cancelSelectionTaskAction,
  retrySelectionTaskAction,
} from "@/server/actions/selection"

/**
 * 数据任务表（数据任务页主体）
 *
 * RSC 传入全量行；存在进行中任务时 usePolling(3s) + router.refresh() 整页刷新。
 * 「查看数据」跳选品发现数据池（按来源任务过滤）；取消=ConfirmDialog；失败/
 * 取消行可一键重新提交（原参数新建并重新计费）。
 */

export interface SelectionTaskRow {
  id: string
  platform: string
  taskType: string
  keyword: string | null
  country: string | null
  status: string
  progress: number
  fetchedCount: number
  maxResults: number
  estimatedCredits: number
  actualCredits: number | null
  errorMessage: string | null
  creatorName: string | null
  createdAt: Date | string
  completedAt: Date | string | null
}

export function SelectionTaskTable({ tasks }: { tasks: SelectionTaskRow[] }) {
  const router = useRouter()
  const hasActive = tasks.some(
    (t) => t.status === "queued" || t.status === "processing",
  )
  // 进行中任务 3s 轮询整页刷新（worker 更新 progress/fetchedCount/终态）
  usePolling(hasActive, 3000, () => router.refresh())

  const [cancelTarget, setCancelTarget] = React.useState<SelectionTaskRow | null>(null)
  const [pendingId, setPendingId] = React.useState<string | null>(null)

  const doCancel = async (task: SelectionTaskRow) => {
    setPendingId(task.id)
    try {
      const res = await cancelSelectionTaskAction(task.id)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(
        task.status === "queued"
          ? "已取消，积分将全额退还"
          : "已请求取消，将中止抓取并按实际条数结算",
      )
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "取消失败")
    } finally {
      setPendingId(null)
      setCancelTarget(null)
    }
  }

  const doRetry = async (task: SelectionTaskRow) => {
    setPendingId(task.id)
    try {
      const res = await retrySelectionTaskAction(task.id)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(`已重新提交（预扣 ${res.estimatedCredits} 积分）`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新提交失败")
    } finally {
      setPendingId(null)
    }
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>状态</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>关键词</TableHead>
              <TableHead>国家</TableHead>
              <TableHead className="text-right">结果/目标</TableHead>
              <TableHead className="text-right">积分</TableHead>
              <TableHead>创建人</TableHead>
              <TableHead>时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <TableEmpty colSpan={10} noun="抓取任务" />
            ) : (
              tasks.map((t) => {
                const active = t.status === "queued" || t.status === "processing"
                const isFailed = t.status === "failed" || t.status === "cancelled"
                return (
                  <TableRow
                    key={t.id}
                    className="whitespace-nowrap"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge className={SELECTION_STATUS_BADGE[t.status] ?? ""}>
                          {SELECTION_STATUS_LABELS[t.status] ?? t.status}
                        </Badge>
                        {active ? (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {t.progress}%
                          </span>
                        ) : null}
                      </div>
                      {active ? (
                        <Progress value={t.progress} className="mt-1.5 h-1 w-24" />
                      ) : null}
                      {t.errorMessage ? (
                        <p
                          className="mt-1 max-w-48 truncate text-xs text-red-500"
                          title={t.errorMessage}
                        >
                          {t.errorMessage}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      {platformLabel(t.platform)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {SELECTION_TASK_TYPE_LABELS[t.taskType] ?? t.taskType}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-44">
                      <span className="block truncate" title={t.keyword ?? ""}>
                        {t.keyword || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.country ? (
                        <span title={countryLabel(t.country)}>{t.country}</span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {t.actualCredits != null || t.status === "completed"
                        ? compactNumber(t.fetchedCount)
                        : "—"}
                      <span className="text-muted-foreground"> / {t.maxResults}</span>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {t.actualCredits != null ? (
                        <span>
                          {t.actualCredits}
                          <span className="text-xs text-muted-foreground">
                            （预{t.estimatedCredits}）
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t.estimatedCredits}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{t.creatorName ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(t.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {t.status === "completed" && t.fetchedCount > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            nativeButton={false}
                            render={<Link href={`/selection/discover?task=${t.id}`} />}
                          >
                            <BarChart3 className="size-3.5" />
                            查看数据
                          </Button>
                        ) : null}
                        {active ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive"
                            disabled={pendingId === t.id}
                            onClick={() => setCancelTarget(t)}
                          >
                            <X className="size-3.5" />
                            取消
                          </Button>
                        ) : null}
                        {isFailed ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={pendingId === t.id}
                            onClick={() => void doRetry(t)}
                          >
                            <RotateCcw className="size-3.5" />
                            重试
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={cancelTarget != null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null)
        }}
        title="取消该抓取任务？"
        description={
          cancelTarget?.status === "queued"
            ? "任务尚未开始，取消后预扣积分将全额退还。"
            : "将中止在途抓取，已抓取的数据会保留，积分按实际条数结算退还差额。"
        }
        confirmText="确认取消"
        destructive
        pending={pendingId === cancelTarget?.id}
        onConfirm={() => (cancelTarget ? void doCancel(cancelTarget) : undefined)}
      />
    </>
  )
}
