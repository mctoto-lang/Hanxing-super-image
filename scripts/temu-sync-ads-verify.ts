/* 一次性：RoseBlanche 全源同步（验证 ads-reports 新链路落库）+ 查两表行数 */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"

async function main() {
  const { sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { syncStore } = await import("../src/server/services/temu-sync")

  const [store] = await db
    .select()
    .from(temuStores)
    .where(sql`${temuStores.name} = ${storeName}`)
    .limit(1)
  if (!store) {
    console.error(`store not found: ${storeName}`)
    process.exit(1)
  }
  console.log("syncing", store.name, "...")
  const outcome = await syncStore(store.id)
  console.log("outcome:", JSON.stringify({ ok: outcome.status?.ok, sources: outcome.status?.sources }))

  const { temuAdsDailies, temuAdsProductDailies } = await import("../src/db/schema/temu")
  const daily = await db
    .select({ date: temuAdsDailies.date, adSpend: temuAdsDailies.adSpend, orders: temuAdsDailies.orders })
    .from(temuAdsDailies)
    .where(sql`${temuAdsDailies.storeId} = ${store.id}`)
    .orderBy(sql`${temuAdsDailies.date} desc`)
    .limit(5)
  const prod = await db
    .select({ productId: temuAdsProductDailies.productId, date: temuAdsProductDailies.date, adSpend: temuAdsProductDailies.adSpend })
    .from(temuAdsProductDailies)
    .where(sql`${temuAdsProductDailies.storeId} = ${store.id}`)
    .orderBy(sql`${temuAdsProductDailies.adSpend} desc nulls last`)
    .limit(5)
  const prodCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(temuAdsProductDailies)
    .where(sql`${temuAdsProductDailies.storeId} = ${store.id}`)
  console.log("temu_ads_daily 前5:", JSON.stringify(daily))
  console.log("temu_ads_product_daily 总行:", prodCount[0]?.n, "花费前5:", JSON.stringify(prod))
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
