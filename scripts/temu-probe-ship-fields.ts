/* 只读取证：bg.shiporderv2.get 响应完整字段——重点验证「待仓库收货(status=1)」行
 * 是否返回发货单创建时间 / 发货时间（每日发货包裹统计口径）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-ship-fields.ts */
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
    console.log("callContext 失败:", ctx.error)
    process.exit(0)
  }

  const cases: Array<[string, Record<string, unknown>]> = [
    ["真实店 status=1 待仓库收货", { pageNo: 1, pageSize: 2, status: 1 }],
    ["真实店 不限状态首页", { pageNo: 1, pageSize: 2 }],
  ]
  for (const [label, params] of cases) {
    try {
      const r = await callTemuApi<Record<string, unknown>>("bg.shiporderv2.get", params, ctx)
      const result = (r.result ?? {}) as { total?: number; list?: Record<string, unknown>[] }
      const rows = result.list ?? []
      console.log(`\n===== ${label} total=${result.total} rows=${rows.length}`)
      rows.slice(0, 2).forEach((row, i) => {
        console.log(`--- row${i} keys: ${Object.keys(row).join(", ")}`)
        console.log(JSON.stringify(row).slice(0, 2600))
      })
    } catch (e) {
      console.log(`[..] ${label} 失败: ${e instanceof Error ? e.message.slice(0, 300) : e}`)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  process.exit(0)
}

void main()
