import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/db/client"
import {
  temuStores,
  temuMetricSnapshots,
  temuSalesOverviews,
  temuProducts,
  temuProductFlows,
  temuProductAds,
  temuActivities,
  temuIngestLogs,
  type TemuMallMeta,
} from "@/db/schema"
// 新表直接从模块文件导入：turbopack 对 * barrel 的陈旧缓存会解析为 undefined
import { temuDiscoveredMalls, temuAdsDailies, temuSkuSalesDailies, temuSkuMaps } from "@/db/schema/temu"
import { ingestItemSchema, ingestBodySchema } from "@/server/schemas/temu"

export const dynamic = "force-dynamic"

/**
 * Temu Collector 插件批量上报端点（机器对机器，无登录态）
 *
 * - 鉴权：X-Device-Token = temu_store.deviceToken（随机 192-bit，数据库
 *   等值索引查询比对——高熵 token 下索引等值比较无时序侧信道可利用）；
 *   命中且 enabled 时更新 lastSeenAt，body.storeId 不一致时以 token 归属为准。
 * - 分表路由（手册 §4 temu 域）：
 *   dashboard-stats / soldout-overview / fulfilment-stats → temu_metric_snapshot
 *   sales-overview        → temu_sales_overview（SKC 快照）
 *   products-list / newon-lifecycle → temu_product（按 store+skc upsert 合并两源）
 *   flux-analysis-goods / flow-grow-home → temu_product_flow
 *   activity-data         → temu_activity（宽前缀整包）
 *   其余 source（orders-list / delivery-batch / export-file…）→ 仅 temu_ingest_log
 *   审计留痕（v1 未建表，不丢弃）。
 * - 幂等：各快照表按 (storeId, source, contentHash) 唯一索引防重发；
 *   contentHash 对 normalized 稳定序列化取 sha256 前 40 位。
 * - CORS：插件 Service Worker 携 host_permissions 不受同源限制，此处 OPTIONS
 *   与放行头仅为本地联调（curl/浏览器控制台）兜底。
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Token",
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

/** 稳定序列化（键排序）+ sha256 前 40 位 */
function contentHashOf(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, stable(val)]),
      )
    }
    return v
  }
  return createHash("sha256")
    .update(JSON.stringify(stable(value)) ?? "")
    .digest("hex")
    .slice(0, 40)
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null
/** 申报价：接口返回带货币符号的字符串（"¥8.26"）→ 分；数字按分透传 */
const priceCents = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v)
  if (typeof v !== "string") return null
  const m = v.replace(/,/g, "").match(/\d+(?:\.\d+)?/)
  if (!m) return null
  const x = parseFloat(m[0])
  return Number.isFinite(x) ? Math.round(x * 100) : null
}
const ratio = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const str = (v: unknown, max = 300): string | null => {
  // 接口的 id 类字段常以 JSON 数字返回（goodsId/productId 15-16 位，均在安全整数
  // 范围），只认字符串会把它们全部丢成 null——商品表 goods_id 全空即由此而来
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v)).slice(0, max)
  if (typeof v !== "string" || !v) return null
  return v.slice(0, max)
}

/** 上新生命周期 selectStatus 码 → 文案（2026-09-11 卖家中心实地核对；未收录码保留数字语义） */
const LIFECYCLE_STATUS_TEXT: Record<string, string> = {
  "7": "价格申报中",
  "9": "价格已作废",
  "11": "已创建首单",
  "12": "已发布到站点",
}
const lifecycleStatusOf = (v: unknown): string | null => {
  if (v == null) return null
  const key = String(v)
  return LIFECYCLE_STATUS_TEXT[key] ?? (typeof v === "number" ? `状态码${v}` : str(v, 64))
}

/** 站点数组（addedSiteList，可达 90+）拼接截断；完整清单在 raw/lifecycleDetail */
const siteNamesOf = (v: unknown): string | null => {
  if (!Array.isArray(v) || v.length === 0) return null
  const joined = v.filter((x): x is string => typeof x === "string").join(",")
  if (!joined) return null
  return joined.length > 60 ? joined.slice(0, 57) + `…等${v.length}站` : joined
}

export async function POST(request: Request) {
  try {
    return await handleIngest(request)
  } catch (e) {
    console.error("[temu-ingest] POST failed:", e)
    return NextResponse.json(
      { ok: false, error: String(e && (e as Error).message || e).slice(0, 300) },
      { status: 500, headers: CORS_HEADERS },
    )
  }
}

async function handleIngest(request: Request) {
  const token = request.headers.get("x-device-token") ?? ""
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 401, headers: CORS_HEADERS })
  }

  const [store] = await db.select().from(temuStores).where(eq(temuStores.deviceToken, token)).limit(1)
  if (!store) {
    return NextResponse.json({ ok: false, error: "bad token" }, { status: 401, headers: CORS_HEADERS })
  }
  if (!store.enabled) {
    return NextResponse.json({ ok: false, error: "store disabled" }, { status: 403, headers: CORS_HEADERS })
  }

  let rawBody: string
  try {
    rawBody = await request.text()
    // raw 原始响应体积大（delivery 单条 500KB+），上报端已截断至 512KB/条；
    // 此处不再重复截断，仅拒绝异常超大请求（> 24MB）
    if (rawBody.length > 24 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: "body too large" }, { status: 413, headers: CORS_HEADERS })
    }
  } catch {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400, headers: CORS_HEADERS })
  }

  let body: ReturnType<typeof ingestBodySchema.parse>
  try {
    body = ingestBodySchema.parse(JSON.parse(rawBody))
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "bad payload", detail: String(e).slice(0, 200) },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  // 按店铺分组统计 + 更新在线状态（一次往返）
  const bySource = new Map<string, { count: number; accepted: number }>()
  let accepted = 0

  // 插件发现的 mall：数据内嵌 supplierId 自动登记（面板「插件发现的店铺」待确认）
  const discovered = new Map<string, string>()

  for (const item of body.items) {
    const stat = bySource.get(item.source) ?? { count: 0, accepted: 0 }
    stat.count += 1
    try {
      const handled = await handleItem(store.id, item)
      if (handled) {
        stat.accepted += 1
        accepted += 1
      }
    } catch (e) {
      // 单条失败不中断整批；错误计入日志
      console.error("[temu-ingest] item failed:", item.source, String(e).slice(0, 200))
    }
    const mm = (item.mallMeta ?? null) as TemuMallMeta | null
    if (mm && Array.isArray(mm.supplierIds)) {
      for (let i = 0; i < mm.supplierIds.length; i++) {
        const mid = String(mm.supplierIds[i]).slice(0, 32)
        if (mid && !discovered.has(mid)) {
          discovered.set(mid, String(mm.mallNames?.[i] ?? "").slice(0, 100) || "")
        }
      }
    }
    // 指纹条目（插件登录/切店实时上报）：normalized.malls 携带账号完整 mallList——
    // mallMeta 有 20 条 schema 上限，超过 20 家店铺的账号靠这里全量登记
    if (item.source === "fingerprint") {
      const malls = (item.normalized as { malls?: unknown } | null | undefined)?.malls
      if (Array.isArray(malls)) {
        for (const m of malls) {
          const mid = String((m as { mallId?: unknown })?.mallId ?? "").slice(0, 32)
          const name = String((m as { mallName?: unknown })?.mallName ?? "").slice(0, 100)
          if (mid && (!discovered.has(mid) || (!discovered.get(mid) && name))) {
            discovered.set(mid, name || "")
          }
        }
      }
    }
    bySource.set(item.source, stat)
  }

  const discoveryUpserts = [...discovered.entries()].map(([mallId, mallName]) =>
    db
      .insert(temuDiscoveredMalls)
      .values({ enterpriseId: store.enterpriseId, mallId, mallName: mallName || null })
      .onConflictDoUpdate({
        target: [temuDiscoveredMalls.enterpriseId, temuDiscoveredMalls.mallId],
        set: { lastSeenAt: sql`now()`, mallName: sql`excluded.mall_name` },
      })
      .catch((e) => {
        console.error("[temu-ingest] discovered upsert failed:", String(e).slice(0, 300))
        return null
      }),
  )

  await Promise.all([
    db.update(temuStores).set({ lastSeenAt: sql`now()` }).where(eq(temuStores.id, store.id)),
    ...discoveryUpserts,
    ...[...bySource.entries()].map(([source, s]) =>
      db.insert(temuIngestLogs).values({
        storeId: store.id,
        source,
        itemCount: s.count,
        acceptedCount: s.accepted,
        detail: { storeIdFromClient: body.storeId ?? null },
      }),
    ),
  ])

  return NextResponse.json({ ok: true, accepted, total: body.items.length }, { headers: CORS_HEADERS })
}

type IngestItem = ReturnType<typeof ingestItemSchema.parse>

async function handleItem(storeId: string, item: IngestItem): Promise<boolean> {
  const n = (item.normalized ?? {}) as Record<string, unknown>
  const mallMeta = (item.mallMeta ?? null) as TemuMallMeta | null
  const capturedAt = new Date(item.capturedAt)

  switch (item.source) {
    case "dashboard-stats":
    case "soldout-overview":
    case "fulfilment-stats":
    case "flux-analysis-summary":
    case "ads-report-summary": {
      const hash = contentHashOf(n)
      // returning 仅返回实际插入的行（onConflictDoNothing 跳过的不返回），
      // 据此区分「新数据入库」与「重发去重」，accepted 统计不虚高
      const inserted = await db
        .insert(temuMetricSnapshots)
        .values({
          storeId,
          source: item.source,
          capturedAt,
          saleVolume: num(n.saleVolume),
          sevenDaysSaleVolume: num(n.sevenDaysSaleVolume),
          thirtyDaysSaleVolume: num(n.thirtyDaysSaleVolume),
          onSaleProductNumber: num(n.onSaleProductNumber),
          waitProductNumber: num(n.waitProductNumber),
          lackSkcNumber: num(n.lackSkcNumber),
          aboutToSellOutNumber: num(n.aboutToSellOutNumber),
          alreadySoldOutNumber: num(n.alreadySoldOutNumber),
          adjustPrice: num(n.adjustPrice),
          reviewAdjustPrice: num(n.reviewAdjustPrice),
          highPriceLimitNumber: num(n.highPriceLimitNumber),
          advicePrepareSkcNumber: num(n.advicePrepareSkcNumber),
          todaySellOutNum: num(n.todaySellOutNum),
          todaySellOutRatio: ratio(n.todaySellOutRatio),
          todaySoonSellOutNum: num(n.todaySoonSellOutNum),
          todaySoonSellOutRatio: ratio(n.todaySoonSellOutRatio),
          todaySellOutLossNum: num(n.todaySellOutLossNum),
          increaseSellOutNum: num(n.increaseSellOutNum),
          increaseSoonSellOutNum: num(n.increaseSoonSellOutNum),
          metrics: n,
          mallMeta,
          contentHash: hash,
        })
        .onConflictDoNothing()
        .returning({ id: temuMetricSnapshots.id })
      return inserted.length > 0
    }

    case "sales-overview": {
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      const hash = contentHashOf(n.items)
      const inserted = await db
        .insert(temuSalesOverviews)
        .values(
          items.slice(0, 200).map((it) => ({
            storeId,
            skcId: String(it.skcId ?? "").slice(0, 32),
            capturedAt,
            productName: str(it.productName, 500),
            category: str(it.category, 120),
            supplierId: str(it.supplierId, 32),
            productSn: str(it.productSn, 64),
            todaySalesVolume: num(it.todaySalesVolume),
            last7DaysSalesVolume: num(it.last7DaysSalesVolume),
            last30DaysSalesVolume: num(it.last30DaysSalesVolume),
            warehouseAvailableStock: num(it.warehouseAvailableStock),
            shippedStock: num(it.shippedStock),
            // 可售天数：可售天数（页面同名列）优先，仓内可售天数兜底（部分行前者为 null）
            availableSaleDays: ratio(it.availableSaleDays) ?? ratio(it.warehouseAvailableSaleDays),
            priceDetail: null,
            overview: n,
            mallMeta,
            contentHash: hash,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: temuSalesOverviews.id })
      // 商品标识聚合：销售管理页每日看遍全部在售 SKC，是 skcId↔goodsId↔货号 映射最全的
      // 来源——回填标识枢纽表 temu_product（只补空不覆盖，products-list 等源的详情优先），
      // 供 goods-only 数据源（流量/广告）反查 SKC；
      // 行内 SKU 明细（skuIds）同时落 SKU↔SKC 映射表，供 SKU 日销量序列按 SKC 聚合
      for (const it of items.slice(0, 200)) {
        const skcId = String(it.skcId ?? "").slice(0, 32)
        if (!skcId) continue
        const goodsId = str(it.goodsId, 32)
        const productSn = str(it.productSn, 64)
        if (!goodsId && !productSn && !it.productName) continue
        await db
          .insert(temuProducts)
          .values({
            storeId,
            productSkcId: skcId,
            goodsId,
            productName: str(it.productName, 500),
            productSn,
            mallMeta,
          })
          .onConflictDoUpdate({
            target: [temuProducts.storeId, temuProducts.productSkcId],
            set: {
              goodsId: sql`coalesce(${temuProducts.goodsId}, excluded.goods_id)`,
              productName: sql`coalesce(${temuProducts.productName}, excluded.product_name)`,
              productSn: sql`coalesce(${temuProducts.productSn}, excluded.product_sn)`,
              lastSeenAt: sql`now()`,
            },
          })
        // SKU↔SKC 映射（skuQuantityDetailList.productSkuId，与趋势接口 prodSkuId 同空间）
        const skuIds = Array.isArray(it.skuIds)
          ? it.skuIds.map((v) => str(v, 32)).filter((v): v is string => !!v)
          : []
        if (skuIds.length > 0) {
          await db
            .insert(temuSkuMaps)
            .values(skuIds.slice(0, 50).map((skuId) => ({ storeId, skuId, skcId })))
            .onConflictDoNothing()
        }
      }
      return inserted.length > 0
    }

    case "sales-sku-trend": {
      // SKU 日销量序列（销售管理"销售趋势"直采）：逐日条目按 (store, sku, date) 幂等 upsert
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      const values = items
        .slice(0, 2000)
        .map((it) => {
          const skuId = str(it.skuId, 32)
          const day = str(it.date, 10)
          return { storeId, skuId, date: day, salesNumber: num(it.salesNumber) ?? 0 }
        })
        .filter(
          (v): v is { storeId: string; skuId: string; date: string; salesNumber: number } =>
            !!v.skuId && !!v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date),
        )
      if (values.length === 0) return false
      await db
        .insert(temuSkuSalesDailies)
        .values(values)
        .onConflictDoUpdate({
          target: [temuSkuSalesDailies.storeId, temuSkuSalesDailies.skuId, temuSkuSalesDailies.date],
          set: { salesNumber: sql`excluded.sales_number`, receivedAt: sql`now()` },
        })
      return true
    }

    case "products-list":
    case "newon-lifecycle": {
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      // 两源字段空间不同：冲突更新只写本源提供的字段。此前全字段覆盖会把
      // 另一源先采集的字段整体置 null（在售状态 skcStatus 被生命周期上报抹掉、
      // 生命周期状态被商品列表上报抹掉），商品信息页字段大面积丢失即由此而来
      const identity = (it: Record<string, unknown>) => ({
        productId: str(it.productId, 32),
        goodsId: str(it.goodsId, 32),
        productName: str(it.productName, 500),
        productSn: str(it.productSn, 64),
        removeStatus: num(it.removeStatus),
        mainImageUrl: str(it.mainImageUrl, 1000),
      })
      // products-list 独有：类目 / 在售状态 / 销量
      const productsSet = (it: Record<string, unknown>) => ({
        category: str(it.category, 120),
        cat1Name: str(it.cat1Name, 120),
        skcStatus: num(it.skcStatus),
        totalSalesVolume: num(it.totalSalesVolume),
        last7DaysSalesVolume: num(it.last7DaysSalesVolume),
      })
      // newon-lifecycle 独有：申报价 / 生命周期状态 / 站点 / 买手 / 时间线
      const lifecycleSet = (it: Record<string, unknown>, raw: unknown) => ({
        supplierId: str(it.supplierId, 32),
        supplierPrice: priceCents(it.supplierPrice),
        leafCategoryName: str(it.leafCategoryName, 120),
        flowGrowStatus: num(it.flowGrowStatus),
        hasSkcSelected: it.hasSkcSelected === true,
        buyerName: str(it.buyerName, 100),
        lifecycleStatus: lifecycleStatusOf(it.lifecycleStatus),
        siteCode: str(it.siteCode, 32),
        siteName: siteNamesOf(it.siteNames),
        skcCreatedAt: num(it.skcCreatedTime),
        priceVerifiedAt: num(it.priceVerificationTime),
        firstPurchaseAt: num(it.firstPurchaseTime),
        addedSiteAt: num(it.addedToSiteTime),
        lifecycleDetail: raw ?? null,
      })
      for (const it of items.slice(0, 100)) {
        const skcId = String(it.productSkcId ?? "").slice(0, 32)
        if (!skcId) continue
        const base = identity(it)
        const set =
          item.source === "products-list"
            ? { ...base, ...productsSet(it), mallMeta, lastSeenAt: sql`now()` }
            : { ...base, ...lifecycleSet(it, item.raw), mallMeta, lastSeenAt: sql`now()` }
        await db
          .insert(temuProducts)
          .values({
            storeId,
            productSkcId: skcId,
            ...base,
            category: str(it.category, 120),
            leafCategoryName: str(it.leafCategoryName, 120),
            cat1Name: str(it.cat1Name, 120),
            supplierId: str(it.supplierId, 32),
            supplierPrice: priceCents(it.supplierPrice),
            flowGrowStatus: num(it.flowGrowStatus),
            hasSkcSelected: it.hasSkcSelected === true,
            skcStatus: num(it.skcStatus),
            totalSalesVolume: num(it.totalSalesVolume),
            last7DaysSalesVolume: num(it.last7DaysSalesVolume),
            buyerName: str(it.buyerName, 100),
            lifecycleStatus: lifecycleStatusOf(it.lifecycleStatus),
            siteCode: str(it.siteCode, 32),
            siteName: siteNamesOf(it.siteNames),
            skcCreatedAt: num(it.skcCreatedTime),
            priceVerifiedAt: num(it.priceVerificationTime),
            firstPurchaseAt: num(it.firstPurchaseTime),
            addedSiteAt: num(it.addedToSiteTime),
            lifecycleDetail: item.raw ?? null,
            mallMeta,
          })
          .onConflictDoUpdate({
            target: [temuProducts.storeId, temuProducts.productSkcId],
            set,
          })
      }
      return true
    }

    case "flux-analysis-goods":
    case "flow-grow-home": {
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      const hash = contentHashOf(n.items)
      const inserted = await db
        .insert(temuProductFlows)
        .values(
          items.slice(0, 200).map((it) => ({
            storeId,
            goodsId: String(it.goodsId ?? it.skcId ?? "").slice(0, 32),
            goodsName: str(it.goodsName ?? it.productName, 500),
            category: str(it.category, 120),
            goodsImageUrl: str(it.goodsImageUrl, 1000),
            productSpuId: str(it.productSpuId, 32),
            source: item.source,
            capturedAt,
            exposeNum: num(it.exposeNum),
            clickNum: num(it.clickNum),
            payGoodsNum: num(it.payGoodsNum),
            payOrderNum: num(it.payOrderNum),
            buyerNum: num(it.buyerNum),
            addToCartUserNum: num(it.addToCartUserNum),
            goodsDetailVisitNum: num(it.goodsDetailVisitNum),
            goodsDetailVisitorNum: num(it.goodsDetailVisitorNum),
            searchExposeNum: num(it.searchExposeNum),
            searchClickNum: num(it.searchClickNum),
            recommendExposeNum: num(it.recommendExposeNum),
            recommendClickNum: num(it.recommendClickNum),
            metrics: it,
            mallMeta,
            contentHash: hash,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: temuProductFlows.id })
      return inserted.length > 0
    }

    case "ads-product-report": {
      // 商品推广（ads.temu.com 商品级报表）：逐条内容哈希去重，快照式累积
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      const values = items
        .slice(0, 200)
        .map((it) => ({
          storeId,
          goodsId: str(it.goodsId, 32),
          skcId: str(it.skcId, 32),
          productSn: str(it.productSn, 64),
          productName: str(it.productName, 500),
          capturedAt,
          spend: ratio(it.spend),
          impressions: num(it.impressions),
          clicks: num(it.clicks),
          orders: num(it.orders),
          gmv: ratio(it.gmv),
          netOrderPayAmt: ratio(it.netOrderPayAmt),
          roasVal: num(it.roasVal),
          netTransactionCost: ratio(it.netTransactionCost),
          netGoodsNum: num(it.netGoodsNum),
          metrics: it,
          mallMeta,
          contentHash: contentHashOf(it),
        }))
        .filter((v) => v.goodsId || v.skcId)
      if (values.length === 0) return false
      const inserted = await db
        .insert(temuProductAds)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: temuProductAds.id })
      return inserted.length > 0
    }

    case "ads-store-report": {
      // 推广店铺级日报（queryReports 序列）：按日分组求和后 upsert（同日重发覆盖更新，
      // 天然幂等）。行粒度随查询范围变化——单日/当日查询返回按小时行（实测 ts 逐小时
      // 递增、每行 ad_spend 为该小时花费），多日查询返回按日行；逐行 upsert 会"最后一行
      // 覆盖"，日汇总只剩最后一个小时的值，必须先按日聚合。
      // 金额原始单位分，落库统一为元
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      const cents = (v: unknown): number => {
        const x = num(v)
        return x == null ? 0 : x / 100
      }
      const numOrNull = (v: unknown): number | null => {
        const x = num(v)
        return x == null ? null : x
      }
      // 日期（服务器本地时区 YYYY-MM-DD）→ 求和器
      const byDay = new Map<
        string,
        { adSpend: number; impressions: number | null; clicks: number | null; orders: number | null; gmv: number | null }
      >()
      for (const it of items.slice(0, 500)) {
        const ts = num(it.ts)
        if (!ts) continue
        const day = new Date(ts).toLocaleDateString("sv-SE")
        const acc = byDay.get(day) || { adSpend: 0, impressions: null, clicks: null, orders: null, gmv: null }
        acc.adSpend += cents(it.adSpend)
        acc.impressions = (acc.impressions ?? 0) + (numOrNull(it.impressions) ?? 0)
        acc.clicks = (acc.clicks ?? 0) + (numOrNull(it.clicks) ?? 0)
        acc.orders = (acc.orders ?? 0) + (numOrNull(it.orders) ?? 0)
        // gmv 是金额（分），与 adSpend 同口径除 100——此前漏除导致面板广告 GMV 放大百倍
        acc.gmv = (acc.gmv ?? 0) + cents(it.gmv)
        byDay.set(day, acc)
      }
      for (const [day, acc] of byDay) {
        await db
          .insert(temuAdsDailies)
          .values({
            storeId,
            date: day,
            adSpend: Math.round(acc.adSpend * 100) / 100,
            impressions: acc.impressions,
            clicks: acc.clicks,
            orders: acc.orders,
            gmv: acc.gmv != null ? Math.round(acc.gmv * 100) / 100 : null,
          })
          .onConflictDoUpdate({
            target: [temuAdsDailies.storeId, temuAdsDailies.date],
            set: {
              adSpend: sql`excluded.ad_spend`,
              impressions: sql`excluded.impressions`,
              clicks: sql`excluded.clicks`,
              orders: sql`excluded.orders`,
              gmv: sql`excluded.gmv`,
              updatedAt: sql`now()`,
            },
          })
      }
      return items.length > 0
    }

    case "activity-data": {
      const hash = contentHashOf(n)
      const inserted = await db
        .insert(temuActivities)
        .values({
          storeId,
          source: "activity",
          capturedAt,
          payload: { normalized: n, raw: item.raw ?? null },
          mallMeta,
          contentHash: hash,
        })
        .onConflictDoNothing()
        .returning({ id: temuActivities.id })
      return inserted.length > 0
    }

    default:
      // 订单/发货/文件等 v1 未建表 source：仅审计（调用方已统一写 ingest_log）
      return false
  }
}
