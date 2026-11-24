"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { BadgeCheck, ChevronDown, ChevronRight, ExternalLink, MessageSquareQuote, Sparkles, Star, ThumbsUp, X } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { TablePagination } from "@/components/ui/table-pagination"
import { DateRangePicker } from "@/components/shared/date-range-picker"
import { SmartImage } from "@/components/ui/smart-image"
import { FilterSelect } from "@/components/selection/filter-select"
import { AiSummaryCard } from "@/components/selection/ai-summary-card"
import { SelectionEmpty } from "@/components/selection/empty-state"
import { KpiStrip } from "@/components/selection/kpi-strip"
import { CountryFlag, PlatformInlineIcon } from "@/components/selection/platform-badges"
import { compactNumber, platformLabel } from "@/components/selection/labels"
import { formatDateTime } from "@/lib/datetime"
import { countryLabel, SELECTION_PLATFORM_CONFIGS, SELECTION_PLATFORMS, isSelectionPlatform } from "@/lib/selection/platforms"
import {
  REVIEW_SORTS,
  REVIEW_SORT_LABELS,
  type InsightCard,
  type ReviewItem,
  type ReviewsFilter,
  type ReviewsPayload,
} from "@/lib/selection/review-types"
import {
  refreshMonitorAiSummaryAction,
  refreshSocialDigestAction,
  refreshTargetAiSummaryAction,
} from "@/server/actions/selection-monitor"
import { cn } from "@/lib/utils"

/**
 * 评论洞察客户端（URL 驱动）：KPI 条 + 星级分布（点击按星级筛选）+ AI 洞察分组
 * （监控目标 / 一次性抓取目标 / 社媒日报）+ 筛选栏 + 评论流 + 分页。
 * 列表与统计全部来自服务端 props，筛选变化 = 换 URL，刷新 / 后退 / 分享都能还原。
 */

const BASE_PATH = "/selection/reviews"
const PAGE_SIZES = [20, 40, 60]

/** 支持评论抓取的平台（注册表 monitor.reviewActorId） */
const REVIEW_PLATFORMS = SELECTION_PLATFORMS.filter(
  (p) => SELECTION_PLATFORM_CONFIGS[p].monitor?.reviewActorId,
)

function buildQuery(filter: ReviewsFilter, patch: Partial<ReviewsFilter>, page = 1, pageSize?: number) {
  const f = { ...filter, ...patch }
  const params = new URLSearchParams()
  if (f.platform) params.set("platform", f.platform)
  if (f.monitorId) params.set("monitor", f.monitorId)
  if (f.rating) params.set("rating", f.rating)
  if (f.verified) params.set("verified", "1")
  if (f.q) params.set("q", f.q)
  if (f.sort && f.sort !== "newest") params.set("sort", f.sort)
  if (f.dateFrom) params.set("dateFrom", f.dateFrom)
  if (f.dateTo) params.set("dateTo", f.dateTo)
  if (page > 1) params.set("page", String(page))
  if (pageSize && pageSize !== PAGE_SIZES[0]) params.set("pageSize", String(pageSize))
  const qs = params.toString()
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH
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

function ReviewCard({ r }: { r: ReviewItem }) {
  return (
    <div className="rounded-xl border bg-card p-3" data-testid="review-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="flex items-center gap-1 font-medium">
          <PlatformInlineIcon platform={r.platform} size={13} />
          {platformLabel(r.platform)}
        </span>
        {r.country ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <CountryFlag code={r.country} size={12} />
            {countryLabel(r.country) || r.country}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {r.authorName ?? (r.platform === "amazon" ? "Amazon 买家" : "匿名")}
        </span>
        {r.verified ? (
          <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
            <BadgeCheck className="size-3" /> 已验证购买
          </span>
        ) : null}
        {r.extras.vine ? <span className="rounded bg-muted px-1 text-[10px]">Vine</span> : null}
        {r.rating != null ? <Stars rating={Number(r.rating)} /> : null}
        {r.likesCount != null ? (
          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
            <ThumbsUp className="size-3" />
            {compactNumber(r.likesCount)}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {r.publishedAt ? `发布于 ${formatDateTime(r.publishedAt)}` : `抓取于 ${formatDateTime(r.scrapedAt)}`}
        </span>
        {r.targetTitle ? (
          <span className="ml-auto inline-flex max-w-64 items-center gap-1 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {r.targetUrl ? (
              <a href={r.targetUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 hover:text-foreground hover:underline">
                <span className="truncate">{r.targetTitle}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
            ) : (
              <span className="truncate">{r.targetTitle}</span>
            )}
          </span>
        ) : null}
      </div>
      {r.extras.title ? <p className="mt-1.5 text-sm font-medium">{r.extras.title}</p> : null}
      <p className={cn("line-clamp-6 text-sm leading-relaxed", !r.extras.title && "mt-1.5")}>{r.content ?? "（无正文）"}</p>
      {r.extras.variant ? (
        <p className="mt-1 text-[11px] text-muted-foreground">购买变体：{r.extras.variant}</p>
      ) : null}
      {r.extras.images.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {r.extras.images.map((src) => (
            <a key={src} href={src} target="_blank" rel="noreferrer" className="size-14 overflow-hidden rounded-md border bg-muted">
              <SmartImage src={src} alt="" className="h-full w-full object-cover" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 星级分布：1~5 星条形，点击该星级即按星级筛选 */
function RatingDistribution({
  counts,
  active,
  onPick,
}: {
  counts: number[]
  active: string
  onPick: (rating: string) => void
}) {
  const max = Math.max(1, ...counts)
  return (
    <div className="space-y-1">
      {[...counts].reverse().map((c, i) => {
        const star = 5 - i
        const isActive = active === String(star)
        return (
          <button
            key={star}
            type="button"
            aria-pressed={isActive}
            onClick={() => onPick(isActive ? "" : String(star))}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-[11px] transition-colors hover:bg-muted",
              isActive && "bg-muted",
            )}
          >
            <span className="w-8 shrink-0 text-muted-foreground">{star} 星</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-amber-400" style={{ width: `${(c / max) * 100}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{c}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ReviewsClient({
  initial,
  filter,
  monitors,
  insights,
}: {
  initial: ReviewsPayload
  filter: ReviewsFilter
  /** 监控目标选项（筛选下拉 + AI 洞察标题） */
  monitors: Array<{ id: string; platform: string; title: string | null; targetUrl: string }>
  insights: InsightCard[]
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [keyword, setKeyword] = React.useState(filter.q)
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    setKeyword(filter.q)
  }, [filter.q])

  // 以 ref 里的「最新筛选状态」为基准合并 patch 并立即写回：导航未完成（服务端
  // props 还是旧 filter）期间再点筛选，若以本轮渲染的 props 为基准会互相覆盖
  //（日期范围第二击必然丢掉第一击）；重渲染时仍以服务端 props 同步纠偏
  const filterRef = React.useRef(filter)
  React.useEffect(() => {
    filterRef.current = filter
  }, [filter])

  const push = (patch: Partial<ReviewsFilter>, page = 1, pageSize: number = initial.pageSize) => {
    const next = { ...filterRef.current, ...patch }
    filterRef.current = next
    // pageSize 默认取当前每页条数：翻页不传时 URL 参数消失会让服务端回落 20，
    // 每页条数静默复位且页码口径突变；为 20 时与现状一致不落参数
    startTransition(() => router.push(buildQuery(next, {}, page, pageSize)))
  }

  const refreshSummary = (card: InsightCard) => {
    setRefreshingId(card.id)
    void (async () => {
      try {
        const res =
          card.kind === "monitor" && card.monitorId
            ? await refreshMonitorAiSummaryAction(card.monitorId)
            : card.kind === "target" && card.targetUrl
              ? await refreshTargetAiSummaryAction(card.targetUrl)
              : await refreshSocialDigestAction(card.platform ?? "")
        if (!res.ok) throw new Error(res.error)
        toast.success("AI 分析已刷新")
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "刷新失败")
      } finally {
        setRefreshingId(null)
      }
    })
  }

  const hasFilter = Boolean(filter.platform || filter.monitorId || filter.rating || filter.verified || filter.q || filter.dateFrom || filter.dateTo)
  const s = initial.stats
  const verifiedPct = s.count > 0 ? Math.round((s.verifiedCount / s.count) * 100) : null
  const fiveStarPct = s.ratedCount > 0 ? Math.round((s.ratingCounts[4]! / s.ratedCount) * 100) : null

  // AI 洞察分组；平台筛选时只看该平台
  const groups: Array<{ key: string; title: string; items: InsightCard[] }> = [
    { key: "monitor", title: "监控目标", items: insights.filter((c) => c.kind === "monitor") },
    { key: "target", title: "一次性抓取目标", items: insights.filter((c) => c.kind === "target") },
    { key: "digest", title: "社媒日报", items: insights.filter((c) => c.kind === "digest") },
  ]
    .map((g) => ({
      ...g,
      items: filter.platform ? g.items.filter((c) => c.platform === filter.platform) : g.items,
    }))
    .filter((g) => g.items.length > 0)

  const pageCount = Math.max(1, Math.ceil(initial.total / initial.pageSize))

  return (
    <div className={cn("space-y-4 transition-opacity", pending && "opacity-70")}>
      <KpiStrip
        items={[
          { key: "count", label: "评论数", value: s.count },
          { key: "avg", label: "平均评分", value: s.avgRating != null ? s.avgRating.toFixed(2) : "—" },
          { key: "verified", label: "已验证占比", value: verifiedPct != null ? `${verifiedPct}%` : "—" },
          { key: "five", label: "5 星占比", value: fiveStarPct != null ? `${fiveStarPct}%` : "—" },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        {/* AI 洞察 */}
        <section className="space-y-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4 text-primary" /> AI 洞察
            <span className="text-xs font-normal text-muted-foreground">（内部模型自动汇总，不扣积分）</span>
          </p>
          {groups.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
              还没有 AI 洞察——把商品 / 帖子加入竞品监控（或在详情弹窗点「抓取评论」），抓到评论后会自动生成情感、卖点、痛点与行动建议。
            </p>
          ) : (
            groups.map((g) => {
              const expanded = expandedGroups[g.key] ?? false
              const shown = expanded ? g.items : g.items.slice(0, 3)
              return (
                <div key={g.key} className="space-y-2">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    aria-expanded={expanded}
                    onClick={() => setExpandedGroups((v) => ({ ...v, [g.key]: !expanded }))}
                  >
                    {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    {g.title} · {g.items.length}
                  </button>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {shown.map((c) => (
                      <AiSummaryCard
                        key={c.id}
                        title={c.title}
                        meta={
                          c.kind === "digest"
                            ? `${platformLabel(c.platform ?? "")} · ${c.day ?? ""} · ${c.postCount} 条帖子`
                            : `${platformLabel(c.platform ?? "")} · ${c.reviewCount} 条评论 · ${formatDateTime(c.updatedAt)}`
                        }
                        data={c.summary}
                        refreshing={refreshingId === c.id}
                        onRefresh={() => refreshSummary(c)}
                      />
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </section>

        {/* 星级分布 */}
        <aside className="rounded-xl border bg-card p-3 lg:sticky lg:top-16 lg:self-start">
          <p className="mb-2 text-xs font-semibold">星级分布</p>
          <RatingDistribution counts={s.ratingCounts} active={filter.rating} onPick={(rating) => push({ rating })} />
          <p className="mt-2 text-[11px] text-muted-foreground">点击星级可只看该星级的评论</p>
        </aside>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          ariaLabel="平台筛选"
          placeholder="全部平台"
          value={isSelectionPlatform(filter.platform) ? filter.platform : ""}
          onChange={(v) => push({ platform: v })}
          items={[
            { value: "", label: "全部平台" },
            ...REVIEW_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) })),
          ]}
          width="w-32"
        />
        {monitors.length > 0 ? (
          <FilterSelect
            ariaLabel="监控目标筛选"
            placeholder="全部监控目标"
            value={filter.monitorId}
            onChange={(v) => push({ monitorId: v })}
            items={[
              { value: "", label: "全部监控目标" },
              // 全量选项与服务端数据源同限（limit 100）：此前 slice(0,50) 会让
              // URL 里第 51+ 个目标 ID 显示成原始 UUID 且无法被选中
              ...monitors.map((m) => ({
                value: m.id,
                label: `${platformLabel(m.platform)}「${(m.title ?? m.targetUrl).slice(0, 14)}」`,
              })),
            ]}
            width="w-52"
          />
        ) : null}
        <FilterSelect
          ariaLabel="星级筛选"
          placeholder="全部星级"
          value={filter.rating}
          onChange={(v) => push({ rating: v })}
          items={[
            { value: "", label: "全部星级" },
            { value: "5", label: "5 星" },
            { value: "4", label: "4 星" },
            { value: "3", label: "3 星" },
            { value: "2", label: "2 星" },
            { value: "1", label: "1 星" },
          ]}
          width="w-28"
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={filter.verified === "1"} onCheckedChange={(v) => push({ verified: v ? "1" : "" })} />
          仅已验证
        </label>
        <FilterSelect
          ariaLabel="排序"
          placeholder="最新抓取"
          value={filter.sort}
          onChange={(v) => push({ sort: v })}
          items={(REVIEW_SORTS as readonly string[]).map((s) => ({ value: s, label: REVIEW_SORT_LABELS[s as keyof typeof REVIEW_SORT_LABELS] }))}
          width="w-36"
        />
        <DateRangePicker
          size="sm"
          className="h-8 text-xs"
          placeholder="抓取日期"
          value={{
            from: filter.dateFrom ? new Date(`${filter.dateFrom}T00:00:00`) : undefined,
            to: filter.dateTo ? new Date(`${filter.dateTo}T00:00:00`) : undefined,
          }}
          onChange={(range) =>
            push({
              dateFrom: range?.from ? format(range.from, "yyyy-MM-dd") : "",
              dateTo: range?.to ? format(range.to, "yyyy-MM-dd") : "",
            })
          }
        />
        <Input
          type="search"
          aria-label="搜索评论内容"
          value={keyword}
          maxLength={120}
          placeholder="搜索评论内容"
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            // 输入法候选词未上屏时按 Enter 是确认候选，不应触发搜索跳转
            if (e.nativeEvent.isComposing) return
            if (e.key === "Enter") push({ q: keyword.trim() })
          }}
          className="h-8 w-44 text-xs"
        />
        {hasFilter ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => push({ platform: "", monitorId: "", rating: "", verified: "", q: "", dateFrom: "", dateTo: "" })}
          >
            <X className="size-3.5" />
            清除筛选
          </button>
        ) : null}
      </div>

      {/* 评论流 */}
      {initial.items.length === 0 ? (
        <SelectionEmpty
          icon={<MessageSquareQuote className="size-6" />}
          title={hasFilter ? "没有符合筛选条件的评论" : "还没有评论数据"}
          description={
            hasFilter
              ? "试试放宽星级、日期或平台筛选。"
              : "在选品发现把竞品加入监控（支持评论的平台会自动抓取评论并生成 AI 分析），或在详情弹窗点「抓取评论」。"
          }
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">共 {initial.total} 条评论</p>
          <div className="space-y-2">
            {initial.items.map((r) => (
              <ReviewCard key={r.id} r={r} />
            ))}
          </div>
          <TablePagination
            pageIndex={initial.page - 1}
            pageCount={pageCount}
            total={initial.total}
            pageSize={initial.pageSize}
            pageSizeOptions={PAGE_SIZES}
            disabled={pending}
            onPageChange={(idx) => push({}, idx + 1)}
            onPageSizeChange={(size) => push({}, 1, size)}
          />
        </>
      )}
    </div>
  )
}
