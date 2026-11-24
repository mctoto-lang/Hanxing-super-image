import Link from "next/link"
import { and, desc, eq, inArray } from "drizzle-orm"
import { redirect } from "next/navigation"
import { TrendingUp } from "lucide-react"
import { db } from "@/db/client"
import { selectionTasks } from "@/db/schema"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { TablePagination, parsePageSizeParam } from "@/components/shared/table-pagination"
import { Button } from "@/components/ui/button"
import { SelectionActiveTaskBanner } from "@/components/selection/active-task-banner"
import { PlatformTabs } from "@/components/selection/platform-tabs"
import { PoolFilterBar } from "@/components/selection/pool-filter-bar"
import { PoolGrid } from "@/components/selection/pool-grid"
import { SelectionEmpty } from "@/components/selection/empty-state"
import { KpiStrip, poolKpiItems } from "@/components/selection/kpi-strip"
import { platformLabel } from "@/components/selection/labels"
import { platformView, sortOptionsFor } from "@/lib/selection/platform-views"
import { isPoolSort } from "@/lib/selection/pool-types"
import { parsePoolFilter, poolHref, poolQuery } from "@/lib/selection/pool-url"
import { isSelectionPlatform, platformsForCategory } from "@/lib/selection/platforms"
import { parseUuid } from "@/lib/selection/ids"
import {
  getSelectionPoolCountsAction,
  getSelectionPoolMetaAction,
  getSelectionPoolStatsAction,
  getSelectionResultsPoolAction,
} from "@/server/actions/selection"

export const dynamic = "force-dynamic"

const BASE_PATH = "/selection/market"
const PAGE_SIZE_OPTIONS = [25, 50, 100]

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 市场分析 = 社媒帖子流的平台标签视图（TikTok / Instagram / Pinterest / Reddit /
 * X / Facebook 各自独立）：每个平台用自己的 KPI 与互动指标（跨平台把播放 / 点赞 /
 * 保存混加没有意义），卡片与详情按平台定制，带视频的帖子可在详情里播放。
 */
export default async function SelectionMarketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />
  const enterpriseId = ctx.user.enterpriseId!

  const sp = await searchParams
  const platforms = platformsForCategory("social")
  // 计数 action 只在成功时返回（无权限等直接抛错），无需失败分支
  const { counts } = await getSelectionPoolCountsAction({ category: "social" })

  // 平台：URL 指定 > 来源任务所属平台 > 第一个有数据的平台（兜底 TikTok）。
  // 任务 ID 过 parseUuid 消毒：垃圾值不进 action 的 uuid 字段（否则整页只渲染
  // 「参数错误」），按「无该筛选」处理；消毒值同步进 filter，规范化 redirect 顺带剔除
  const requested = first(sp.platform)
  const taskId = parseUuid(first(sp.task)) ?? ""
  let taskPlatform: string | null = null
  if (taskId && !requested) {
    const [task] = await db
      .select({ platform: selectionTasks.platform })
      .from(selectionTasks)
      .where(and(eq(selectionTasks.id, taskId), eq(selectionTasks.enterpriseId, enterpriseId)))
      .limit(1)
    taskPlatform = task?.platform ?? null
  }
  const platform = isSelectionPlatform(requested) && platforms.includes(requested)
    ? requested
    : taskPlatform && isSelectionPlatform(taskPlatform) && platforms.includes(taskPlatform)
      ? taskPlatform
      : (platforms.find((p) => (counts[p] ?? 0) > 0) ?? "tiktok")

  const sortRaw = first(sp.sort)
  const sort = isPoolSort(sortRaw) && sortOptionsFor(platform).some((o) => o.value === sortRaw) ? sortRaw : "newest"

  const filter = parsePoolFilter({ ...sp, task: taskId }, { platform, sort })
  // 平台缺省 / 非法 / 由任务推断：规范化 URL（社媒只有卡片视图，table 参数不保留）
  if (requested !== platform || (sortRaw && sortRaw !== sort) || filter.view === "table") {
    redirect(poolHref(BASE_PATH, { ...filter, sort, view: "card" }))
  }

  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1))
  const pageSize = parsePageSizeParam(sp, PAGE_SIZE_OPTIONS)

  const actionInput = {
    platform,
    category: "social" as const,
    taskType: filter.taskType || undefined,
    q: filter.q || undefined,
    taskId: taskId || undefined,
    sort,
    dedupe: filter.dedupe,
    dateFrom: filter.dateFrom || undefined,
    dateTo: filter.dateTo || undefined,
  }

  const [activeTasks, pool, stats, meta] = await Promise.all([
    db
      .select({
        id: selectionTasks.id,
        platform: selectionTasks.platform,
        keyword: selectionTasks.keyword,
        status: selectionTasks.status,
        progress: selectionTasks.progress,
        fetchedCount: selectionTasks.fetchedCount,
        maxResults: selectionTasks.maxResults,
      })
      .from(selectionTasks)
      .where(
        and(
          eq(selectionTasks.enterpriseId, enterpriseId),
          eq(selectionTasks.platform, platform),
          inArray(selectionTasks.status, ["queued", "processing"]),
        ),
      )
      .orderBy(desc(selectionTasks.createdAt))
      .limit(5),
    getSelectionResultsPoolAction({ ...actionInput, page, pageSize }),
    getSelectionPoolStatsAction(actionInput),
    getSelectionPoolMetaAction({ platform }),
  ])

  if (!pool.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="市场分析" description="社媒平台帖子热度流。" />
        <p className="text-sm text-destructive">{pool.error}</p>
      </div>
    )
  }

  const query = poolQuery({ ...filter, sort })
  // 社媒平台无国家维度（country 恒空），不参与「有筛选」判定
  const hasFilter = Boolean(filter.q || taskId || filter.taskType || filter.dateFrom || filter.dateTo)
  const scrapeHref = `/selection/tasks?new=1&platform=${platform}&type=market`

  return (
    <div className="space-y-4">
      <PageHeader
        title="市场分析"
        description="社媒平台帖子热度流：按平台标签独立查看各平台的帖子与互动数据，点击卡片看详情（带视频的可直接播放）、可加入竞品监控。"
      />

      <SelectionActiveTaskBanner initialTasks={activeTasks} />

      <PlatformTabs
        category="social"
        value={platform}
        counts={counts}
        filter={filter}
        basePath={BASE_PATH}
      >
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={scrapeHref} />}>
          抓取 {platformLabel(platform)} 数据
        </Button>
      </PlatformTabs>

      <KpiStrip items={poolKpiItems(platform, stats.ok ? stats.stats : null)} />

      <PoolFilterBar
        state={filter}
        countries={meta.ok ? meta.countries : []}
        tasks={meta.ok ? meta.tasks : []}
        basePath={BASE_PATH}
        sortOptions={sortOptionsFor(platform)}
        showTaskFilters
        dedupeLabel="按帖子去重"
      />

      {pool.items.length === 0 ? (
        <SelectionEmpty
          icon={<TrendingUp className="size-6" />}
          title={pool.total === 0 && !hasFilter ? `${platformLabel(platform)} 还没有帖子数据` : "没有符合筛选条件的帖子"}
          description={
            pool.total === 0 && !hasFilter
              ? "对关键词或话题发起一次抓取，帖子会汇总到这里。"
              : "试试放宽日期或来源任务筛选。"
          }
          action={
            pool.total === 0 && !hasFilter ? (
              <Button size="sm" nativeButton={false} render={<Link href={scrapeHref} />}>
                去抓取 {platformLabel(platform)}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            共 {pool.total} 条帖子{filter.dedupe ? "（已按帖子去重）" : ""}
          </p>
          <PoolGrid
            items={pool.items}
            filter={filter}
            basePath={BASE_PATH}
            columns={platformView(platform).columns}
            bookmarkedIds={pool.bookmarkedIds}
            monitoredUrls={pool.monitoredUrls}
            monitoredIds={pool.monitoredIds}
          />
          <TablePagination
            page={pool.page}
            pageSize={pageSize}
            total={pool.total}
            basePath={BASE_PATH}
            query={query}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  )
}
