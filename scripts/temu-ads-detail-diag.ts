/* 一次性：诊断同步链路里 detail.query 的真实返回（在售前 20 直调） */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"

async function main() {
  const { and, eq, isNotNull, sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db
    .select()
    .from(temuStores)
    .where(sql`${temuStores.name} = ${storeName}`)
    .limit(1)
  if (!store) {
    console.error(`store not found: ${storeName}`)
    process.exit(1)
  }
  const ids = (
    await db
      .select({ productId: temuProducts.productId })
      .from(temuProducts)
      .where(
        and(
          eq(temuProducts.storeId, store.id),
          isNotNull(temuProducts.productId),
          sql`${temuProducts.skcStatus} in (1, 11)`,
        ),
      )
  )
    .map((r) => Number(r.productId))
    .filter(Number.isFinite)
  console.log("在售 productId 数:", ids.length)
  const built = await getTemuCallContext(store)
  const env = await callTemuApi<{ adsDetail?: unknown[] }>(
    "bg.glo.searchrec.ad.detail.query",
    { productIdList: ids.slice(0, 20) },
    built,
  )
  const list = env.result?.adsDetail ?? []
  console.log("detail 返回条数:", list.length)
  if (list.length > 0) console.log("首条:", JSON.stringify(list[0]).slice(0, 150))
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
