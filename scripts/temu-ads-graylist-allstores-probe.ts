/* 一次性：全部真店 goods.create.query 交叉验证（在售前 50 + 不传参，只读） */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { and, eq, isNotNull, sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const stores = await db
    .select()
    .from(temuStores)
    .where(eq(temuStores.tokenState, "active"))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (const store of stores) {
    if (!store.accessTokenEncrypted) continue
    const built = await getTemuCallContext(store)
    if ("error" in built) {
      console.log(`\n===== ${store.name}: ctx 失败 ${built.error}`)
      continue
    }
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
    console.log(`\n===== ${store.name}（在售 ${onSale.length}）=====`)
    for (const [label, params] of [
      ["在售前50", { productIdList: onSale.slice(0, 50) }],
      ["不传参", {}],
    ] as const) {
      try {
        const env = await callTemuApi<{ goodsInfoList?: Array<Record<string, unknown>> }>(
          "bg.glo.searchrec.ad.goods.create.query",
          params,
          built,
        )
        const list = env.result?.goodsInfoList ?? []
        const typeDist: Record<string, number> = {}
        for (const it of list) {
          for (const g of (it.grayReason as Array<{ type?: unknown }>) ?? []) {
            const k = String(g.type ?? "?")
            typeDist[k] = (typeDist[k] ?? 0) + 1
          }
        }
        console.log(`[${label}] 返回=${list.length} type分布=${JSON.stringify(typeDist)}`)
        if (list.length > 0) {
          console.log("  首条:", JSON.stringify(list[0]).slice(0, 220))
        }
      } catch (e) {
        console.log(`[${label}] 失败:`, e instanceof Error ? e.message.slice(0, 160) : e)
      }
      await sleep(1700)
    }
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
