/* 只读探针：predict.volume.get 的返回条件定论 + logisticsmatch 原始 JSON 全字段 dump。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-volume-and-price.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq, inArray, and } = await import("drizzle-orm")
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

  // 样本：当前待装箱(status0) 1 张 + 已发货(status1) 今天 2 张 + 更早的已发货/已取消 各 1 张
  const rows = await db
    .select()
    .from(temuShipOrders)
    .where(eq(temuShipOrders.storeId, store.id))
  const pick = (fn: (r: (typeof rows)[number]) => boolean, n: number) => rows.filter(fn).slice(0, n)
  const samples = [
    ...pick((r) => r.status === 0, 1),
    ...pick((r) => r.status === 1 && (r.deliverTime ?? 0) > Date.now() - 2 * 86400_000, 2),
    ...pick((r) => r.status === 5, 1),
    ...pick((r) => r.status === 1 && (r.deliverTime ?? 0) < Date.now() - 5 * 86400_000, 1),
  ]
  console.log("== 1) predict.volume.get 分单对比 ==")
  for (const r of samples) {
    try {
      const v = await callTemuApi<{ predictVolume?: unknown }>(
        "bg.predict.volume.get",
        { deliveryOrderSnList: [r.deliveryOrderSn] },
        ctx,
      )
      console.log(
        `${r.deliveryOrderSn} status=${r.status} print=${r.isPrintBoxMark} pkgs=${r.deliverPackageNum} skc=${r.skcExtCode} → volume=${JSON.stringify(v.result?.predictVolume ?? null)}`,
      )
    } catch (e) {
      console.log(`${r.deliveryOrderSn} status=${r.status} → 失败: ${e instanceof Error ? e.message.slice(0, 80) : e}`)
    }
    await new Promise((s) => setTimeout(s, 800))
  }
  // 多单合并一次调用（官方支持 1-50）看是否会聚合出体积
  if (samples.length > 1) {
    const v = await callTemuApi<{ predictVolume?: unknown }>(
      "bg.predict.volume.get",
      { deliveryOrderSnList: samples.map((r) => r.deliveryOrderSn) },
      ctx,
    )
    console.log(`合并 ${samples.length} 单一次调用 → volume=${JSON.stringify(v.result?.predictVolume ?? null)}`)
  }

  console.log("== 2) logisticsmatch 原始 JSON（金额键名/usePricePrivileges 全字段）==")
  const pending = samples.find((r) => r.status === 0) ?? samples[0]
  if (pending) {
    const [fresh] = await db
      .select()
      .from(temuShipOrders)
      .where(and(eq(temuShipOrders.storeId, store.id), inArray(temuShipOrders.deliveryOrderSn, [pending.deliveryOrderSn])))
      .limit(1)
    const lm = await callTemuApi<Record<string, unknown>>(
      "bg.shiporderv3.logisticsmatch.get",
      {
        deliveryOrderSns: [fresh.deliveryOrderSn],
        receiveAddressInfo: fresh.receiveAddressInfo ?? {},
        deliveryAddressId: fresh.deliveryAddressId ?? 0,
        predictTotalPackageWeight: 3000,
        subWarehouseId: fresh.subWarehouseId ?? 0,
        totalPackageNum: 1,
        predictVolume: "0.05",
      },
      ctx,
    )
    console.log(JSON.stringify(lm.result, null, 1).slice(0, 4000))
  }
  process.exit(0)
}

void main()
