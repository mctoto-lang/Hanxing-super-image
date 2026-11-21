import Link from "next/link"
import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionTasks } from "@/db/schema"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { TablePagination, parsePageSizeParam } from "@/components/shared/table-pagination"
import { Button } from "@/components/ui/button"
import { SelectionActiveTaskBanner } from "@/components/selection/active-task-banner"
import { PoolFilterBar } from "@/components/selection/pool-filter-bar"
import { PoolGrid } from "@/components/selection/pool-grid"
import {
  getSelectionPoolMetaAction,
  getSelectionResultsPoolAction,
} from "@/server/actions/selection"
import type { PoolSort } from "@/lib/selection/pool-types"

export const dynamic = "force-dynamic"

const PAGE_SIZE_OPTIONS = [25, 50, 100]

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 选品发现 = 数据池：全部抓取结果跨任务综合展示（默认按商品去重，同款只出
 * 一张卡取最新），筛选/分页 URL 驱动；抓取入口集中在数据任务页。
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
  const filter = {
    platform: first(sp.platform),
    country: first(sp.country),
    taskType: first(sp.taskType),
    task: first(sp.task),
    q: first(sp.q),
    sort: first(sp.sort) || "newest",
    dedupe: first(sp.dedupe) !== "0",
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(first(sp.dateFrom)) ? first(sp.dateFrom) : "",
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(first(sp.dateTo)) ? first(sp.dateTo) : "",
  }
  const page = Math.max(1, Math.floor(Number(first(sp.page)) || 1))
  const pageSize = parsePageSizeParam(sp, PAGE_SIZE_OPTIONS)

  const [activeTasks, pool, meta] = await Promise.all([
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
          inArray(selectionTasks.status, ["queued", "processing"]),
        ),
      )
      .orderBy(desc(selectionTasks.createdAt))
      .limit(5),
    getSelectionResultsPoolAction({
      platform: filter.platform || undefined,
      country: filter.country || undefined,
      category: "ecommerce",
      taskType:
        filter.taskType === "discover" || filter.taskType === "market" || filter.taskType === "monitor"
          ? filter.taskType
          : undefined,
      taskId: filter.task || undefined,
      q: filter.q || undefined,
      sort: filter.sort as PoolSort,
      dedupe: filter.dedupe,
      dateFrom: filter.dateFrom || undefined,
      dateTo: filter.dateTo || undefined,
      page,
      pageSize,
    }),
    getSelectionPoolMetaAction(),
  ])

  if (!pool.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="选品发现" description="全部抓取数据的综合展示池。" />
        <p className="text-sm text-destructive">{pool.error}</p>
      </div>
    )
  }

  const query: Record<string, string | undefined> = {}
  if (filter.platform) query.platform = filter.platform
  if (filter.country) query.country = filter.country
  if (filter.taskType) query.taskType = filter.taskType
  if (filter.task) query.task = filter.task
  if (filter.q) query.q = filter.q
  if (filter.sort !== "newest") query.sort = filter.sort
  if (filter.dateFrom) query.dateFrom = filter.dateFrom
  if (filter.dateTo) query.dateTo = filter.dateTo
  if (!filter.dedupe) query.dedupe = "0"

  // 空态口径：无任何内容筛选且无数据才引导去抓取（两处空态共用同一字段集）
  const hasFilter = Boolean(
    filter.q ||
      filter.platform ||
      filter.country ||
      filter.task ||
      filter.taskType ||
      filter.dateFrom ||
      filter.dateTo,
  )

  return (
    <div className="space-y-4">
      <PageHeader
        title="选品发现"
        description="全部抓取数据的综合展示池：按商品去重（同款取最新），点击卡片查看详情；抓取入口在数据任务页。"
      />

      <SelectionActiveTaskBanner initialTasks={activeTasks} />

      <PoolFilterBar
        state={filter}
        countries={meta.ok ? meta.countries : []}
        tasks={meta.ok ? meta.tasks : []}
        basePath="/selection/discover"
        category="ecommerce"
      />

      {pool.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            {pool.total === 0 && !hasFilter
              ? "数据池还是空的——去数据任务页发起第一次抓取。"
              : "没有符合筛选条件的数据。"}
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
            共 {pool.total} 条{filter.dedupe ? "（已按商品去重）" : "（全部记录）"}
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
            basePath="/selection/discover"
            query={query}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  )
}
