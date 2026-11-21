import Link from "next/link"
import { MessageCircle, ThumbsUp, Eye, FileStack } from "lucide-react"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import {
  TablePagination,
  parsePageSizeParam,
} from "@/components/shared/table-pagination"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { PoolFilterBar } from "@/components/selection/pool-filter-bar"
import { PoolGrid } from "@/components/selection/pool-grid"
import { compactNumber } from "@/components/selection/labels"
import {
  getSelectionPoolMetaAction,
  getSelectionResultsPoolAction,
  getSelectionSocialPulseAction,
} from "@/server/actions/selection"
import type { PoolSort } from "@/lib/selection/pool-types"

export const dynamic = "force-dynamic"

const PAGE_SIZE_OPTIONS = [25, 50, 100]

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 市场分析 = 社媒帖子流（2026-11-21 改版，用户拍板「完全卡片化」）：
 * 跨任务聚合社媒平台（TikTok/IG/Pinterest/Reddit/X/FB）帖子卡片，顶部 KPI
 * 脉搏条（帖子/点赞/评论/浏览），抓取日期范围筛选（按日期划分数据口径）；
 * 点击卡片开详情弹窗。抓取入口在数据任务页。
 */
export default async function SelectionMarketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />

  const sp = await searchParams
  const filter = {
    platform: first(sp.platform),
    country: first(sp.country),
    q: first(sp.q),
    sort: first(sp.sort) || "newest",
    dedupe: first(sp.dedupe) !== "0",
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(first(sp.dateFrom)) ? first(sp.dateFrom) : "",
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(first(sp.dateTo)) ? first(sp.dateTo) : "",
  }
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1))
  const pageSize = parsePageSizeParam(sp, PAGE_SIZE_OPTIONS)

  const actionInput = {
    platform: filter.platform || undefined,
    country: filter.country || undefined,
    q: filter.q || undefined,
    sort: filter.sort as PoolSort,
    dedupe: filter.dedupe,
    dateFrom: filter.dateFrom || undefined,
    dateTo: filter.dateTo || undefined,
  }

  const [pool, pulse, meta] = await Promise.all([
    getSelectionResultsPoolAction({ ...actionInput, category: "social", page, pageSize }),
    getSelectionSocialPulseAction(actionInput),
    getSelectionPoolMetaAction(),
  ])

  if (!pool.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="市场分析" description="社媒帖子热度流。" />
        <p className="text-sm text-destructive">{pool.error}</p>
      </div>
    )
  }

  const query: Record<string, string | undefined> = {}
  if (filter.platform) query.platform = filter.platform
  if (filter.country) query.country = filter.country
  if (filter.q) query.q = filter.q
  if (filter.sort !== "newest") query.sort = filter.sort
  if (filter.dateFrom) query.dateFrom = filter.dateFrom
  if (filter.dateTo) query.dateTo = filter.dateTo
  if (!filter.dedupe) query.dedupe = "0"

  // 空态口径：无任何内容筛选且无数据才引导去抓取，否则按「筛选无结果」提示
  const hasFilter = Boolean(
    filter.platform || filter.country || filter.q || filter.dateFrom || filter.dateTo,
  )

  const kpis = [
    { icon: FileStack, label: "帖子", value: pulse.ok ? compactNumber(pulse.posts) : "—" },
    { icon: ThumbsUp, label: "总点赞", value: pulse.ok ? compactNumber(pulse.likes) : "—" },
    { icon: MessageCircle, label: "总评论", value: pulse.ok ? compactNumber(pulse.comments) : "—" },
    { icon: Eye, label: "总浏览", value: pulse.ok ? compactNumber(pulse.views) : "—" },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="市场分析"
        description="社媒平台帖子热度流：跨任务聚合最新抓取的帖子与互动数据，点击卡片看详情、可加入竞品监控。"
      />

      {/* KPI 脉搏条（随筛选联动） */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="py-0">
            <CardContent className="flex items-center gap-3 px-4 py-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <k.icon className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{k.label}</p>
                <p className="truncate text-lg leading-tight font-semibold tabular-nums">
                  {k.value}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <PoolFilterBar
        state={{ ...filter, taskType: "", task: "" }}
        countries={meta.ok ? meta.countries : []}
        tasks={[]}
        basePath="/selection/market"
        category="social"
      />

      {pool.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {pool.total === 0 && !hasFilter
              ? "还没有社媒帖子数据——去数据任务页对 TikTok/Instagram 等平台发起抓取。"
              : "没有符合筛选条件的帖子。"}
          </p>
          {pool.total === 0 && !hasFilter ? (
            <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/selection/tasks" />}>
              前往数据任务
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            共 {pool.total} 条帖子{filter.dedupe ? "（已按帖子去重）" : ""}
          </p>
          <PoolGrid
            items={pool.items}
            bookmarkedIds={pool.bookmarkedIds}
            monitoredUrls={pool.monitoredUrls}
          />
          <TablePagination
            page={pool.page}
            pageSize={pageSize}
            total={pool.total}
            basePath="/selection/market"
            query={query}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  )
}
