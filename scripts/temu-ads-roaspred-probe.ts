/* 一次性：roas.pred 原始返回探针（区分官方推荐 vs 回落） */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"

async function main() {
  const { sql } = await import("drizzle-orm")
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
  const onSale = (
    await db
      .select({ productId: temuProducts.productId })
      .from(temuProducts)
      .where(
        sql`${temuProducts.storeId} = ${store.id} and ${temuProducts.skcStatus} in (1,11) and ${temuProducts.productId} is not null`,
      )
  )
    .map((r) => Number(r.productId))
    .filter(Number.isFinite)
  const built = await getTemuCallContext(store)
  try {
    const env = await callTemuApi(
      "bg.glo.searchrec.ad.roas.pred",
      { goodsInfoList: onSale.slice(0, 5).map((id) => ({ productId: id })) },
      built,
    )
    console.log("roas.pred result:", JSON.stringify(env.result).slice(0, 500))
  } catch (e) {
    console.log("roas.pred 失败:", e instanceof Error ? e.message.slice(0, 200) : e)
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
