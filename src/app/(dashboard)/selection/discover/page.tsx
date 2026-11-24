import Link from "next/link"
import { and, desc, eq, inArray } from "drizzle-orm"
import { redirect } from "next/navigation"
import { Radar } from "lucide-react"
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

const BASE_PATH = "/selection/discover"
const PAGE_SIZE_OPTIONS = [25, 50, 100]

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 选品发现 = 电商数据池的平台标签视图（Amazon / Etsy / TEMU / Shopify 各自独立）：
 * 每个平台用自己的 KPI、排序、卡片指标与表格列，完整呈现该平台抓到的数据；
 * 筛选 / 排序 / 视图 / 分页全部 URL 驱动；抓取入口集中在数据任务页。
 */
export default async function SelectionDiscoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />
  const enterpriseId = ctx.user.enterpriseId!

  const sp = await searchParams
  const platforms = platformsForCategory("ecommerce")

  // 平台：URL 指定 > 来源任务所属平台 > 第一个平台（Amazon）。
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
  const platform =
    isSelectionPlatform(requested) && platforms.includes(requested)
      ? requested
      : taskPlatform && isSelectionPlatform(taskPlatform) && platforms.includes(taskPlatform)
        ? taskPlatform
        : platforms[0]

  // 排序：只接受该平台视图声明的项
  const view = isSelectionPlatform(platform) ? platform : platforms[0]
  const sortRaw = first(sp.sort)
  const sort = isPoolSort(sortRaw) && sortOptionsFor(view).some((o) => o.value === sortRaw) ? sortRaw : "newest"

  const filter = parsePoolFilter({ ...sp, task: taskId }, { platform, sort })
  // 平台缺省 / 非法 / 由任务推断：规范化 URL（分享链接与刷新后稳定）
  if (requested !== platform || (sortRaw && sortRaw !== sort)) {
    redirect(poolHref(BASE_PATH, { ...filter, sort }))
  }

  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1))
  const pageSize = parsePageSizeParam(sp, PAGE_SIZE_OPTIONS)

  const actionInput = {
    platform,
    category: "ecommerce" as const,
    country: filter.country || undefined,
    taskType: filter.taskType || undefined,
    taskId: taskId || undefined,
    q: filter.q || undefined,
    sort,
    dedupe: filter.dedupe,
    dateFrom: filter.dateFrom || undefined,
    dateTo: filter.dateTo || undefined,
  }

  const [activeTasks, pool, stats, meta, counts] = await Promise.all([
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
    getSelectionPoolCountsAction({ category: "ecommerce" }),
  ])

  if (!pool.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="选品发现" description="各电商平台的抓取数据。" />
        <p className="text-sm text-destructive">{pool.error}</p>
      </div>
    )
  }

  const query = poolQuery({ ...filter, sort })
  // 空态口径：无任何内容筛选且无数据才引导去抓取（否则按「筛选无结果」提示）
  const hasFilter = Boolean(
    filter.q || filter.country || taskId || filter.taskType || filter.dateFrom || filter.dateTo,
  )
  const scrapeHref = `/selection/tasks?new=1&platform=${platform}&type=discover`

  return (
    <div className="space-y-4">
      <PageHeader
        title="选品发现"
        description="各电商平台的抓取数据池：按平台标签独立查看，同款商品去重（取最新），点击卡片查看完整数据；抓取入口在数据任务页。"
      />

      <SelectionActiveTaskBanner initialTasks={activeTasks} />

      <PlatformTabs
        category="ecommerce"
        value={platform}
        counts={counts.counts}
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
        showViewToggle
        dedupeLabel="按商品去重"
      />

      {pool.items.length === 0 ? (
        <SelectionEmpty
          icon={<Radar className="size-6" />}
          title={pool.total === 0 && !hasFilter ? `${platformLabel(platform)} 还没有抓取数据` : "没有符合筛选条件的数据"}
          description={
            pool.total === 0 && !hasFilter
              ? "发起一次该平台的抓取任务，结果会汇总到这里。"
              : "试试放宽国家、日期或来源任务筛选。"
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
            共 {pool.total} 条{filter.dedupe ? "（已按商品去重）" : "（全部记录）"}
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
