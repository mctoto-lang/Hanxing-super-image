import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionBookmarks, selectionResults } from "@/db/schema"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { SelectionMineClient } from "@/components/selection/mine-client"

export const dynamic = "force-dynamic"

/**
 * 我的选品：收藏管理（个人维度）——集合分组、笔记/标签、批量操作、导出
 */
export default async function SelectionMinePage() {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />
  const userId = ctx.user.id
  const enterpriseId = ctx.user.enterpriseId!

  const [collections, firstPage, [{ count: total }]] = await Promise.all([
    db
      .select({
        name: selectionBookmarks.collectionName,
        count: sql<number>`count(*)::int`,
      })
      .from(selectionBookmarks)
      .where(eq(selectionBookmarks.userId, userId))
      .groupBy(selectionBookmarks.collectionName),
    db
      .select({ bookmark: selectionBookmarks, result: selectionResults })
      .from(selectionBookmarks)
      .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
      .where(
        and(
          eq(selectionBookmarks.userId, userId),
          eq(selectionResults.enterpriseId, enterpriseId),
        ),
      )
      .orderBy(desc(selectionBookmarks.createdAt))
      .limit(24),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(selectionBookmarks)
      .innerJoin(selectionResults, eq(selectionBookmarks.resultId, selectionResults.id))
      .where(
        and(
          eq(selectionBookmarks.userId, userId),
          eq(selectionResults.enterpriseId, enterpriseId),
        ),
      ),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="我的选品"
        description="收藏的商品与内容：集合分组、优先级、笔记与标签，支持导出 Excel。"
      />
      <SelectionMineClient
        initialItems={firstPage.map((r) => ({ ...r.bookmark, result: r.result }))}
        initialTotal={total}
        collections={collections}
      />
    </div>
  )
}
