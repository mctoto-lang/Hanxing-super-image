"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Crosshair, ExternalLink, Pause, Play, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DashRing } from "@/components/ui/dash-ring"
import { SmartImage } from "@/components/ui/smart-image"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { CountryFlag, PlatformInlineIcon } from "@/components/selection/platform-badges"
import { platformLabel } from "@/components/selection/labels"
import { formatDateTime } from "@/lib/datetime"
import { countryLabel } from "@/lib/selection/platforms"
import { cn } from "@/lib/utils"
import { MonitorTrend, type TrendPoint } from "@/components/selection/monitor/monitor-trend"
import { monitorMetrics } from "@/components/selection/monitor/monitor-metrics"
import type { MonitorListItem } from "@/lib/selection/monitor-types"
import {
  getSelectionMonitorTrendAction,
  removeSelectionMonitorAction,
  runSelectionMonitorNowAction,
  updateSelectionMonitorAction,
} from "@/server/actions/selection-monitor"

/**
 * 监控目标卡片（两行）：身份行（图 / 标题 / 平台·国家·发起人·抓取次数 / 状态）+
 * 指标行（最新指标带相对上次的涨跌 + 周期 / 评论追踪 / 立即抓取 / 暂停恢复 / 删除 /
 * 趋势）。暂停原因内联显示；「立即抓取」只对发起人开放（重抓从发起人扣积分）。
 */

/** 卡片用的监控行 = action 返回的列表项（lib/selection/monitor-types） */
export type MonitorRow = MonitorListItem

const INTERVAL_OPTIONS = [
  { value: "6", label: "每 6 小时" },
  { value: "12", label: "每 12 小时" },
  { value: "24", label: "每天" },
  { value: "48", label: "每 2 天" },
  { value: "72", label: "每 3 天" },
  { value: "168", label: "每周" },
]

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url.slice(0, 40)
  }
}

function MetricChip({
  label,
  text,
  delta,
  deltaGood,
}: {
  label: string
  text: string
  delta: string | null
  deltaGood: boolean | null
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{text}</span>
      {delta ? (
        <span
          className={cn(
            "inline-flex items-center gap-px",
            deltaGood == null
              ? "text-muted-foreground"
              : deltaGood
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
          )}
        >
          {deltaGood != null && delta !== "新" ? (
            delta.startsWith("+") ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
          ) : null}
          {delta}
        </span>
      ) : null}
    </span>
  )
}

export function MonitorCard({
  m,
  currentUserId,
  canManageAll = false,
}: {
  m: MonitorRow
  currentUserId: string
  /** 当前用户是企业管理员/所有者（与服务端口径一致：发起人或管理员可管理） */
  canManageAll?: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [trend, setTrend] = React.useState<TrendPoint[] | null>(null)
  const [trendLoading, setTrendLoading] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const isMine = m.userId === currentUserId
  // 周期/评论开关/暂停恢复/删除直接影响发起人账户扣费——仅发起人或企业管理员可
  // 操作（服务端同口径校验），其他人只读
  const canManage = isMine || canManageAll
  const paused = m.status === "paused"
  const metrics = monitorMetrics(m.platform, m, m.prev, m.lastCurrency)

  const withPending = async (fn: () => Promise<{ ok: boolean; error?: string }>, successText: string) => {
    setPending(true)
    try {
      const res = await fn()
      if (!res.ok) throw new Error(res.error ?? "操作失败")
      toast.success(successText)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败，请重试")
    } finally {
      setPending(false)
    }
  }

  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next && !trend) {
      setTrendLoading(true)
      void (async () => {
        try {
          const res = await getSelectionMonitorTrendAction(m.id)
          if (res.ok) setTrend(res.points)
        } catch {
          toast.error("趋势加载失败")
        } finally {
          setTrendLoading(false)
        }
      })()
    }
  }

  return (
    <div className="rounded-xl border bg-card" data-testid="monitor-card">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
          {m.imageUrl ? (
            <SmartImage src={m.imageUrl} alt="" className="h-full w-full object-cover" fallbackAspectRatio={0} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <Crosshair className="size-5" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 basis-72">
          <a
            href={m.targetUrl}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex max-w-full items-center gap-1 text-sm font-medium hover:underline"
          >
            <span className="line-clamp-1">{m.title ?? domainOf(m.targetUrl)}</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <PlatformInlineIcon platform={m.platform} size={12} />
              {platformLabel(m.platform)}
            </span>
            {m.country ? (
              <span className="flex items-center gap-1">
                <CountryFlag code={m.country} size={11} />
                {countryLabel(m.country) || m.country}
              </span>
            ) : null}
            {m.creatorName ? <span>发起人 {m.creatorName}</span> : null}
            <span>已抓 {m.runCount} 次</span>
            {m.status === "active" && m.nextRunAt ? <span>下次 {formatDateTime(m.nextRunAt)}</span> : null}
          </div>
        </div>

        {m.status === "active" ? (
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            监控中
          </span>
        ) : (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            已暂停
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        {metrics.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {metrics.map((x) => (
              <MetricChip key={x.key} label={x.label} text={x.text} delta={x.delta} deltaGood={x.deltaGood} />
            ))}
            {m.lastMetricsAt ? (
              <span className="text-[11px] text-muted-foreground">{formatDateTime(m.lastMetricsAt)}</span>
            ) : null}
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {m.canScrapeReviews ? "仅追踪评论（该平台无指标重抓）" : "首次抓取中…"}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            items={INTERVAL_OPTIONS}
            value={String(m.intervalHours)}
            disabled={pending || !canManage}
            onValueChange={(v) =>
              void withPending(
                () => updateSelectionMonitorAction({ id: m.id, intervalHours: Number(v) }),
                "已更新重抓周期",
              )
            }
          >
            <SelectTrigger size="sm" aria-label="重抓周期" className="h-7 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVAL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {m.canScrapeReviews ? (
            <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
              <Switch
                checked={m.trackReviews}
                disabled={pending || !canManage}
                onCheckedChange={(v) =>
                  void withPending(
                    () => updateSelectionMonitorAction({ id: m.id, trackReviews: v }),
                    v ? "已开启评论追踪" : "已关闭评论追踪",
                  )
                }
              />
              评论
            </label>
          ) : null}
          {isMine ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending || paused}
              onClick={() => void withPending(() => runSelectionMonitorNowAction(m.id), "已发起重抓（数据任务页可跟踪）")}
            >
              {pending ? <DashRing className="size-3.5" /> : <Play className="size-3.5" />}
              立即抓取
            </Button>
          ) : (
            <Tooltip>
              {/* Trigger 挂 span：Button disabled 带 pointer-events-none，悬浮事件挂按钮上永不触发 */}
              <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled>
                  <Play className="size-3.5" />
                  立即抓取
                </Button>
              </TooltipTrigger>
              <TooltipContent>只有监控发起人可以手动重抓（从发起人账户扣积分）</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={pending || !canManage}
            onClick={() =>
              void withPending(
                () => updateSelectionMonitorAction({ id: m.id, status: paused ? "active" : "paused" }),
                paused ? "已恢复（即将重抓）" : "已暂停",
              )
            }
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? "恢复" : "暂停"}
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  aria-label="删除监控目标"
                  disabled={pending || !canManage}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent>删除监控目标（历史抓取数据保留）</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={toggleExpand}
            aria-expanded={expanded}
            aria-label={expanded ? "收起趋势" : "展开趋势"}
          >
            趋势
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </Button>
        </div>
      </div>

      {paused && m.pauseReason ? (
        <div className="flex flex-wrap items-center gap-2 border-t bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>已暂停：{m.pauseReason}</span>
        </div>
      ) : null}

      {expanded ? (
        <div className="border-t px-3 py-3">
          <MonitorTrend
            platform={m.platform}
            currency={m.lastCurrency}
            points={trend ?? []}
            loading={trendLoading}
          />
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => !o && setDeleteOpen(false)}
        title="删除监控目标"
        description={`确定删除「${(m.title ?? m.targetUrl).slice(0, 60)}」？历史抓取数据保留；已排队未开始的抓取任务将一并取消并全额退款。`}
        confirmText="删除"
        destructive
        pending={pending}
        onConfirm={() =>
          void withPending(() => removeSelectionMonitorAction(m.id), "已删除监控目标").then(() => setDeleteOpen(false))
        }
      />
    </div>
  )
}

