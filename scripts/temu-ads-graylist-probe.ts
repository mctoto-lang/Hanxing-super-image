/* 一次性：goods.create.query 灰名单语义实证探针——
 * 在售分批 vs 全量分批 vs 小批量，对比返回条目与 type 分布（只读） */
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
  console.log(`store: ${store.name}（${store.mallType ?? "?"}）mallName=${store.mallName ?? "-"}`)

  /** productId 去重 + 在售状态（同商品页口径 skcStatus in (1,11)） */
  const rows = await db
    .select({
      productId: temuProducts.productId,
      sn: temuProducts.productSn,
      name: temuProducts.productName,
      skcStatus: temuProducts.skcStatus,
      removeStatus: temuProducts.removeStatus,
      lastSeenAt: temuProducts.lastSeenAt,
    })
    .from(temuProducts)
    .where(and(eq(temuProducts.storeId, store.id), isNotNull(temuProducts.productId)))
    .orderBy(sql`${temuProducts.lastSeenAt} desc`)
  const seen = new Set<string>()
  const uniq: typeof rows = []
  for (const r of rows) {
    if (!r.productId || seen.has(r.productId)) continue
    seen.add(r.productId)
    uniq.push(r)
  }
  const onSale = uniq.filter((r) => r.skcStatus === 1 || r.skcStatus === 11)
  const offSale = uniq.filter((r) => r.skcStatus !== 1 && r.skcStatus !== 11)
  console.log(
    `productId 去重合计=${uniq.length}，在售(1/11)=${onSale.length}，非在售=${offSale.length}（skcStatus 分布：${JSON.stringify(
      uniq.reduce<Record<string, number>>((m, r) => {
        const k = String(r.skcStatus ?? "null")
        m[k] = (m[k] ?? 0) + 1
        return m
      }, {}),
    )}）`,
  )

  const built = await getTemuCallContext(store)
  if ("error" in built) {
    console.log("ctx 失败:", built.error)
    return
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  type GoodsInfoItem = { productId?: unknown; goodsId?: unknown; grayReason?: Array<{ type?: unknown; reason?: unknown }> }
  const probe = async (label: string, ids: string[]) => {
    try {
      const env = await callTemuApi<{ goodsInfoList?: GoodsInfoItem[] }>(
        "bg.glo.searchrec.ad.goods.create.query",
        { productIdList: ids.map(Number).filter(Number.isFinite) },
        built,
      )
      const list = env.result?.goodsInfoList ?? []
      const typeDist: Record<string, number> = {}
      for (const it of list) {
        for (const g of it.grayReason ?? []) {
          const k = String(g.type ?? "?")
          typeDist[k] = (typeDist[k] ?? 0) + 1
        }
      }
      console.log(
        `[${label}] 传入=${ids.length} 返回=${list.length} grayReason.type 分布=${JSON.stringify(typeDist)}`,
      )
      for (const it of list.slice(0, 8)) {
        const pid = it.productId ?? it.goodsId
        const local = uniq.find((r) => r.productId === String(pid))
        console.log(
          `  - pid=${pid} sn=${local?.sn ?? "?"} 在售=${local ? local.skcStatus === 1 || local.skcStatus === 11 : "?"} reasons=${JSON.stringify(it.grayReason ?? []).slice(0, 160)}`,
        )
      }
    } catch (e) {
      console.log(`[${label}] 失败:`, e instanceof Error ? e.message.slice(0, 180) : e)
    }
    await sleep(1600)
  }

  // ① 官方 required:false——不传 productIdList，看是否返回全店名单
  try {
    const env = await callTemuApi<{ goodsInfoList?: GoodsInfoItem[] }>(
      "bg.glo.searchrec.ad.goods.create.query",
      {},
      built,
    )
    const list = env.result?.goodsInfoList ?? []
    console.log(`[不传参] 返回=${list.length}`)
    for (const it of list.slice(0, 10)) {
      const pid = it.productId ?? it.goodsId
      const local = uniq.find((r) => r.productId === String(pid))
      console.log(
        `  - pid=${pid} sn=${local?.sn ?? "?"} skcStatus=${local?.skcStatus ?? "?"} reasons=${JSON.stringify(it.grayReason ?? []).slice(0, 160)}`,
      )
    }
  } catch (e) {
    console.log("[不传参] 失败:", e instanceof Error ? e.message.slice(0, 180) : e)
  }
  await sleep(1600)

  // ② detail.query 对全部在售分批（79 个，批 20）：识别「已在广告中」的商品
  type AdsDetailItem = {
    productId?: unknown
    goodsId?: unknown
    adShowStatus?: unknown
    adPhase?: unknown
    budget?: unknown
    roas?: unknown
  }
  const onSaleIds = onSale.map((r) => Number(r.productId)).filter(Number.isFinite)
  const detailBy = new Map<string, AdsDetailItem>()
  try {
    for (let i = 0; i < onSaleIds.length; i += 20) {
      if (i > 0) await sleep(1600)
      const env = await callTemuApi<{ adsDetail?: AdsDetailItem[] }>(
        "bg.glo.searchrec.ad.detail.query",
        { productIdList: onSaleIds.slice(i, i + 20) },
        built,
      )
      for (const d of env.result?.adsDetail ?? []) {
        const pid = String(d.productId ?? d.goodsId ?? "")
        if (pid) detailBy.set(pid, d)
      }
    }
    const statusDist: Record<string, number> = {}
    for (const d of detailBy.values()) {
      const k = String(d.adShowStatus ?? "null")
      statusDist[k] = (statusDist[k] ?? 0) + 1
    }
    console.log(
      `[detail.query 在售${onSaleIds.length}个] 返回条目=${detailBy.size} adShowStatus 分布=${JSON.stringify(statusDist)}`,
    )
    let n = 0
    for (const [pid, d] of detailBy) {
      if (n++ >= 12) break
      const local = onSale.find((r) => r.productId === pid)
      console.log(
        `  - pid=${pid} sn=${local?.sn ?? "?"} status=${d.adShowStatus} phase=${d.adPhase} budget=${d.budget} roas=${d.roas}`,
      )
    }
  } catch (e) {
    console.log("[detail.query] 失败:", e instanceof Error ? e.message.slice(0, 180) : e)
  }
  await sleep(1600)

  // ③ 近 7 天商品报表：官方后台手建广告的商品（本地注册表之外的在投商品）
  try {
    const day = (offset: number) =>
      new Date(Date.now() - offset * 86400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
    const env = await callTemuApi<{
      reportInfo?: { reportsItemList?: Array<{ productId?: unknown; ts?: unknown }> ; summary?: unknown }
    }>(
      "bg.glo.searchrec.ad.reports.goods.query",
      {
        startTs: new Date(`${day(6)}T00:00:00+08:00`).getTime(),
        endTs: new Date(`${day(0)}T23:59:59.999+08:00`).getTime(),
      },
      built,
    )
    const items = env.result?.reportInfo?.reportsItemList ?? []
    const pids = [...new Set(items.map((x) => String(x.productId ?? "")).filter(Boolean))]
    console.log(`[reports.goods 近7天] 天级行=${items.length} 去重 productId=${pids.length}`)
    for (const pid of pids.slice(0, 10)) {
      const local = onSale.find((r) => r.productId === pid)
      console.log(`  - pid=${pid} sn=${local?.sn ?? "?"} skcStatus=${local?.skcStatus ?? "?"}`)
    }
  } catch (e) {
    console.log("[reports.goods] 失败:", e instanceof Error ? e.message.slice(0, 180) : e)
  }

  // ④ 回归：传参场景再验一次（在售前 20 + 混入非在售 5）
  await probe("在售前20", onSale.slice(0, 20).map((r) => r.productId!))
  await probe("在售5+非在售5", [
    ...onSale.slice(0, 5).map((r) => r.productId!),
    ...offSale.slice(0, 5).map((r) => r.productId!),
  ])
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
