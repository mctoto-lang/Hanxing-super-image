import { desc, eq, inArray, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import { db } from "@/db/client"

/**
 * 按拖拽后的新顺序重写一批行的 sortOrder（超管各配置域 reorder action 共用）。
 *
 * 值重分配策略见 allocateSortValues；未参与拖动的行（其它分页/分组/作用域）
 * 全局相对位置不受影响。
 */
export function allocateSortValues(
  existing: readonly number[],
  count: number,
): number[] {
  if (count <= 0) return []
  const values = [...new Set(existing)].sort((a, b) => a - b)
  // 全同值（从未配置过的表）→ 以该值为基准连续递增（全 0 时即 0..n）
  if (values.length <= 1) {
    const base = values[0] ?? 0
    return Array.from({ length: count }, (_, i) => base + i)
  }
  // 去重升序依次回填；批次内存在重复值（如存量默认 99 成片）时，
  // 超出的位置从最大值继续 +1，保证批次内严格递增——否则并列行
  // 的先后落到 tiebreak 上，拖拽顺序不落库
  const max = values[values.length - 1]!
  return Array.from(
    { length: count },
    (_, i) => (i < values.length ? values[i]! : max + (i - values.length + 1)),
  )
}

export async function redistributeSortOrder(
  table: PgTable & { id: PgColumn; sortOrder: PgColumn },
  ids: string[],
): Promise<void> {
  // 去重：重复 id 会按最后出现位置二次覆盖，破坏「新顺序 = 值分配」对应关系
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return

  // SELECT 与 UPDATE 同事务并加行锁：并发 reorder 交错执行时会基于旧值
  // 分配、互相覆盖；FOR UPDATE 让后到者读到先行者已提交的新值
  await db.transaction(async (tx) => {
    const rows = (await tx
      .select({ id: table.id, sortOrder: table.sortOrder })
      .from(table)
      .where(inArray(table.id, uniqueIds) as SQL)
      .for("update")) as Array<{
      id: string
      sortOrder: number
    }>
    const byId = new Map(rows.map((r) => [r.id, r.sortOrder]))
    // 只重写批次内实际存在的行；入参顺序即拖拽后的新顺序
    const orderedIds = uniqueIds.filter((id) => byId.has(id))
    const next = allocateSortValues(
      orderedIds.map((id) => byId.get(id)!),
      orderedIds.length,
    )
    for (const [i, id] of orderedIds.entries()) {
      await tx
        .update(table)
        .set({ sortOrder: next[i]! } as never)
        .where(eq(table.id, id) as SQL)
    }
  })
}

/** 新建行的排序值：追加到全表末尾（max + 1；空表为 0） */
export async function nextSortOrder(
  table: PgTable & { sortOrder: PgColumn },
): Promise<number> {
  const rows = (await db
    .select({ sortOrder: table.sortOrder })
    .from(table)
    .orderBy(desc(table.sortOrder))
    .limit(1)) as Array<{ sortOrder: number }>
  return (rows[0]?.sortOrder ?? -1) + 1
}
