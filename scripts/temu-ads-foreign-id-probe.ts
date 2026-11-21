/* 一次性：验证「他店商品 ID 传本店 token」detail.query 报什么错误码
 * （生产 MISS FIREE 报 230012000 bad query params，假设=候选集混入跨店双落脏行） */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { and, eq, isNotNull, sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const pickIds = async (storeId: string, n: number) =>
    (
      await db
        .select({ productId: temuProducts.productId })
        .from(temuProducts)
        .where(
          and(
            eq(temuProducts.storeId, storeId),
            isNotNull(temuProducts.productId),
            sql`${temuProducts.skcStatus} in (1, 11)`,
          ),
        )
    )
      .map((r) => Number(r.productId))
      .filter(Number.isFinite)
      .slice(0, n)

  const byName = async (name: string) => {
    const [row] = await db
      .select()
      .from(temuStores)
      .where(sql`${temuStores.name} = ${name}`)
      .limit(1)
    if (!row) {
      console.error(`未找到店铺「${name}」：temu_stores.name 精确匹配无结果，请确认店铺名与当前环境`)
      process.exit(1)
    }
    return row
  }

  const mine = await byName("MISS FIREE")
  const other = await byName("RoseBlanche")
  const otherIds = await pickIds(other.id, 5)
  const mineIds = await pickIds(mine.id, 5)
  console.log(`他店(RoseBlanche)样本 ID:`, otherIds)
  console.log(`本店(MISS FIREE)样本 ID:`, mineIds)

  const ctx = await getTemuCallContext(mine)
  await new Promise((r) => setTimeout(r, 10000))
  for (const [label, ids] of [
    ["纯他店ID×5", otherIds],
    ["混合(本店3+他店2)", [...mineIds.slice(0, 3), ...otherIds.slice(0, 2)]],
  ] as const) {
    try {
      const env = await callTemuApi<{ adsDetail?: unknown[] }>(
        "bg.glo.searchrec.ad.detail.query",
        { productIdList: ids },
        ctx,
      )
      console.log(`[${label}] success，返回条数:`, env.result?.adsDetail?.length ?? 0)
    } catch (e) {
      console.log(`[${label}] 失败:`, e instanceof Error ? e.message.slice(0, 200) : e)
    }
    await new Promise((r) => setTimeout(r, 10000))
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
