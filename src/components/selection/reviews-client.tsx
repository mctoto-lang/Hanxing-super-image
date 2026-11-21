"use client"

import * as React from "react"
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  Sparkles,
  Star,
  ThumbsUp,
  BadgeCheck,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { compactNumber, platformLabel } from "@/components/selection/labels"
import {
  CountryFlag,
  PlatformInlineIcon,
} from "@/components/selection/platform-badges"
import {
  getSelectionReviewsAction,
  refreshMonitorAiSummaryAction,
  refreshSocialDigestAction,
} from "@/server/actions/selection-monitor"
import { SELECTION_PLATFORMS, countryLabel } from "@/lib/selection/platforms"
import { formatDateTime } from "@/lib/datetime"
import { cn } from "@/lib/utils"

/**
 * 评论洞察客户端：AI 洞察卡（监控目标评论汇总 + 社媒平台日 digest）+ 评论流
 * （平台/国家/目标/关键词/日期/排序筛选，action 直查客户端翻页）。
 */

interface ReviewRow {
  id: string
  platform: string
  country: string | null
  monitorId: string | null
  targetTitle: string | null
  targetUrl: string | null
  authorName: string | null
  rating: string | null
  content: string | null
  likesCount: number | null
  verified: boolean | null
  publishedAt: Date | null
  scrapedAt: Date
}

interface ReviewsPayload {
  ok: true
  items: ReviewRow[]
  total: number
  page: number
  pageSize: number
  overallCount: number
  overallAvgRating: number | null
}

interface AiSummary {
  id: string
  monitorId: string | null
  day: string | null
  platform: string | null
  reviewCount: number
  postCount: number
  updatedAt: Date
  summary: {
    sentiment?: string
    sentimentScore?: number
    pros?: string[]
    cons?: string[]
    keywords?: string[]
    quotes?: string[]
    suggestion?: string
    hotTopics?: string[]
  }
}

interface MonitorOption {
  id: string
  platform: string
  title: string | null
  targetUrl: string
}

const SENTIMENT_META: Record<string, { label: string; cls: string }> = {
  positive: { label: "整体积极", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  neutral: { label: "中性", cls: "bg-muted text-muted-foreground" },
  negative: { label: "整体消极", cls: "bg-red-500/10 text-red-600 dark:text-red-400" },
  mixed: { label: "褒贬不一", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
}

function sentimentOf(s: AiSummary["summary"]) {
  return SENTIMENT_META[s.sentiment ?? "neutral"] ?? SENTIMENT_META.neutral!
}

function AiSummaryCard({
  title,
  icon,
  meta,
  data,
  onRefresh,
  refreshing,
}: {
  title: string
  icon: React.ReactNode
  meta: string
  data: AiSummary["summary"]
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const sent = sentimentOf(data)
  return (
    <div className="flex flex-col rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
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
            {refreshing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn("rounded px-1.5 py-0.5 font-medium", sent.cls)}>{sent.label}</span>
        {typeof data.sentimentScore === "number" ? <span>情绪分 {data.sentimentScore}</span> : null}
        <span className="truncate">{meta}</span>
      </div>
      {data.hotTopics?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {data.hotTopics.map((t) => (
            <span key={t} className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-600 dark:text-sky-400">
              {t}
            </span>
          ))}
        </div>
      ) : null}
      {data.keywords?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {data.keywords.map((k) => (
            <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
              #{k}
            </span>
          ))}
        </div>
      ) : null}
      {data.pros?.length ? (
        <div className="mt-2 space-y-0.5 text-[11px] leading-relaxed">
          {data.pros.slice(0, 3).map((p) => (
            <p key={p} className="text-emerald-700 dark:text-emerald-400">＋ {p}</p>
          ))}
        </div>
      ) : null}
      {data.cons?.length ? (
        <div className="mt-1 space-y-0.5 text-[11px] leading-relaxed">
          {data.cons.slice(0, 3).map((c) => (
            <p key={c} className="text-red-700 dark:text-red-400">－ {c}</p>
          ))}
        </div>
      ) : null}
      {data.quotes?.length ? (
        <div className="mt-2 space-y-1 border-l-2 pl-2 text-[11px] leading-relaxed text-muted-foreground">
          {data.quotes.slice(0, 2).map((q, i) => (
            <p key={i}>“{q}”</p>
          ))}
        </div>
      ) : null}
      {data.suggestion ? (
        <p className="mt-2 rounded bg-primary/5 p-2 text-[11px] leading-relaxed">
          💡 {data.suggestion}
        </p>
      ) : null}
    </div>
  )
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-px text-amber-500" aria-label={`${rating} 分`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} className={cn("size-3", i < Math.round(rating) && "fill-current")} />
      ))}
    </span>
  )
}

export function ReviewsClient({
  initialReviews,
  monitors,
  monitorSummaries,
  digests,
}: {
  initialReviews: ReviewsPayload
  monitors: MonitorOption[]
  monitorSummaries: AiSummary[]
  digests: AiSummary[]
}) {
  const [payload, setPayload] = React.useState<ReviewsPayload>(initialReviews)
  const [loading, setLoading] = React.useState(false)
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null)

  const [platform, setPlatform] = React.useState("")
  const [country, setCountry] = React.useState("")
  const [monitorId, setMonitorId] = React.useState("")
  const [q, setQ] = React.useState("")
  const [dateFrom, setDateFrom] = React.useState("")
  const [dateTo, setDateTo] = React.useState("")
  const [sort, setSort] = React.useState("newest")
  const [pageSize, setPageSize] = React.useState(20)

  const countries = React.useMemo(() => {
    const set = new Set<string>()
    for (const r of payload.items) if (r.country) set.add(r.country)
    return [...set]
  }, [payload.items])

  // overrides 优先于 state：onValueChange 里 setState 后立即请求时闭包仍是旧值，
  // 切换筛选需把新值通过 overrides 传入，避免首个请求带旧筛选条件
  const fetchReviews = React.useCallback(
    (
      nextPage: number,
      overrides?: Partial<{
        platform: string
        country: string
        monitorId: string
        q: string
        dateFrom: string
        dateTo: string
        sort: string
        pageSize: number
      }>,
    ) => {
      const merged = {
        platform,
        country,
        monitorId,
        q,
        dateFrom,
        dateTo,
        sort,
        pageSize,
        ...overrides,
      }
      setLoading(true)
      void (async () => {
        try {
          const res = await getSelectionReviewsAction({
            platform: merged.platform || undefined,
            country: merged.country || undefined,
            monitorId: merged.monitorId || undefined,
            q: merged.q.trim() || undefined,
            dateFrom: merged.dateFrom || undefined,
            dateTo: merged.dateTo || undefined,
            sort: merged.sort,
            page: nextPage,
            pageSize: merged.pageSize,
          })
          if (!res.ok) throw new Error(res.error)
          setPayload(res)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "查询失败")
        } finally {
          setLoading(false)
        }
      })()
    },
    [platform, country, monitorId, q, dateFrom, dateTo, sort, pageSize],
  )

  const monitorTitle = (id: string | null) =>
    monitors.find((m) => m.id === id)?.title ?? null

  const refreshSummary = (summary: AiSummary) => {
    setRefreshingId(summary.id)
    void (async () => {
      try {
        const res =
          summary.monitorId != null
            ? await refreshMonitorAiSummaryAction(summary.monitorId)
            : await refreshSocialDigestAction(summary.platform ?? "")
        if (!res.ok) throw new Error(res.error)
        toast.success("AI 分析已刷新（刷新页面查看）")
        setTimeout(() => window.location.reload(), 600)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "刷新失败")
      } finally {
        setRefreshingId(null)
      }
    })()
  }

  const hasAi = monitorSummaries.length > 0 || digests.length > 0

  return (
    <div className="space-y-4">
      {/* AI 洞察区 */}
      {hasAi ? (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4 text-primary" /> AI 洞察
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {monitorSummaries.map((s) => (
              <AiSummaryCard
                key={s.id}
                title={monitorTitle(s.monitorId) ?? `监控目标 ${s.monitorId?.slice(0, 8)}`}
                icon={<MessageSquareQuote className="size-3.5" />}
                meta={`${s.reviewCount} 条评论 · ${formatDateTime(s.updatedAt)}`}
                data={s.summary}
                onRefresh={() => refreshSummary(s)}
                refreshing={refreshingId === s.id}
              />
            ))}
            {digests.map((s) => (
              <AiSummaryCard
                key={s.id}
                title={`${platformLabel(s.platform ?? "")} · ${s.day} 日报`}
                icon={<Sparkles className="size-3.5" />}
                meta={`${s.postCount} 条帖子`}
                data={s.summary}
                onRefresh={() => refreshSummary(s)}
                refreshing={refreshingId === s.id}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          items={[{ value: "all", label: "全部平台" }, ...SELECTION_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) }))]}
          value={platform || "all"}
          onValueChange={(v) => {
            const next = v === "all" ? "" : (v ?? "")
            setPlatform(next)
            fetchReviews(1, { platform: next })
          }}
        >
          <SelectTrigger size="sm" aria-label="平台筛选" className="w-32 text-xs">
            <SelectValue placeholder="全部平台" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部平台</SelectItem>
            {SELECTION_PLATFORMS.map((p) => (
              <SelectItem key={p} value={p}>
                {platformLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {countries.length > 0 ? (
          <Select
            items={[{ value: "all", label: "全部国家" }, ...countries.map((c) => ({ value: c, label: `${countryLabel(c)} ${c}` }))]}
            value={country || "all"}
            onValueChange={(v) => {
              const next = v === "all" ? "" : (v ?? "")
              setCountry(next)
              fetchReviews(1, { country: next })
            }}
          >
            <SelectTrigger size="sm" aria-label="国家筛选" className="w-28 text-xs">
              <SelectValue placeholder="全部国家" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部国家</SelectItem>
              {countries.map((c) => (
                <SelectItem key={c} value={c}>
                  {countryLabel(c)} {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {monitors.length > 0 ? (
          <Select
            items={[{ value: "all", label: "全部监控目标" }, ...monitors.map((m) => ({ value: m.id, label: (m.title ?? m.targetUrl).slice(0, 18) }))]}
            value={monitorId || "all"}
            onValueChange={(v) => {
              const next = v === "all" ? "" : (v ?? "")
              setMonitorId(next)
              fetchReviews(1, { monitorId: next })
            }}
          >
            <SelectTrigger size="sm" aria-label="监控目标筛选" className="w-44 text-xs">
              <SelectValue placeholder="全部监控目标" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部监控目标</SelectItem>
              {monitors.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {(m.title ?? m.targetUrl).slice(0, 16)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          items={[
            { value: "newest", label: "最新抓取" },
            { value: "likes_desc", label: "点赞优先" },
            { value: "rating_desc", label: "评分优先" },
            { value: "published_desc", label: "发布时间" },
          ]}
          value={sort}
          onValueChange={(v) => {
            const next = v ?? "newest"
            setSort(next)
            fetchReviews(1, { sort: next })
          }}
        >
          <SelectTrigger size="sm" aria-label="排序" className="w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">最新抓取</SelectItem>
            <SelectItem value="likes_desc">点赞优先</SelectItem>
            <SelectItem value="rating_desc">评分优先</SelectItem>
            <SelectItem value="published_desc">发布时间</SelectItem>
          </SelectContent>
        </Select>
        <input
          type="date"
          aria-label="抓取开始日期"
          value={dateFrom}
          max={dateTo || undefined}
          onChange={(e) => {
            setDateFrom(e.target.value)
          }}
          className="h-8 w-[7.5rem] rounded-md border border-input bg-transparent px-2 text-xs"
        />
        <span className="text-xs text-muted-foreground">~</span>
        <input
          type="date"
          aria-label="抓取结束日期"
          value={dateTo}
          min={dateFrom || undefined}
          onChange={(e) => {
            setDateTo(e.target.value)
          }}
          className="h-8 w-[7.5rem] rounded-md border border-input bg-transparent px-2 text-xs"
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchReviews(1)}
          placeholder="搜索评论内容"
          className="h-8 w-44 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={loading}
          onClick={() => fetchReviews(1)}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
          筛选
        </Button>
      </div>

      {/* 评论流 */}
      {payload.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-12 text-center">
          <MessageSquareQuote className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {payload.overallCount === 0
              ? "还没有评论数据——在选品发现把竞品加入监控（支持评论的平台会自动抓取评论并生成 AI 分析）。"
              : "没有符合筛选条件的评论。"}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {payload.items.map((r) => (
              <div key={r.id} className="rounded-xl border bg-card p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="flex items-center gap-1 font-medium">
                    <PlatformInlineIcon platform={r.platform} size={13} />
                    {platformLabel(r.platform)}
                  </span>
                  {r.country ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <CountryFlag code={r.country} size={12} />
                      {r.country}
                    </span>
                  ) : null}
                  {r.authorName ? (
                    <span className="text-muted-foreground">{r.authorName}</span>
                  ) : null}
                  {r.verified ? (
                    <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                      <BadgeCheck className="size-3" /> 已验证购买
                    </span>
                  ) : null}
                  {r.rating != null ? <Stars rating={Number(r.rating)} /> : null}
                  {r.likesCount != null ? (
                    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                      <ThumbsUp className="size-3" />
                      {compactNumber(r.likesCount)}
                    </span>
                  ) : null}
                  {r.publishedAt ? (
                    <span className="text-muted-foreground">
                      {formatDateTime(r.publishedAt)}
                    </span>
                  ) : null}
                  {r.targetTitle ? (
                    <span className="ml-auto max-w-64 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {r.targetUrl ? (
                        <a href={r.targetUrl} target="_blank" rel="noreferrer" className="hover:underline">
                          {r.targetTitle}
                        </a>
                      ) : (
                        r.targetTitle
                      )}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed">{r.content ?? "（无正文）"}</p>
              </div>
            ))}
          </div>
          {/* 客户端翻页（action 直查）+ 每页数量 */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              共 {payload.total} 条 · 第 {payload.page} / {Math.max(1, Math.ceil(payload.total / payload.pageSize))} 页
              <Select
                items={[20, 40, 60].map((n) => ({ value: String(n), label: `${n} 条/页` }))}
                value={String(pageSize)}
                onValueChange={(v) => {
                  const next = Number(v ?? 20)
                  setPageSize(next)
                  fetchReviews(1, { pageSize: next })
                }}
              >
                <SelectTrigger size="sm" aria-label="每页显示数量" className="h-7 w-26 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[20, 40, 60].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} 条/页
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
            <span className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={loading || payload.page <= 1}
                onClick={() => fetchReviews(payload.page - 1)}
              >
                <ChevronLeft className="size-3.5" /> 上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={loading || payload.page >= Math.ceil(payload.total / payload.pageSize)}
                onClick={() => fetchReviews(payload.page + 1)}
              >
                下一页 <ChevronRight className="size-3.5" />
              </Button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
