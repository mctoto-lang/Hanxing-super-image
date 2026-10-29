/* 一次性补种：把官方侧存在、本地缺失的待装箱发货单按单号回查落库。
 * （create 时官方索引延迟导致回查落空 + 同步窗口结构性漏待装箱单）
 * 运行：cmd //c pnpm tsx scripts/temu-backfill-pending-orders.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq, notInArray } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuShipOrders } = await import("../src/db/schema/temu")
  const { getTemuCallContext, upsertShipOrderRows } = await import("../src/server/services/temu-sync")
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

  // 裸查 p1 拿最新单（含待装箱），筛出本地缺失的单号按单号回查落库
  const bare = await callTemuApi<{ list?: Record<string, unknown>[] }>(
    "bg.shiporderv2.get",
    { pageNo: 1, pageSize: 50, sortType: 0 },
    ctx,
  )
  const rows = bare.result?.list ?? []
  const sns = rows.map((x) => String(x.deliveryOrderSn)).filter(Boolean)
  const known = sns.length
    ? await db
        .select({ sn: temuShipOrders.deliveryOrderSn })
        .from(temuShipOrders)
        .where(eq(temuShipOrders.storeId, store.id))
    : []
  const knownSet = new Set(known.map((k) => k.sn))
  const missing = sns.filter((sn) => !knownSet.has(sn))
  console.log(`裸查 ${sns.length} 单，本地缺失 ${missing.length}：${missing.join("、") || "无"}`)
  if (missing.length > 0) {
    const r = await callTemuApi<{ list?: Record<string, unknown>[] }>(
      "bg.shiporderv2.get",
      { pageNo: 1, pageSize: 50, deliveryOrderSnList: missing },
      ctx,
    )
    const got = r.result?.list ?? []
    const n = await upsertShipOrderRows(store.id, new Date(), got)
    console.log(`按单号回查 ${got.length} 行，落库 ${n} 行`)
    for (const x of got) console.log(`  ${x.deliveryOrderSn} status=${x.status} sub=${x.subPurchaseOrderSn}`)
  }
  // 顺带确认本地 status=0 现存
  const pending = await db
    .select({ sn: temuShipOrders.deliveryOrderSn, status: temuShipOrders.status })
    .from(temuShipOrders)
    .where(eq(temuShipOrders.storeId, store.id))
  console.log("本地待装箱：", pending.filter((p) => p.status === 0).map((p) => p.sn).join("、") || "无")
  void notInArray
  process.exit(0)
}

void main()
