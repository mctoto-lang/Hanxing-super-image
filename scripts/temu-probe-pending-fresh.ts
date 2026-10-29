/* 只读探针：本地 status=0（待装箱）发货单 → 官方实时状态核对（差异=同步滞后/超时移除）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-pending-fresh.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { and, eq } = await import("drizzle-orm")
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

  const pending = await db
    .select({ sn: temuShipOrders.deliveryOrderSn, status: temuShipOrders.status, sub: temuShipOrders.subPurchaseOrderSn })
    .from(temuShipOrders)
    .where(and(eq(temuShipOrders.storeId, store.id), eq(temuShipOrders.status, 0)))
  console.log("本地待装箱单:", pending.map((p) => p.sn).join(", ") || "（无）")
  if (pending.length === 0) process.exit(0)

  // 按单号回查须分批（50/批 + 1.5s 限速）：单页 pageSize 50 截断会把第 51+ 张误判为「官方已不存在」
  const official: Array<Record<string, unknown>> = []
  for (let i = 0; i < pending.length; i += 50) {
    const batch = pending.slice(i, i + 50).map((p) => p.sn)
    const r = await callTemuApi<{ total?: number; list?: Array<Record<string, unknown>> }>(
      "bg.shiporderv2.get",
      { pageNo: 1, pageSize: 50, deliveryOrderSnList: batch },
      ctx,
    )
    official.push(...(r.result?.list ?? []))
    if (i + 50 < pending.length) await new Promise((s) => setTimeout(s, 1500))
  }
  console.log("官方返回:", official.length, "张")
  const STATUS_LABEL = ["待装箱", "待仓库收货", "已收货", "已入库", "已退货", "已取消", "部分收货"]
  const bySn = new Map(official.map((o) => [String(o.deliveryOrderSn), o]))
  for (const p of pending) {
    const o = bySn.get(p.sn)
    if (!o) {
      console.log(`[缺失] ${p.sn} 官方已不存在（超时移除/删除）`)
    } else {
      console.log(
        `[差异] ${p.sn} 本地=0(待装箱) 官方=status${o.status}(${STATUS_LABEL[Number(o.status)] ?? "?"}) deliverTime=${o.deliverTime ?? "无"} expressBatchSn=${o.expressBatchSn ?? "无"}`,
      )
    }
  }
  process.exit(0)
}

void main()
