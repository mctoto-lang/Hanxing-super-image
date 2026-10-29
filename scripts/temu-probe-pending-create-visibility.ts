/* 只读探针：刚创建的「待装箱」发货单在官方 shiporderv2.get 的可见性定论。
 * 1) today 窗口（deliverTimeFrom=今日 00:00）翻页找 status=0 行 → 拿用户刚创建单的真实 sn；
 * 2) 对该 sn 按单号（deliveryOrderSnList）回查 → 判断「按单号查不到待装箱单」还是「索引延迟已恢复」。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-pending-create-visibility.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
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

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const from = startOfToday.getTime()

  console.log("== 1) today 窗口查询（deliverTimeFrom=今日0点, sortType=0）==")
  const pendingSns: string[] = []
  for (let pageNo = 1; pageNo <= 5; pageNo++) {
    const r = await callTemuApi<{ total?: number; list?: Record<string, unknown>[] }>(
      "bg.shiporderv2.get",
      { pageNo, pageSize: 50, deliverTimeFrom: from, deliverTimeTo: Date.now(), sortType: 0 },
      ctx,
    )
    const rows = r.result?.list ?? []
    console.log(
      `p${pageNo}: rows=${rows.length} total=${r.result?.total} status0=${rows.filter((x) => x.status === 0).length}`,
    )
    for (const x of rows) {
      if (x.status === 0) {
        pendingSns.push(String(x.deliveryOrderSn))
        console.log(
          `  [status0] ${x.deliveryOrderSn} sub=${x.subPurchaseOrderSn} deliverTime=${x.deliverTime ?? "null"} createTime=${x.deliveryOrderCreateTime ?? "null"} cancelLeft=${x.deliveryOrderCancelLeftTime ?? ""}`,
        )
      }
    }
    if (rows.length < 50) break
    await new Promise((s) => setTimeout(s, 1500))
  }
  if (pendingSns.length === 0) console.log("  （today 窗口无 status=0 行）")

  console.log("== 2) 按单号回查（deliveryOrderSnList，50/批防单页截断误判）==")
  if (pendingSns.length > 0) {
    let got = 0
    for (let i = 0; i < pendingSns.length; i += 50) {
      const batch = pendingSns.slice(i, i + 50)
      const r = await callTemuApi<{ total?: number; list?: Record<string, unknown>[] }>(
        "bg.shiporderv2.get",
        { pageNo: 1, pageSize: 50, deliveryOrderSnList: batch },
        ctx,
      )
      const rows = r.result?.list ?? []
      got += rows.length
      for (const x of rows) {
        console.log(`  ${x.deliveryOrderSn} status=${x.status}`)
      }
      if (i + 50 < pendingSns.length) await new Promise((s) => setTimeout(s, 1500))
    }
    console.log(`bySn 返回 ${got}/${pendingSns.length} 行`)
  }

  console.log("== 3) 无窗口裸查 p1（对照：官方不给窗口时返回什么）==")
  const r3 = await callTemuApi<{ total?: number; list?: Record<string, unknown>[] }>(
    "bg.shiporderv2.get",
    { pageNo: 1, pageSize: 50, sortType: 0 },
    ctx,
  )
  const rows3 = r3.result?.list ?? []
  console.log(`裸查 rows=${rows3.length} total=${r3.result?.total}`)
  const byStatus = new Map<number, number>()
  for (const x of rows3) byStatus.set(Number(x.status), (byStatus.get(Number(x.status)) ?? 0) + 1)
  console.log("  状态分布:", JSON.stringify([...byStatus]))
  for (const x of rows3.slice(0, 8)) {
    console.log(
      `  ${x.deliveryOrderSn} status=${x.status} sub=${x.subPurchaseOrderSn} deliverTime=${x.deliverTime ?? "null"} createTime=${x.deliveryOrderCreateTime ?? "null"} cancelLeft=${JSON.stringify(x.deliveryOrderCancelLeftTime)}`,
    )
  }
  // 裸查里 status=0 的单立即按单号回查（定论 by-sn 对待装箱是否可见）
  const barePending = rows3.filter((x) => x.status === 0).map((x) => String(x.deliveryOrderSn))
  if (barePending.length > 0) {
    const rb = await callTemuApi<{ list?: Record<string, unknown>[] }>(
      "bg.shiporderv2.get",
      { pageNo: 1, pageSize: 50, deliveryOrderSnList: barePending },
      ctx,
    )
    console.log(`bySn 回查待装箱 ${barePending.length} 单 → 返回 ${rb.result?.list?.length ?? 0} 行`)
    for (const x of rb.result?.list ?? []) console.log(`  ${x.deliveryOrderSn} status=${x.status}`)
  }
  process.exit(0)
}

void main()
