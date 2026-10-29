/* 只读探针：logisticsmatch.get 出参 channelScheduleTimeList 元素真实类型/样例。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-logistics-slots.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuShipOrders } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, "RoseBlanche")).limit(1)
  if (!store) {
    console.log("RoseBlanche 不存在")
    process.exit(0)
  }
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const [row] = await db
    .select()
    .from(temuShipOrders)
    .where(eq(temuShipOrders.deliveryOrderSn, "FH2610272172644"))
    .limit(1)
  if (!row) {
    console.log("发货单不存在")
    process.exit(0)
  }
  const r = await callTemuApi<Record<string, unknown>>(
    "bg.shiporderv3.logisticsmatch.get",
    {
      deliveryOrderSns: [row.deliveryOrderSn],
      receiveAddressInfo: row.receiveAddressInfo ?? {},
      deliveryAddressId: row.deliveryAddressId ?? 0,
      predictTotalPackageWeight: 3000,
      subWarehouseId: row.subWarehouseId ?? 0,
      totalPackageNum: 1,
      predictVolume: "0.05",
    },
    ctx,
  )
  const list = (r.result as { list?: Record<string, unknown>[] } | null)?.list ?? []
  for (const opt of list.slice(0, 3)) {
    console.log(opt.expressCompanyName, JSON.stringify(opt.channelScheduleTimeList))
  }
  process.exit(0)
}

void main()
