/* 一次性：单独模拟 ads-reports 源完整序列（detail 分批→逐商品 goods），
 * 验证「全源同步耗尽广告组配额导致 activeIds 空」假设 */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"

async function main() {
  const { and, eq, isNotNull, sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db
    .select()
    .from(temuStores)
    .where(sql`${temuStores.name} = ${storeName}`)
    .limit(1)
  if (!store) {
    console.error(`store not found: ${storeName}`)
    process.exit(1)
  }
  const built = await getTemuCallContext(store)
  const onSale = (
    await db
      .select({ productId: temuProducts.productId })
      .from(temuProducts)
      .where(
        and(
          eq(temuProducts.storeId, store.id),
          isNotNull(temuProducts.productId),
          sql`${temuProducts.skcStatus} in (1, 11)`,
        ),
      )
  )
    .map((r) => Number(r.productId))
    .filter(Number.isFinite)
  console.log("在售:", onSale.length)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const activeIds: number[] = []
  for (let i = 0; i < onSale.length; i += 20) {
    if (i > 0) await sleep(2000)
    const env = await callTemuApi<{ adsDetail?: Array<Record<string, unknown>> }>(
      "bg.glo.searchrec.ad.detail.query",
      { productIdList: onSale.slice(i, i + 20) },
      built,
    )
    const list = env.result?.adsDetail ?? []
    console.log(`detail 批${i / 20 + 1}: ${list.length} 条`)
    for (const d of list) {
      const pid = Number(d.productId ?? d.goodsId)
      if (Number.isFinite(pid)) activeIds.push(pid)
    }
  }
  console.log("在投商品:", activeIds.length)

  let ok = 0
  let fail = 0
  let totalRows = 0
  for (const pid of activeIds.slice(0, 8)) {
    await sleep(2500)
    try {
      const env = await callTemuApi<{ reportInfo?: { reportsItemList?: unknown[] } }>(
        "bg.glo.searchrec.ad.reports.goods.query",
        {
          startTs: new Date(`${new Date(Date.now() - 30 * 86400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}T00:00:00+08:00`).getTime(),
          endTs: new Date(`${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}T23:59:59.999+08:00`).getTime(),
          productId: pid,
        },
        built,
      )
      const rows = env.result?.reportInfo?.reportsItemList ?? []
      totalRows += rows.length
      ok++
      if (rows.length > 0) console.log(`  goods ${pid}: ${rows.length} 行`)
    } catch (e) {
      fail++
      console.log(`  goods ${pid} 失败:`, e instanceof Error ? e.message.slice(0, 90) : e)
    }
  }
  console.log(`goods 前8试拉: 成功=${ok} 失败=${fail} 总行=${totalRows}`)
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
