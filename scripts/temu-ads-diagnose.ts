/* 一次性：广告数据为空深度诊断——宽窗口/全店推广口径/广告账户存在性/全部店铺（只读） */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const stores = await db.select().from(temuStores)

  /** 北京时间近 N 天窗口（跨度>1 天触发官方天级划分） */
  const win = (days: number) => {
    const day = (offset: number) =>
      new Date(Date.now() - offset * 86400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    return {
      startTs: new Date(`${day(days - 1)}T00:00:00+08:00`).getTime(),
      endTs: new Date(`${day(0)}T23:59:59.999+08:00`).getTime(),
    }
  }

  type ReportInfo = { reportInfo?: { reportsItemList?: unknown[]; summary?: unknown; reportsSummary?: unknown } }
  const brief = (v: unknown) => JSON.stringify(v ?? {}).slice(0, 200)
  /** 广告组实测频控比常规 3qps 紧（连续两调用即 4000004），串行加停顿 */
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (const store of stores) {
    if (!store.accessTokenEncrypted || store.tokenState === "invalid") {
      console.log(`\n===== ${store.name}：无有效 token，跳过 =====`)
      continue
    }
    const built = await getTemuCallContext(store)
    if ("error" in built) {
      console.log(`\n===== ${store.name}: ctx 失败 ${built.error} =====`)
      continue
    }
    console.log(`\n===== ${store.name}（${store.mallType ?? "?"}）=====`)

    for (const [label, params] of [
      ["90天·单品推广", { ...win(90) }],
      ["90天·全店推广", { ...win(90), selectedAdManagedType: 1 }],
    ] as const) {
      try {
        const r = await callTemuApi<Record<string, unknown>>(
          "bg.glo.searchrec.ad.reports.mall.query",
          { ...params },
          built,
        )
        const info = (r.result as ReportInfo)?.reportInfo
        console.log(`[ad] mall ${label}: 行=${info?.reportsItemList?.length ?? 0} summary=${brief(info?.summary ?? info?.reportsSummary)}`)
      } catch (e) {
        console.log(`[ad] mall ${label} 失败: ${e instanceof Error ? e.message.slice(0, 140) : e}`)
      }
      await sleep(1500)
    }

    try {
      const r = await callTemuApi<Record<string, unknown>>(
        "bg.glo.searchrec.ad.reports.goods.query",
        { ...win(90) },
        built,
      )
      const info = (r.result as ReportInfo)?.reportInfo
      console.log(`[ad] goods 90天·单品推广: 行=${info?.reportsItemList?.length ?? 0}`)
    } catch (e) {
      console.log(`[ad] goods 90天 失败: ${e instanceof Error ? e.message.slice(0, 140) : e}`)
    }
    await sleep(1500)

    // detail.query 官方必填 productIdList（docs 坑 11/错误码 230012000）：取该店前 20 个
    // productId 传入；该接口是逐商品投放状态查询（返回并非「广告计划」列表）
    const productIds = (
      await db
        .select({ productId: temuProducts.productId })
        .from(temuProducts)
        .where(eq(temuProducts.storeId, store.id))
        .limit(20)
    )
      .map((r) => r.productId)
      .filter((v): v is string => !!v)
      .map(Number)
      .filter(Number.isFinite)
    if (productIds.length === 0) {
      console.log("[ad] detail.query(投放状态): 跳过（店内无已同步的 productId 可查）")
    } else {
      try {
        const r = await callTemuApi<Record<string, unknown>>(
          "bg.glo.searchrec.ad.detail.query",
          { productIdList: productIds },
          built,
        )
        console.log(`[ad] detail.query(投放状态): ${brief(r.result).slice(0, 260)}`)
      } catch (e) {
        console.log(`[ad] detail.query 失败: ${e instanceof Error ? e.message.slice(0, 140) : e}`)
      }
    }
    await sleep(2000)
  }
  process.exit(0)
}

void main()
