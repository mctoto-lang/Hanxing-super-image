"use client"

import * as React from "react"
import Link from "next/link"
import { BadgeCheck, MessageSquareQuote, Star } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { SmartImage } from "@/components/ui/smart-image"
import { TruncateTooltip } from "@/components/ui/truncate-tooltip"
import { PlatformInlineIcon } from "@/components/selection/platform-badges"
import { AiSummaryBody } from "@/components/selection/ai-summary-card"
import { compactNumber, platformLabel } from "@/components/selection/labels"
import { getResultReviewsAction, scrapeResultReviewsAction } from "@/server/actions/selection-monitor"
import {
  getTrackedSelectionTasks,
  subscribeSelectionTasks,
  trackSelectionTask,
} from "@/lib/selection/notifier-store"
import { formatDateTime } from "@/lib/datetime"
import type { ReviewExtras } from "@/lib/selection/extras"
import type { SelectionAiSummaryData } from "@/lib/selection/ai-summary-types"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 详情弹窗评论区：按来源链接关联的已抓取评论（监控周期抓取 / 一次性抓取）+
 * 该目标的 AI 洞察 +「抓取评论」（支持评论的平台可对任意商品 / 帖子发起一次性抓取）。
 */

interface DialogReview {
  id: string
  platform: string
  authorName: string | null
  rating: string | null
  content: string | null
  likesCount: number | null
  verified: boolean | null
  publishedAt: Date | null
  scrapedAt: Date
  extras: ReviewExtras
}

interface ReviewState {
  loading: boolean
  /** 加载失败（网络/服务端异常）：显示失败态与重试入口，不再误报「平台不支持」 */
  failed: boolean
  total: number
  items: DialogReview[]
  aiSummary: { kind: string; summary: SelectionAiSummaryData; reviewCount: number; updatedAt: Date } | null
  canScrape: boolean
  scrapeCredits: number
}

const EMPTY: ReviewState = { loading: false, failed: false, total: 0, items: [], aiSummary: null, canScrape: false, scrapeCredits: 0 }

export function ReviewSection({ item }: { item: SelectionPoolItem }) {
  const [state, setState] = React.useState<ReviewState>(EMPTY)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  /** 提交成功的一次性抓评论任务：完成后（从全局追踪列表消失）自动重拉评论与 AI 洞察 */
  const [scrapeTaskId, setScrapeTaskId] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, failed: false }))
    void (async () => {
      try {
        const res = await getResultReviewsAction(item.id)
        if (!cancelled) {
          setState({
            loading: false,
            failed: false,
            total: res.total,
            items: res.items,
            aiSummary: res.aiSummary,
            canScrape: res.canScrape,
            scrapeCredits: res.scrapeCredits,
          })
        }
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false, failed: true }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.id])

  React.useEffect(() => load(), [load])

  // 抓取任务终态（完成/失败/取消都会从追踪列表移除）后刷新评论区——toast 里
  // 「完成后此处可查看」才有兑现路径；轮询粒度 ≤5s
  React.useEffect(() => {
    if (!scrapeTaskId) return
    return subscribeSelectionTasks(() => {
      if (!getTrackedSelectionTasks().some((t) => t.taskId === scrapeTaskId)) {
        setScrapeTaskId(null)
        load()
      }
    })
  }, [scrapeTaskId, load])

  const scrape = async () => {
    setPending(true)
    try {
      const res = await scrapeResultReviewsAction({ resultId: item.id })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      trackSelectionTask({ taskId: res.taskId, label: `抓取评论：${platformLabel(item.platform)}「${(item.title ?? item.content ?? "").slice(0, 20)}」` })
      setScrapeTaskId(res.taskId)
      toast.success(`评论抓取任务已提交（预扣 ${res.estimatedCredits} 积分，按实际条数结算），完成后此处与「评论洞察」可查看`, {
        duration: 8000,
      })
      setConfirmOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <MessageSquareQuote className="size-3.5 text-primary" />
          评论洞察{state.total > 0 ? `（${state.total}）` : ""}
          {state.loading ? <DashRing className="size-3.5 text-muted-foreground" /> : null}
        </p>
        {/* 服务端每目标最多带回 50 条：超出部分去「评论洞察」页看全量（带平台筛选） */}
        {state.total > 0 ? (
          <Link
            href={`/selection/reviews?platform=${item.platform}`}
            className="text-[11px] text-primary hover:underline"
          >
            查看全部 {state.total} 条 →
          </Link>
        ) : null}
        {state.canScrape ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            onClick={() => setConfirmOpen(true)}
          >
            抓取评论
          </Button>
        ) : null}
      </div>

      {state.aiSummary ? (
        <div className="rounded-lg bg-muted/30 p-3">
          <p className="mb-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            AI 洞察（基于 {state.aiSummary.reviewCount} 条评论
            {state.aiSummary.kind === "monitor" ? "，随监控周期刷新" : ""}）
          </p>
          <AiSummaryBody data={state.aiSummary.summary} />
        </div>
      ) : null}

      {state.loading && state.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">评论加载中…</p>
      ) : state.failed && state.items.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-destructive">评论加载失败</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={load}>
            重试
          </Button>
        </div>
      ) : state.items.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {state.canScrape
            ? "暂无评论。点「抓取评论」可对这条商品 / 帖子发起一次性评论抓取（按评论条数从个人配额扣积分），完成后自动生成 AI 洞察；加入竞品监控则会按周期持续追踪新评论。"
            : "该平台暂不支持评论抓取。"}
        </p>
      ) : (
        <div className="max-h-80 divide-y overflow-y-auto">
          {state.items.map((r) => (
            <div key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1 font-medium text-foreground">
                  <PlatformInlineIcon platform={r.platform} size={12} />
                  {r.authorName ?? (r.platform === "amazon" ? "Amazon 买家" : "匿名")}
                </span>
                {r.rating != null ? (
                  <span className="inline-flex items-center gap-0.5 text-amber-500">
                    <Star className="size-3 fill-current" />
                    {Number(r.rating).toFixed(1)}
                  </span>
                ) : null}
                {r.verified ? (
                  <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                    <BadgeCheck className="size-3" /> 已验证购买
                  </span>
                ) : null}
                {r.extras.vine ? <span className="rounded bg-muted px-1 text-[10px]">Vine</span> : null}
                {r.extras.variant ? (
                  <TruncateTooltip
                    text={r.extras.variant}
                    className="max-w-48 truncate rounded bg-muted px-1 text-[10px]"
                  />
                ) : null}
                {r.likesCount != null ? <span>赞 {compactNumber(r.likesCount)}</span> : null}
                <span className="ml-auto">
                  {r.publishedAt ? formatDateTime(r.publishedAt) : `抓取 ${formatDateTime(r.scrapedAt)}`}
                </span>
              </div>
              {r.extras.title ? <p className="mt-1 text-xs font-medium">{r.extras.title}</p> : null}
              <p className={cn("text-xs leading-relaxed", !r.extras.title && "mt-1")}>{r.content ?? "（无正文）"}</p>
              {r.extras.images.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {r.extras.images.map((src) => (
                    <a key={src} href={src} target="_blank" rel="noreferrer" className="size-12 overflow-hidden rounded-md border bg-muted">
                      <SmartImage src={src} alt="" className="h-full w-full object-cover" />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="抓取这条内容的评论？"
        description={`将创建一次性评论抓取任务：预扣 ${state.scrapeCredits} 积分（按实际抓到的评论条数结算，多退少不补），完成后自动生成 AI 洞察。`}
        confirmText="开始抓取"
        pending={pending}
        onConfirm={() => void scrape()}
      />
    </div>
  )
}
