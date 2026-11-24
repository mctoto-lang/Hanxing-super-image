"use client"

import * as React from "react"
import { Lightbulb, RefreshCw, Sparkles } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import type { SelectionAiSummaryData } from "@/lib/selection/ai-summary-types"
import { cn } from "@/lib/utils"

/**
 * AI 洞察卡（评论洞察页与详情弹窗评论区共用）：情感倾向 + 情绪分 + 热点话题 +
 * 关键词 + 优缺点 + 引语 + 行动建议。
 */

const SENTIMENT_META: Record<string, { label: string; cls: string }> = {
  positive: { label: "整体积极", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  neutral: { label: "中性", cls: "bg-muted text-muted-foreground" },
  negative: { label: "整体消极", cls: "bg-red-500/10 text-red-600 dark:text-red-400" },
  mixed: { label: "褒贬不一", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
}

/** 摘要正文（compact：评论洞察页卡片；否则详情弹窗评论区内的精简版） */
export function AiSummaryBody({
  data,
  compact,
}: {
  data: SelectionAiSummaryData
  /** 精简模式：少显示几条优缺点 */
  compact?: boolean
}) {
  const sent = SENTIMENT_META[data.sentiment ?? "neutral"] ?? SENTIMENT_META.neutral!
  const prosLimit = compact ? 3 : 4
  return (
    <div className="space-y-2 text-[11px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded px-1.5 py-0.5 font-medium", sent.cls)}>{sent.label}</span>
        {typeof data.sentimentScore === "number" ? (
          <span className="text-muted-foreground">情绪分 {data.sentimentScore}</span>
        ) : null}
      </div>
      {data.hotTopics?.length ? (
        <div className="flex flex-wrap gap-1">
          {data.hotTopics.map((t) => (
            <span
              key={t}
              className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-600 dark:text-sky-400"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {data.keywords?.length ? (
        <div className="flex flex-wrap gap-1">
          {data.keywords.map((k) => (
            <span key={k} className="rounded bg-muted px-1.5 py-0.5">
              #{k}
            </span>
          ))}
        </div>
      ) : null}
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {data.pros?.length ? (
          <div className="space-y-0.5">
            {data.pros.slice(0, prosLimit).map((p) => (
              <p key={p} className="text-emerald-700 dark:text-emerald-400">
                ＋ {p}
              </p>
            ))}
          </div>
        ) : null}
        {data.cons?.length ? (
          <div className="space-y-0.5">
            {data.cons.slice(0, prosLimit).map((c) => (
              <p key={c} className="text-red-700 dark:text-red-400">
                － {c}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      {data.quotes?.length ? (
        <div className="space-y-1 border-l-2 pl-2 text-muted-foreground">
          {data.quotes.slice(0, 2).map((q, i) => (
            <p key={i}>“{q}”</p>
          ))}
        </div>
      ) : null}
      {data.suggestion ? (
        <p className="rounded bg-primary/5 p-2">
          <Lightbulb className="mr-1 inline size-3 text-primary" />
          {data.suggestion}
        </p>
      ) : null}
    </div>
  )
}

/** 评论洞察页的卡片外壳（带标题与手动刷新） */
export function AiSummaryCard({
  title,
  meta,
  data,
  onRefresh,
  refreshing,
  footer,
}: {
  title: string
  meta: string
  data: SelectionAiSummaryData
  onRefresh?: () => void
  refreshing?: boolean
  /** 标题下的附加操作（如「查看评论」链接） */
  footer?: React.ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="size-3.5" />
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
        {onRefresh ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label="刷新 AI 分析"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? <DashRing className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          </Button>
        ) : null}
      </div>
      <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{meta}</p>
      <div className="mt-2">
        <AiSummaryBody data={data} compact />
      </div>
      {footer}
    </div>
  )
}
