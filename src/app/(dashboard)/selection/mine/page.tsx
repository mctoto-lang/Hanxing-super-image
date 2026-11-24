import { desc, eq, sql } from "drizzle-orm"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { TablePagination, parsePageParam } from "@/components/shared/table-pagination"
import { SelectionMineClient, MINE_UNGROUPED, type BookmarkItem } from "@/components/selection/mine-client"
import { isBookmarkSort } from "@/lib/selection/pool-url"
import { isSelectionPlatform } from "@/lib/selection/platforms"
import { listSelectionBookmarksAction } from "@/server/actions/selection"
import { db } from "@/db/client"
import { selectionBookmarks } from "@/db/schema"

export const dynamic = "force-dynamic"

const BASE_PATH = "/selection/mine"
const PAGE_SIZE = 24

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 我的选品：收藏管理（个人维度）——集合 / 平台 / 优先级 / 关键词 / 排序筛选全部
 * URL 驱动；卡片与详情弹窗复用数据池组件；批量归集 / 设优先级 / 移除；导出 Excel。
 */
export default async function SelectionMinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />
  const userId = ctx.user.id

  const sp = await searchParams
  const collectionRaw = first(sp.collection)
  // URL：缺省 = 全部；__ungrouped__ = 未分组；其余 = 集合名
  const collectionParam = collectionRaw === MINE_UNGROUPED ? MINE_UNGROUPED : collectionRaw
  const platformRaw = first(sp.platform)
  const platform = isSelectionPlatform(platformRaw) ? platformRaw : ""
  const priorityRaw = first(sp.priority)
  const priority = ["high", "medium", "low"].includes(priorityRaw) ? priorityRaw : ""
  const q = first(sp.q).slice(0, 120)
  const sortRaw = first(sp.sort)
  const sort = isBookmarkSort(sortRaw) ? sortRaw : "newest"
  const page = parsePageParam(sp)

  // 集合清单（名称 + 计数；null = 未分组），按数量降序
  const collectionRows = await db
    .select({
      name: selectionBookmarks.collectionName,
      count: sql<number>`count(*)::int`,
    })
    .from(selectionBookmarks)
    .where(eq(selectionBookmarks.userId, userId))
    .groupBy(selectionBookmarks.collectionName)
    .orderBy(desc(sql`count(*)`), selectionBookmarks.collectionName)

  const res = await listSelectionBookmarksAction({
    // action 口径：空串 = 未分组；缺省 = 全部
    collectionName: collectionParam === MINE_UNGROUPED ? "" : collectionParam || undefined,
    platform: platform || undefined,
    priority: priority ? (priority as "high" | "medium" | "low") : undefined,
    q: q || undefined,
    sort,
    page,
    pageSize: PAGE_SIZE,
  })
  if (!res.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="我的选品" description="收藏的商品与内容。" />
        <p className="text-sm text-destructive">{res.error}</p>
      </div>
    )
  }

  const query: Record<string, string | undefined> = {}
  if (collectionParam) query.collection = collectionParam
  if (platform) query.platform = platform
  if (priority) query.priority = priority
  if (q) query.q = q
  if (sort !== "newest") query.sort = sort

  return (
    <div className="space-y-4">
      <PageHeader
        title="我的选品"
        description="收藏的商品与内容：按集合与优先级整理，可写选品笔记、打标签，支持批量操作与导出 Excel。"
      />

      <SelectionMineClient
        initialItems={res.items as BookmarkItem[]}
        initialTotal={res.total}
        page={res.page}
        collections={collectionRows}
        filter={{ collection: collectionParam, platform, priority, q, sort }}
      />

      {res.total > PAGE_SIZE ? (
        <TablePagination
          page={res.page}
          pageSize={PAGE_SIZE}
          total={res.total}
          basePath={BASE_PATH}
          query={query}
        />
      ) : null}
    </div>
  )
}
