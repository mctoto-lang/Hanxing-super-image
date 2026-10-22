/* 一次性：M3/M4 新接口只读冒烟（广告报表/核价/调价/活动/牛皮癣）+ 单店同步验证落库 */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuAdsDailies, temuAdsProductDailies } = await import("../src/db/schema/temu")
  const { getTemuCallContext, syncStore } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")
  const { temuDayStr } = await import("../src/server/services/temu-time")

  const [store] = await db
    .select()
    .from(temuStores)
    .where(eq(temuStores.name, "RoseBlanche"))
    .limit(1)
  if (!store) {
    console.log("[smoke] RoseBlanche 不存在")
    process.exit(0)
  }
  const built = await getTemuCallContext(store)
  if ("error" in built) {
    console.log("[smoke] callContext 失败:", built.error)
    process.exit(0)
  }
  const ctx = built

  const today = temuDayStr()
  const start = temuDayStr(new Date(Date.now() - 2 * 86400_000))
  const startTs = new Date(`${start}T00:00:00+08:00`).getTime()
  const endTs = new Date(`${today}T23:59:59.999+08:00`).getTime()

  // 1) 店铺级广告报表
  try {
    const mall = await callTemuApi<Record<string, unknown>>(
      "bg.glo.searchrec.ad.reports.mall.query",
      { startTs, endTs },
      ctx,
    )
    const info = (mall.result as { reportInfo?: { reportsItemList?: unknown[]; summary?: unknown } }).reportInfo
    const items = info?.reportsItemList ?? []
    console.log(`[smoke] mall.query: 天级行 ${items.length} 条`)
    if (items.length > 0) {
      const first = items[items.length - 1] as Record<string, unknown>
      console.log("[smoke]   末行 adSpend=", JSON.stringify(first.adSpend), "orderPayAmt.ad=", JSON.stringify((first.orderPayAmt as Record<string, { val?: number }>)?.ad))
    }
  } catch (e) {
    console.log("[smoke] mall.query 失败:", e instanceof Error ? e.message.slice(0, 160) : e)
  }

  // 2) 商品级广告报表（不传 productId）
  try {
    const goods = await callTemuApi<Record<string, unknown>>(
      "bg.glo.searchrec.ad.reports.goods.query",
      { startTs, endTs },
      ctx,
    )
    const info = (goods.result as { reportInfo?: { reportsItemList?: Array<Record<string, unknown>> } }).reportInfo
    const items = info?.reportsItemList ?? []
    const withPid = items.filter((i) => i.productId != null)
    console.log(`[smoke] goods.query: 天级行 ${items.length} 条（带 productId ${withPid.length}）`)
    if (withPid.length > 0) {
      console.log("[smoke]   样例行:", JSON.stringify({ productId: withPid[0].productId, ts: withPid[0].ts, adSpend: withPid[0].adSpend }))
    }
  } catch (e) {
    console.log("[smoke] goods.query 失败:", e instanceof Error ? e.message.slice(0, 160) : e)
  }

  // 3) 核价单
  try {
    const r = await callTemuApi<{ total?: number; reviewSamplePriceList?: unknown[] }>(
      "bg.price.review.page.query",
      { pageNo: 1, pageSize: 5 },
      ctx,
    )
    const list = r.result?.reviewSamplePriceList ?? []
    console.log(`[smoke] price.review: total=${r.result?.total} 首页 ${list.length} 条`)
    if (list.length > 0) console.log("[smoke]   首条:", JSON.stringify(list[0]).slice(0, 300))
  } catch (e) {
    console.log("[smoke] price.review 失败:", e instanceof Error ? e.message.slice(0, 160) : e)
  }

  // 4) 调价单（待调价）
  try {
    const r = await callTemuApi<{ total?: number; list?: unknown[] }>(
      "bg.full.adjust.price.page.query",
      { status: 0, pageNo: 1, pageSize: 5 },
      ctx,
    )
    console.log(`[smoke] full.adjust(status=0): total=${r.result?.total} 首页 ${(r.result?.list ?? []).length} 条`)
  } catch (e) {
    console.log("[smoke] full.adjust 失败:", e instanceof Error ? e.message.slice(0, 160) : e)
  }

  // 5) 活动列表
  try {
    const r = await callTemuApi<{ activityList?: Array<Record<string, unknown>> }>(
      "bg.marketing.activity.list.get.global",
      {},
      ctx,
    )
    const list = r.result?.activityList ?? []
    console.log(`[smoke] activity.list: ${list.length} 个活动`, list.slice(0, 3).map((a) => `${a.activityType}:${a.activityName}`).join(" | "))
  } catch (e) {
    console.log("[smoke] activity.list 失败:", e instanceof Error ? e.message.slice(0, 160) : e)
  }

  // 6) 牛皮癣（用库里第一张主图）
  try {
    const { temuProducts } = await import("../src/db/schema/temu")
    const [p] = await db
      .select({ url: temuProducts.mainImageUrl })
      .from(temuProducts)
      .where(eq(temuProducts.storeId, store.id))
      .limit(1)
    if (p?.url) {
      const r = await callTemuApi<{ list?: Array<Record<string, unknown>> }>(
        "bg.compliancepicture.get.global",
        { urlList: [p.url] },
        ctx,
      )
      console.log("[smoke] compliancepicture:", JSON.stringify(r.result?.list?.[0] ?? null))
    } else {
      console.log("[smoke] compliancepicture: 库中无主图可测")
    }
  } catch (e) {
    console.log("[smoke] compliancepicture 失败:", e instanceof Error ? e.message.slice(0, 160) : e)
  }

  // 7) 真实同步一轮，验证 ads 源落库
  const t0 = Date.now()
  const outcome = await syncStore(store.id)
  console.log(`[smoke] 同步完成（${Math.round((Date.now() - t0) / 1000)}s）: ok=`, outcome.status?.ok)
  for (const [source, r] of Object.entries(outcome.status?.sources ?? {})) {
    console.log(`[smoke]   ${source}: ok=${r.ok} count=${r.count ?? 0}${r.error ? " err=" + r.error.slice(0, 120) : ""}`)
  }
  const adsDays = await db.select().from(temuAdsDailies).where(eq(temuAdsDailies.storeId, store.id))
  console.log(`[smoke] temu_ads_daily 现有 ${adsDays.length} 行，近 3 天:`, adsDays.slice(-3).map((r) => `${r.date}:¥${r.adSpend}`).join(" | "))
  const adsProducts = await db.select().from(temuAdsProductDailies).where(eq(temuAdsProductDailies.storeId, store.id))
  console.log(`[smoke] temu_ads_product_daily 现有 ${adsProducts.length} 行`, adsProducts.slice(0, 3).map((r) => `${r.date}/${r.productId}:¥${r.adSpend}`).join(" | "))
  process.exit(0)
}

void main()
