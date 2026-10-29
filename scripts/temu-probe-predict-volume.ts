/* 只读探针：bg.predict.volume.get 真实店回参验证（体积自动回填数据源）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-predict-volume.ts */
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

  // 取一张待装箱（status=0）发货单实测
  const pending = await db
    .select({ sn: temuShipOrders.deliveryOrderSn, status: temuShipOrders.status })
    .from(temuShipOrders)
    .where(eq(temuShipOrders.storeId, store.id))
    .limit(20)
  console.log(
    "库内单据:",
    pending.map((p) => `${p.sn}(s${p.status})`).join(", "),
  )
  const target = pending.find((p) => p.status === 0) ?? pending[0]
  if (!target) {
    console.log("无单可探")
    process.exit(0)
  }

  for (const sns of [[target.sn], pending.filter((p) => p.status === 0).map((p) => p.sn)].filter((a) => a.length > 0)) {
    try {
      const r = await callTemuApi<unknown>("bg.predict.volume.get", { deliveryOrderSnList: sns }, ctx)
      console.log(`[ok] sns=${sns.join(",")} → result=`, JSON.stringify(r.result))
    } catch (e) {
      console.log(`[..] sns=${sns.join(",")} 失败: ${e instanceof Error ? e.message.slice(0, 200) : e}`)
    }
  }
  process.exit(0)
}

void main()
