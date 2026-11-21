"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Trash2,
} from "lucide-react"
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
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SmartImage } from "@/components/ui/smart-image"
import { compactNumber, platformLabel } from "@/components/selection/labels"
import {
  CountryFlag,
  PlatformInlineIcon,
} from "@/components/selection/platform-badges"
import { formatDateTime } from "@/lib/datetime"
import {
  getSelectionMonitorTrendAction,
  removeSelectionMonitorAction,
  runSelectionMonitorNowAction,
  updateSelectionMonitorAction,
} from "@/server/actions/selection-monitor"
import { cn } from "@/lib/utils"

/**
 * 竞品监控列表（客户端）：目标卡片 + 周期/评论追踪配置 + 暂停恢复/立即重抓/
 * 删除 + 展开趋势（关键指标随时间的折线与历史表）。
 */

export interface MonitorRow {
  id: string
  platform: string
  targetUrl: string
  externalId: string | null
  title: string | null
  imageUrl: string | null
  country: string | null
  lastPrice: string | null
  lastRating: string | null
  lastSalesCount: number | null
  lastReviewCount: number | null
  lastLikesCount: number | null
  lastCommentsCount: number | null
  lastMetricsAt: Date | null
  intervalHours: number
  trackReviews: boolean
  status: string
  pauseReason: string | null
  lastRunAt: Date | null
  nextRunAt: Date | null
  runCount: number
  createdAt: Date
  creatorName: string | null
}

interface TrendPoint {
  date: string
  price: number | null
  rating: number | null
  salesCount: number | null
  reviewCount: number | null
  likesCount: number | null
  commentsCount: number | null
}

const INTERVAL_OPTIONS = [
  { value: "6", label: "每 6 小时" },
  { value: "12", label: "每 12 小时" },
  { value: "24", label: "每天" },
  { value: "48", label: "每 2 天" },
  { value: "72", label: "每 3 天" },
  { value: "168", label: "每周" },
]

const SOCIAL_PLATFORMS = ["instagram", "tiktok", "pinterest", "reddit", "x", "facebook"]

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url.slice(0, 40)
  }
}

/** 迷你折线（无轴，hover title 显示首末值） */
function Sparkline({
  values,
  label,
}: {
  values: Array<number | null>
  label: string
}) {
  const pts = values.map((v, i) => ({ v: v ?? 0, i })).filter((p) => p.v > 0)
  if (pts.length < 2) {
    return <span className="text-[11px] text-muted-foreground">趋势待积累（≥2 次抓取）</span>
  }
  const max = Math.max(...pts.map((p) => p.v))
  const min = Math.min(...pts.map((p) => p.v))
  const span = max - min || 1
  const w = 96
  const h = 24
  const path = pts
    .map((p, idx) => {
      const x = (p.i / Math.max(1, values.length - 1)) * w
      const y = h - ((p.v - min) / span) * (h - 4) - 2
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
  const last = pts[pts.length - 1]!.v
  const first = pts[0]!.v
  const delta = first > 0 ? Math.round(((last - first) / first) * 100) : 0
  return (
    <span className="flex items-center gap-1.5" title={`${label}：${compactNumber(first)} → ${compactNumber(last)}（${delta >= 0 ? "+" : ""}${delta}%）`}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      </svg>
      <span
        className={cn(
          "text-[11px] font-medium tabular-nums",
          delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
        )}
      >
        {delta >= 0 ? "+" : ""}
        {delta}%
      </span>
    </span>
  )
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
      <span className="text-muted-foreground">{label} </span>
      {value}
    </span>
  )
}

export function MonitorClient({ initialMonitors }: { initialMonitors: MonitorRow[] }) {
  const router = useRouter()
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [trends, setTrends] = React.useState<Record<string, TrendPoint[]>>({})
  const [trendLoading, setTrendLoading] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<MonitorRow | null>(null)

  const withPending = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, successText: string) => {
    setPendingId(id)
    try {
      const res = await fn()
      if (!res.ok) throw new Error(res.error ?? "操作失败")
      toast.success(successText)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败，请重试")
    } finally {
      setPendingId(null)
    }
  }

  const toggleExpand = (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      return
    }
    setExpanded(id)
    if (!trends[id]) {
      setTrendLoading(id)
      void (async () => {
        try {
          const res = await getSelectionMonitorTrendAction(id)
          if (res.ok) setTrends((s) => ({ ...s, [id]: res.points }))
        } catch {
          toast.error("趋势加载失败")
        } finally {
          setTrendLoading(null)
        }
      })()
    }
  }

  if (initialMonitors.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
        <Crosshair className="size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          还没有监控目标——去选品发现/市场分析，点卡片右上角准星按钮加入竞品监控。
        </p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/selection/discover" />}
        >
          前往选品发现
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {initialMonitors.map((m) => {
          const isSocial = SOCIAL_PLATFORMS.includes(m.platform)
          const pending = pendingId === m.id
          const points = trends[m.id] ?? []
          return (
            <div key={m.id} className="rounded-xl border bg-card">
              <div className="flex flex-wrap items-center gap-3 p-3">
                {/* 图 */}
                <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                  {m.imageUrl ? (
                    <SmartImage src={m.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <Crosshair className="size-5" />
                    </div>
                  )}
                </div>

                {/* 标题 + 元信息 */}
                <div className="min-w-0 flex-1 basis-64">
                  <a
                    href={m.targetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-center gap-1 text-sm font-medium hover:underline"
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
                        {m.country}
                      </span>
                    ) : null}
                    <span>{m.creatorName ? `发起人 ${m.creatorName}` : ""}</span>
                    <span>已抓 {m.runCount} 次</span>
                    {m.status === "active" && m.nextRunAt ? (
                      <span>下次 {formatDateTime(m.nextRunAt)}</span>
                    ) : null}
                  </div>
                </div>

                {/* 最新指标 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {!isSocial && m.lastPrice != null ? (
                    <MetricChip label="价格" value={`$${Number(m.lastPrice).toFixed(2)}`} />
                  ) : null}
                  {m.lastRating != null ? (
                    <MetricChip label="评分" value={Number(m.lastRating).toFixed(1)} />
                  ) : null}
                  {!isSocial && m.lastSalesCount != null ? (
                    <MetricChip label="销量" value={compactNumber(m.lastSalesCount)} />
                  ) : null}
                  {m.lastReviewCount != null ? (
                    <MetricChip label="评论数" value={compactNumber(m.lastReviewCount)} />
                  ) : null}
                  {isSocial && m.lastLikesCount != null ? (
                    <MetricChip label="点赞" value={compactNumber(m.lastLikesCount)} />
                  ) : null}
                  {isSocial && m.lastCommentsCount != null ? (
                    <MetricChip label="评论" value={compactNumber(m.lastCommentsCount)} />
                  ) : null}
                  {m.lastMetricsAt ? (
                    <span className="text-[11px] text-muted-foreground">
                      {formatDateTime(m.lastMetricsAt)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">首次抓取中…</span>
                  )}
                </div>

                {/* 状态 */}
                {m.status === "active" ? (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    运行中
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="cursor-help rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                          已暂停
                        </span>
                      }
                    />
                    <TooltipContent>{m.pauseReason ?? "手动暂停"}</TooltipContent>
                  </Tooltip>
                )}

                {/* 配置 + 操作 */}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Select
                    items={INTERVAL_OPTIONS}
                    value={String(m.intervalHours)}
                    onValueChange={(v) =>
                      void withPending(
                        m.id,
                        () => updateSelectionMonitorAction({ id: m.id, intervalHours: Number(v) }),
                        "已更新重抓周期",
                      )
                    }
                  >
                    <SelectTrigger size="sm" aria-label="重抓周期" className="w-24 text-xs">
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
                  <label className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                    <Switch
                      checked={m.trackReviews}
                      onCheckedChange={(v) =>
                        void withPending(
                          m.id,
                          () => updateSelectionMonitorAction({ id: m.id, trackReviews: v }),
                          v ? "已开启评论追踪" : "已关闭评论追踪",
                        )
                      }
                    />
                    评论
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() =>
                      void withPending(m.id, () => runSelectionMonitorNowAction(m.id), "已发起重抓（数据任务页可跟踪）")
                    }
                  >
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    立即抓取
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() =>
                      void withPending(
                        m.id,
                        () => updateSelectionMonitorAction({ id: m.id, status: m.status === "active" ? "paused" : "active" }),
                        m.status === "active" ? "已暂停" : "已恢复（即将重抓）",
                      )
                    }
                  >
                    {m.status === "active" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                    {m.status === "active" ? "暂停" : "恢复"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                    disabled={pending}
                    onClick={() => setDeleteTarget(m)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => toggleExpand(m.id)}
                    aria-label={expanded === m.id ? "收起趋势" : "展开趋势"}
                  >
                    趋势
                    {expanded === m.id ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </Button>
                </div>
              </div>

              {/* 趋势展开区 */}
              {expanded === m.id ? (
                <div className="border-t px-3 py-3">
                  {trendLoading === m.id && !points.length ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> 趋势加载中…
                    </p>
                  ) : points.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      暂无历史数据（监控指标任务完成后自动积累；仅评论追踪的目标无指标趋势，
                      评论见「评论洞察」）。
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-4">
                        {!isSocial ? (
                          <Sparkline values={points.map((p) => p.salesCount)} label="销量" />
                        ) : (
                          <Sparkline values={points.map((p) => p.likesCount)} label="点赞" />
                        )}
                        <Sparkline values={points.map((p) => p.reviewCount ?? p.commentsCount)} label="评论数" />
                      </div>
                      <div className="max-h-44 overflow-y-auto rounded-lg border">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                            <tr className="text-left text-muted-foreground">
                              <th className="px-2 py-1.5 font-medium">抓取时间</th>
                              <th className="px-2 py-1.5 font-medium">价格</th>
                              <th className="px-2 py-1.5 font-medium">评分</th>
                              <th className="px-2 py-1.5 font-medium">销量</th>
                              <th className="px-2 py-1.5 font-medium">评论数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...points].reverse().map((p, i) => (
                              <tr key={i} className="border-t tabular-nums">
                                <td className="px-2 py-1.5">{formatDateTime(p.date)}</td>
                                <td className="px-2 py-1.5">{p.price != null ? `$${p.price.toFixed(2)}` : "—"}</td>
                                <td className="px-2 py-1.5">{p.rating != null ? p.rating.toFixed(1) : "—"}</td>
                                <td className="px-2 py-1.5">{p.salesCount != null ? compactNumber(p.salesCount) : "—"}</td>
                                <td className="px-2 py-1.5">
                                  {p.reviewCount != null ? compactNumber(p.reviewCount) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="删除监控目标"
        description={`确定删除「${(deleteTarget?.title ?? deleteTarget?.targetUrl ?? "").slice(0, 60)}」？历史抓取数据保留，仅停止后续重抓。`}
        confirmText="删除"
        destructive
        pending={pendingId === deleteTarget?.id}
        onConfirm={() => {
          if (!deleteTarget) return
          void withPending(deleteTarget.id, () => removeSelectionMonitorAction(deleteTarget.id), "已删除监控目标").then(
            () => setDeleteTarget(null),
          )
        }}
      />
    </>
  )
}
