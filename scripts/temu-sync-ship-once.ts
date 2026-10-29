/* 一次性：RoseBlanche 全源同步，验证新源 api-ship-orders 真实店落库（只读官方+本地 upsert）。
 * 运行：cmd //c pnpm tsx scripts/temu-sync-ship-once.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq, sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuShipOrders } = await import("../src/db/schema/temu")
  const { syncStore } = await import("../src/server/services/temu-sync")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, "RoseBlanche")).limit(1)
  if (!store) {
    console.log("RoseBlanche 不存在")
    process.exit(0)
  }
  const t0 = Date.now()
  const outcome = await syncStore(store.id)
  console.log("sources:", JSON.stringify(outcome.status?.sources ?? outcome, null, 1).slice(0, 1600))
  const [cnt] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(temuShipOrders)
    .where(eq(temuShipOrders.storeId, store.id))
  const sample = await db
    .select({
      sn: temuShipOrders.deliveryOrderSn,
      status: temuShipOrders.status,
      ext: temuShipOrders.skcExtCode,
      deliver: temuShipOrders.deliverTime,
    })
    .from(temuShipOrders)
    .where(eq(temuShipOrders.storeId, store.id))
    .orderBy(sql`coalesce(${temuShipOrders.deliverTime}, ${temuShipOrders.deliveryOrderCreateTime}) desc nulls last`)
    .limit(3)
  console.log(`temu_ship_order rows=${cnt?.n} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`)
  console.log("latest:", JSON.stringify(sample))
  process.exit(0)
}

void main()
