/* 只读探针：shiporderv2.get 分页深度/参数组合对 4000000 的触发边界。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-ship-paging.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  const now = Date.now()
  const from = now - 59 * 86400_000

  const cases: Array<[string, Record<string, unknown>]> = [
    ["p5/size50+sort0（同步源同款）", { pageNo: 5, pageSize: 50, deliverTimeFrom: from, deliverTimeTo: now, sortType: 0 }],
    ["p5/size50 无sort", { pageNo: 5, pageSize: 50, deliverTimeFrom: from, deliverTimeTo: now }],
    ["p5/size20+sort0", { pageNo: 5, pageSize: 20, deliverTimeFrom: from, deliverTimeTo: now, sortType: 0 }],
    ["p3/size50+sort0", { pageNo: 3, pageSize: 50, deliverTimeFrom: from, deliverTimeTo: now, sortType: 0 }],
    ["p1/size50 窗口30天", { pageNo: 1, pageSize: 50, deliverTimeFrom: now - 30 * 86400_000, deliverTimeTo: now, sortType: 0 }],
    ["p5/size50 窗口30天+sort0", { pageNo: 5, pageSize: 50, deliverTimeFrom: now - 30 * 86400_000, deliverTimeTo: now, sortType: 0 }],
    ["p5/size50 无窗口", { pageNo: 5, pageSize: 50 }],
  ]
  for (const [label, params] of cases) {
    try {
      const r = await callTemuApi<{ total?: number; list?: unknown[] }>("bg.shiporderv2.get", params, ctx)
      console.log(`[ok] ${label}: total=${r.result?.total} rows=${r.result?.list?.length ?? 0}`)
    } catch (e) {
      console.log(`[..] ${label} 失败: ${e instanceof Error ? e.message.slice(0, 160) : e}`)
    }
    await sleep(2000)
  }
  process.exit(0)
}

void main()
