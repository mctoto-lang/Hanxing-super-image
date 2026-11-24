"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { BarChart3, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { TruncateTooltip } from "@/components/ui/truncate-tooltip"
import { TableEmpty } from "@/components/shared/table-empty"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { PlatformLogo } from "@/components/selection/platform-badges"
import { compactNumber, platformLabel } from "@/components/selection/labels"
import { SELECTION_STATUS_BADGE, SELECTION_STATUS_LABELS } from "@/components/selection/labels"
import { TASK_TYPE_LABELS, taskDataHref } from "@/lib/selection/task-links"
import { countryLabel } from "@/lib/selection/platforms"
import { usePolling } from "@/hooks/use-polling"
import { formatDateTime } from "@/lib/datetime"
import { cancelSelectionTaskAction, getSelectionTaskStatusesAction, retrySelectionTaskAction } from "@/server/actions/selection"

/**
 * 数据任务表（数据任务页主体）
 *
 * RSC 按 URL 筛选分页传入当前页行；有进行中任务时每 5s 用轻量状态接口比对，
 * 状态 / 进度有变化才 router.refresh()（不再每 3 秒整页刷新）。
 * 「查看数据」按任务类型与平台类别跳到对应页面（见 taskDataHref）；取消 =
 * ConfirmDialog；失败 / 取消行可一键重新提交（原参数新建并重新计费）。
 */

export interface SelectionTaskRow {
  id: string
  userId: string
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
  monitorId: string | null
  creatorName: string | null
  createdAt: Date | string
  completedAt: Date | string | null
}

export function SelectionTaskTable({
  tasks,
  currentUserId,
  canCancelOthers,
}: {
  tasks: SelectionTaskRow[]
  currentUserId: string
  /** 企业管理员可取消他人任务（与服务端口径一致） */
  canCancelOthers: boolean
}) {
  const router = useRouter()
  const [cancelTarget, setCancelTarget] = React.useState<SelectionTaskRow | null>(null)
  const [pendingId, setPendingId] = React.useState<string | null>(null)

  // 轮询集合：进行中任务 + 已取消但未结算的任务（其结算要等 worker 中止 run 后
  // 落库，纳入签名后实扣/退款到账时 progress→100 触发刷新，积分列不再停在「预扣」）
  const active = tasks.filter(
    (t) =>
      t.status === "queued" ||
      t.status === "processing" ||
      (t.status === "cancelled" && t.actualCredits == null),
  )
  const signature = active.map((t) => `${t.id}:${t.status}:${t.progress}:${t.fetchedCount}`).join("|")
  const signatureRef = React.useRef(signature)
  React.useEffect(() => {
    signatureRef.current = signature
  }, [signature])

  // 进行中任务 5s 轻量比对：有变化才整页刷新（页面不可见时 hook 自动跳过）。
  // 签名按页面行顺序拼接——状态接口没有排序，先建 id 索引再按本页顺序取值，
  // 查不到的行输出哨兵视为有变化，避免接口返回顺序抖动导致每轮都整页刷新
  usePolling(
    active.length > 0,
    5000,
    async () => {
      const res = await getSelectionTaskStatusesAction(active.map((t) => t.id))
      const byId = new Map(res.items.map((i) => [i.id, i]))
      const next = active
        .map((t) => {
          const i = byId.get(t.id)
          return i ? `${i.id}:${i.status}:${i.progress}:${i.fetchedCount}` : `${t.id}:gone`
        })
        .join("|")
      if (next !== signatureRef.current) {
        React.startTransition(() => router.refresh())
      }
    },
  )

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
      {/* contain-inline-size：表格的最小内容宽度不再向主内容区（flex 子项）传播，避免整页横向溢出 */}
      <div className="w-full min-w-0 contain-inline-size overflow-hidden rounded-xl border">
        <Table className="min-w-[820px] [&_td]:px-2.5 [&_th]:px-2.5">
          <TableHeader>
            <TableRow>
              <TableHead>状态</TableHead>
              <TableHead>平台</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>关键词</TableHead>
              <TableHead>国家</TableHead>
              <TableHead>结果 / 目标</TableHead>
              <TableHead>积分</TableHead>
              <TableHead>创建人</TableHead>
              <TableHead>时间</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <TableEmpty colSpan={10} noun="抓取任务" filtered />
            ) : (
              tasks.map((t) => {
                const isActive = t.status === "queued" || t.status === "processing"
                // 只给手动任务（发现/市场）显示重试：监控/评论任务的原参数经市场字段
                // 集清洗后会变成「监控标题当关键词的市场分析任务」并预扣积分，
                // 服务端同样拒绝（retrySelectionTaskAction），前端直接不渲染入口
                const isFailed =
                  (t.status === "failed" || t.status === "cancelled") &&
                  (t.taskType === "discover" || t.taskType === "market")
                const dataHref = t.status === "completed" && t.fetchedCount > 0 ? taskDataHref(t) : null
                const canCancel = t.userId === currentUserId || canCancelOthers
                return (
                  <TableRow key={t.id} className="align-top">
                    <TableCell className="max-w-56 py-2">
                      <Badge className={SELECTION_STATUS_BADGE[t.status] ?? ""}>
                        {SELECTION_STATUS_LABELS[t.status] ?? t.status}
                      </Badge>
                      {isActive ? (
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <Progress value={t.progress} className="h-1 w-24" />
                          <span className="text-xs text-muted-foreground tabular-nums">{t.progress}%</span>
                        </div>
                      ) : null}
                      {t.errorMessage ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="mt-1 block max-w-56 cursor-help truncate text-xs text-red-500">
                                {t.errorMessage}
                              </span>
                            }
                          />
                          <TooltipContent className="max-w-md whitespace-pre-wrap break-all text-left">
                            {t.errorMessage}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                        <PlatformLogo platform={t.platform} size={14} />
                        {platformLabel(t.platform)}
                      </span>
                    </TableCell>
                    <TableCell className="py-2">
                      <Badge variant="outline" className="text-[10px]">
                        {TASK_TYPE_LABELS[t.taskType] ?? t.taskType}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-52 py-2">
                      {t.keyword ? (
                        <TruncateTooltip text={t.keyword} className="line-clamp-2 text-xs" />
                      ) : (
                        <span className="text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-xs whitespace-nowrap text-muted-foreground">
                      {t.country ? (
                        <span>
                          {countryLabel(t.country)} {t.country}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-sm tabular-nums">
                      {t.actualCredits != null || t.status === "completed" ? compactNumber(t.fetchedCount) : "—"}
                      <span className="text-muted-foreground"> / {t.maxResults}</span>
                    </TableCell>
                    <TableCell className="py-2 text-sm tabular-nums">
                      {t.actualCredits != null ? (
                        <span>
                          实扣 {t.actualCredits}
                          <span className="ml-1 text-xs text-muted-foreground">（预扣 {t.estimatedCredits}）</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">预扣 {t.estimatedCredits}</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-xs">{t.creatorName ?? "—"}</TableCell>
                    <TableCell className="py-2 text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(t.createdAt)}
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex items-center gap-1">
                        {dataHref ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            nativeButton={false}
                            render={<Link href={dataHref} />}
                          >
                            <BarChart3 className="size-3.5" />
                            查看数据
                          </Button>
                        ) : null}
                        {isActive && canCancel ? (
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
