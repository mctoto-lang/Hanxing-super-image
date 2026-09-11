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
  temuActivities,
  temuIngestLogs,
  type TemuMallMeta,
} from "@/db/schema"
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
const ratio = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const str = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string" || !v) return null
  return v.slice(0, max)
}

export async function POST(request: Request) {
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
    bySource.set(item.source, stat)
  }

  await Promise.all([
    db.update(temuStores).set({ lastSeenAt: sql`now()` }).where(eq(temuStores.id, store.id)),
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
    case "fulfilment-stats": {
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
            priceDetail: null,
            overview: n,
            mallMeta,
            contentHash: hash,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: temuSalesOverviews.id })
      return inserted.length > 0
    }

    case "products-list":
    case "newon-lifecycle": {
      const items = Array.isArray(n.items) ? (n.items as Record<string, unknown>[]) : []
      if (items.length === 0) return false
      for (const it of items.slice(0, 100)) {
        const skcId = String(it.productSkcId ?? "").slice(0, 32)
        if (!skcId) continue
        await db
          .insert(temuProducts)
          .values({
            storeId,
            productSkcId: skcId,
            productId: str(it.productId, 32),
            goodsId: str(it.goodsId, 32),
            productName: str(it.productName, 500),
            category: str(it.category, 120),
            leafCategoryName: str(it.leafCategoryName, 120),
            cat1Name: str(it.cat1Name, 120),
            supplierId: str(it.supplierId, 32),
            supplierPrice: num(it.supplierPrice),
            flowGrowStatus: num(it.flowGrowStatus),
            hasSkcSelected: it.hasSkcSelected === true,
            removeStatus: num(it.removeStatus),
            skcStatus: num(it.skcStatus),
            productSn: str(it.productSn, 64),
            totalSalesVolume: num(it.totalSalesVolume),
            last7DaysSalesVolume: num(it.last7DaysSalesVolume),
            mainImageUrl: str(it.mainImageUrl, 1000),
            buyerName: str(it.buyerName, 100),
            skcCreatedAt: num(it.skcCreatedTime),
            priceVerifiedAt: num(it.priceVerificationTime),
            firstPurchaseAt: num(it.firstPurchaseTime),
            addedSiteAt: num(it.addedToSiteTime),
            lifecycleDetail: item.raw ?? null,
            mallMeta,
          })
          .onConflictDoUpdate({
            target: [temuProducts.storeId, temuProducts.productSkcId],
            set: {
              productId: str(it.productId, 32),
              goodsId: str(it.goodsId, 32),
              productName: str(it.productName, 500),
              category: str(it.category, 120),
              leafCategoryName: str(it.leafCategoryName, 120),
              cat1Name: str(it.cat1Name, 120),
              supplierId: str(it.supplierId, 32),
              supplierPrice: num(it.supplierPrice),
              flowGrowStatus: num(it.flowGrowStatus),
              hasSkcSelected: it.hasSkcSelected === true,
              removeStatus: num(it.removeStatus),
              skcStatus: num(it.skcStatus),
              productSn: str(it.productSn, 64),
              totalSalesVolume: num(it.totalSalesVolume),
              last7DaysSalesVolume: num(it.last7DaysSalesVolume),
              mainImageUrl: str(it.mainImageUrl, 1000),
              buyerName: str(it.buyerName, 100),
              skcCreatedAt: num(it.skcCreatedTime),
              priceVerifiedAt: num(it.priceVerificationTime),
              firstPurchaseAt: num(it.firstPurchaseTime),
              addedSiteAt: num(it.addedToSiteTime),
              lifecycleDetail: item.raw ?? null,
              mallMeta,
              lastSeenAt: sql`now()`,
            },
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
