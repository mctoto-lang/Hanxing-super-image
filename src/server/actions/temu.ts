"use server"

import { randomBytes } from "node:crypto"
import { and, asc, count, desc, eq, gte, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/db/client"
import {
  temuStores,
  temuMetricSnapshots,
  temuSalesOverviews,
  temuProducts,
  temuProductFlows,
  temuProductAds,
  temuDiscoveredMalls,
  temuAdsDailies,
  temuSkuSalesDailies,
  temuSkuMaps,
  temuActivities,
  temuIngestLogs,
} from "@/db/schema"
import {
  requireEnterpriseContext,
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import {
  createTemuStoreSchema,
  updateTemuStoreSchema,
  resetTemuStoreTokenSchema,
  toggleTemuStoreSchema,
  deleteTemuStoreSchema,
} from "@/server/schemas/temu"

/**
 * Temu 数据面板 Server Actions（手册 §6：查询 requireEnterpriseContext，
 * 写操作 requireEnterpriseAdmin；全部强制 getCurrentEnterpriseScope 企业隔离）
 */

// ---------- 查询 ----------

export interface TemuStoreBrief {
  id: string
  name: string
  mallId: string | null
  mallName: string | null
  enabled: boolean
  lastSeenAt: Date | null
}

/** 店铺列表（面板店铺筛选与管理页共用；按拖拽排序 sortOrder → 创建时间） */
export async function getTemuStoresAction(): Promise<TemuStoreBrief[]> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: temuStores.id,
      name: temuStores.name,
      mallId: temuStores.mallId,
      mallName: temuStores.mallName,
      enabled: temuStores.enabled,
      lastSeenAt: temuStores.lastSeenAt,
    })
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, enterpriseId))
    .orderBy(asc(temuStores.sortOrder), asc(temuStores.createdAt))
  return rows
}

/** 店铺拖拽排序（管理页行拖动，ids 为新顺序；企业隔离逐店校验） */
export async function reorderTemuStoresAction(input: { ids: string[] }) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const ids = (Array.isArray(input.ids) ? input.ids : []).map(String).slice(0, 100)
  for (let i = 0; i < ids.length; i++) {
    await db
      .update(temuStores)
      .set({ sortOrder: i, updatedAt: sql`now()` })
      .where(and(eq(temuStores.id, ids[i]), eq(temuStores.enterpriseId, enterpriseId)))
  }
  revalidatePath("/temu")
  return { ok: true }
}

/** 插件发现的店铺（数据内嵌 supplierId 自动登记、尚未绑定到任何已建店铺的 mall） */
export async function getDiscoveredMallsAction(): Promise<
  { mallId: string; mallName: string | null; firstSeenAt: Date; lastSeenAt: Date }[]
> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const bound = db
    .select({ mallId: temuStores.mallId })
    .from(temuStores)
    .where(and(eq(temuStores.enterpriseId, enterpriseId), isNotNull(temuStores.mallId)))
  return db
    .select({
      mallId: temuDiscoveredMalls.mallId,
      mallName: temuDiscoveredMalls.mallName,
      firstSeenAt: temuDiscoveredMalls.firstSeenAt,
      lastSeenAt: temuDiscoveredMalls.lastSeenAt,
    })
    .from(temuDiscoveredMalls)
    .where(and(eq(temuDiscoveredMalls.enterpriseId, enterpriseId), notInArray(temuDiscoveredMalls.mallId, bound)))
    .orderBy(desc(temuDiscoveredMalls.lastSeenAt))
}

export interface TemuOverview {
  /** 最新大盘快照（今日/7日/30日销量、在售商品数等） */
  latest: Record<string, number | null>
  /** 近 N 天每日最新快照（趋势图，本地日；saleVolume=今日销量，sevenDays=七日滚动销量） */
  trend: { date: string; saleVolume: number | null; sevenDays: number | null }[]
  /** 商品总数（temu_product 当前态） */
  productCount: number
  /** 售罄预警（最新 soldout 快照） */
  soldout: Record<string, number | null>
  /** 各店铺最后上报时间 */
  stores: TemuStoreBrief[]
  /** 顶部四卡片（value 当前值，delta 环比昨日百分比；null = 无数据）：
   *  今日销量 / 七日销量 / 30日销量 / 今日广告消耗 */
  cards: {
    todaySales: { value: number | null; delta: number | null }
    sevenDaySales: { value: number | null; delta: number | null }
    thirtyDaySales: { value: number | null; delta: number | null }
    adSpend: { value: number | null; delta: number | null }
  }
}

/** 环比百分比（昨日缺失/为 0 时返回 null，前端显示"—"） */
function deltaPct(today: number | null, yesterday: number | null): number | null {
  if (today == null || yesterday == null || yesterday === 0) return null
  return Math.round(((today - yesterday) / yesterday) * 1000) / 10
}

export async function getTemuOverviewAction(storeId?: string): Promise<TemuOverview> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  const empty: TemuOverview = {
    latest: {}, trend: [], productCount: 0, soldout: {}, stores: await getTemuStoresAction(),
    cards: {
      todaySales: { value: null, delta: null },
      sevenDaySales: { value: null, delta: null },
      thirtyDaySales: { value: null, delta: null },
      adSpend: { value: null, delta: null },
    },
  }
  if (storeIds.length === 0) return empty

  // 趋势窗口 90 天：卡片只用今昨两日，图表支持 7/30/90 天切换
  const since = new Date(Date.now() - 90 * 86400 * 1000)

  const [latestRows, trendRows, productCountRows, soldoutRows, adsRows] = await Promise.all([
    db
      .select()
      .from(temuMetricSnapshots)
      .where(and(inArray(temuMetricSnapshots.storeId, storeIds), eq(temuMetricSnapshots.source, "dashboard-stats")))
      .orderBy(desc(temuMetricSnapshots.capturedAt))
      .limit(1),
    db
      .select({
        saleVolume: temuMetricSnapshots.saleVolume,
        sevenDaysSaleVolume: temuMetricSnapshots.sevenDaysSaleVolume,
        thirtyDaysSaleVolume: temuMetricSnapshots.thirtyDaysSaleVolume,
        capturedAt: temuMetricSnapshots.capturedAt,
      })
      .from(temuMetricSnapshots)
      .where(
        and(
          inArray(temuMetricSnapshots.storeId, storeIds),
          eq(temuMetricSnapshots.source, "dashboard-stats"),
          gte(temuMetricSnapshots.capturedAt, since),
        ),
      )
      .orderBy(temuMetricSnapshots.capturedAt),
    db.select({ c: count() }).from(temuProducts).where(inArray(temuProducts.storeId, storeIds)),
    db
      .select()
      .from(temuMetricSnapshots)
      .where(and(inArray(temuMetricSnapshots.storeId, storeIds), eq(temuMetricSnapshots.source, "soldout-overview")))
      .orderBy(desc(temuMetricSnapshots.capturedAt))
      .limit(1),
    // 广告日报（今日 + 昨日）
    db
      .select({ date: temuAdsDailies.date, adSpend: temuAdsDailies.adSpend })
      .from(temuAdsDailies)
      .where(
        and(
          inArray(temuAdsDailies.storeId, storeIds),
          gte(temuAdsDailies.date, sql`current_date - 1`),
        ),
      ),
  ])

  // 每日取最后一条快照（按天分组覆盖）
  const byDay = new Map<string, { saleVolume: number | null; sevenDays: number | null; thirtyDays: number | null }>()
  for (const r of trendRows) {
    const d = new Date(r.capturedAt).toLocaleDateString("sv-SE") // YYYY-MM-DD（本地时区）
    byDay.set(d, { saleVolume: r.saleVolume, sevenDays: r.sevenDaysSaleVolume, thirtyDays: r.thirtyDaysSaleVolume })
  }

  const todayStr = new Date().toLocaleDateString("sv-SE")
  const yesterdayStr = new Date(Date.now() - 86400 * 1000).toLocaleDateString("sv-SE")
  const todaySnap = byDay.get(todayStr)
  const yesterdaySnap = byDay.get(yesterdayStr)
  const adToday = adsRows.filter((r) => String(r.date) === todayStr).reduce((s, r) => s + (r.adSpend ?? 0), 0)
  const adYesterday = adsRows.filter((r) => String(r.date) === yesterdayStr).reduce((s, r) => s + (r.adSpend ?? 0), 0)
  const hasAds = adsRows.some((r) => String(r.date) === todayStr)

  // 趋势双线：今日销量 + 七日滚动销量（口径互相独立，不堆叠）
  const days = [...byDay.keys()].sort()
  const trend = days.map((date) => ({
    date,
    saleVolume: byDay.get(date)?.saleVolume ?? null,
    sevenDays: byDay.get(date)?.sevenDays ?? null,
  }))

  const latest = latestRows[0]
  const soldout = soldoutRows[0]
  return {
    latest: latest
      ? {
          saleVolume: latest.saleVolume,
          sevenDaysSaleVolume: latest.sevenDaysSaleVolume,
          thirtyDaysSaleVolume: latest.thirtyDaysSaleVolume,
          onSaleProductNumber: latest.onSaleProductNumber,
          waitProductNumber: latest.waitProductNumber,
          aboutToSellOutNumber: latest.aboutToSellOutNumber,
          alreadySoldOutNumber: latest.alreadySoldOutNumber,
          adjustPrice: latest.adjustPrice,
          reviewAdjustPrice: latest.reviewAdjustPrice,
        }
      : {},
    trend,
    productCount: productCountRows[0]?.c ?? 0,
    soldout: soldout
      ? {
          todaySellOutNum: soldout.todaySellOutNum,
          todaySoonSellOutNum: soldout.todaySoonSellOutNum,
          increaseSellOutNum: soldout.increaseSellOutNum,
        }
      : {},
    stores: await getTemuStoresAction(),
    cards: {
      // 日期严格隔离：四卡只认今日快照，今日未采集一律归 0，不回落到旧数据
      todaySales: {
        value: todaySnap?.saleVolume ?? 0,
        delta: deltaPct(todaySnap?.saleVolume ?? null, yesterdaySnap?.saleVolume ?? null),
      },
      sevenDaySales: {
        value: todaySnap?.sevenDays ?? 0,
        delta: deltaPct(todaySnap?.sevenDays ?? null, yesterdaySnap?.sevenDays ?? null),
      },
      thirtyDaySales: {
        value: todaySnap?.thirtyDays ?? 0,
        delta: deltaPct(todaySnap?.thirtyDays ?? null, yesterdaySnap?.thirtyDays ?? null),
      },
      adSpend: {
        value: hasAds ? Math.round(adToday * 100) / 100 : 0,
        delta: hasAds && adYesterday > 0 ? deltaPct(adToday, adYesterday) : null,
      },
    },
  }
}

export interface TemuProductRow {
  id: string
  productSkcId: string
  productId: string | null
  productName: string | null
  category: string | null
  leafCategoryName: string | null
  cat1Name: string | null
  supplierPrice: number | null
  flowGrowStatus: number | null
  hasSkcSelected: boolean | null
  removeStatus: number | null
  skcStatus: number | null
  productSn: string | null
  totalSalesVolume: number | null
  last7DaysSalesVolume: number | null
  mainImageUrl: string | null
  buyerName: string | null
  /** 上新生命周期状态文案（价格申报中等） */
  lifecycleStatus: string | null
  siteName: string | null
  skcCreatedAt: number | null
  addedSiteAt: number | null
  mallName: string | null
  lastSeenAt: Date
}

/** 商品列表（分页 + SKC/SPU(goodsId/productId)/货号/商品名 模糊搜索 + 在售筛选） */
export async function getTemuProductsAction(
  storeId: string | undefined,
  q: string | undefined,
  page: number,
  sale?: "on" | "off",
): Promise<{ rows: TemuProductRow[]; total: number }> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return { rows: [], total: 0 }

  const PAGE_SIZE = 20
  const conds = [inArray(temuProducts.storeId, storeIds)]
  if (q) {
    // SKC/SKU（productSkcId 前缀/子串命中 SKU 编号）、SPU（productId/goodsId）、货号、商品名
    const like = `%${q}%`
    conds.push(
      sql`(
        ${temuProducts.productSkcId} ilike ${like}
        or ${temuProducts.productId} ilike ${like}
        or ${temuProducts.goodsId} ilike ${like}
        or ${temuProducts.productSn} ilike ${like}
        or ${temuProducts.productName} ilike ${like}
      )`,
    )
  }
  if (sale === "on") {
    conds.push(eq(temuProducts.skcStatus, 11))
  } else if (sale === "off") {
    // 不在售 = 非 11 或未知（null 一并算不在售）
    conds.push(sql`(${temuProducts.skcStatus} is null or ${temuProducts.skcStatus} <> 11)`)
  }

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: temuProducts.id,
        productSkcId: temuProducts.productSkcId,
        productId: temuProducts.productId,
        productName: temuProducts.productName,
        category: temuProducts.category,
        leafCategoryName: temuProducts.leafCategoryName,
        cat1Name: temuProducts.cat1Name,
        supplierPrice: temuProducts.supplierPrice,
        flowGrowStatus: temuProducts.flowGrowStatus,
        hasSkcSelected: temuProducts.hasSkcSelected,
        removeStatus: temuProducts.removeStatus,
        skcStatus: temuProducts.skcStatus,
        productSn: temuProducts.productSn,
        totalSalesVolume: temuProducts.totalSalesVolume,
        last7DaysSalesVolume: temuProducts.last7DaysSalesVolume,
        mainImageUrl: temuProducts.mainImageUrl,
        buyerName: temuProducts.buyerName,
        lifecycleStatus: temuProducts.lifecycleStatus,
        siteName: temuProducts.siteName,
        skcCreatedAt: temuProducts.skcCreatedAt,
        addedSiteAt: temuProducts.addedSiteAt,
        mallName: sql<string | null>`${temuProducts.mallMeta}->'mallNames'->>0`,
        lastSeenAt: temuProducts.lastSeenAt,
      })
      .from(temuProducts)
      .where(and(...conds))
      // 详情齐全的行优先：销售管理回填的"标识枢纽行"只有货号/名称，
      // 却因 lastSeenAt 最新霸占首屏，沉底展示
      .orderBy(
        desc(
          sql`(${temuProducts.skcStatus} is not null or ${temuProducts.lifecycleStatus} is not null or ${temuProducts.category} is not null or ${temuProducts.supplierPrice} is not null or ${temuProducts.mainImageUrl} is not null)`,
        ),
        desc(temuProducts.lastSeenAt),
      )
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ c: count() }).from(temuProducts).where(and(...conds)),
  ])
  return { rows, total: totalRows[0]?.c ?? 0 }
}

/** 商品信息页组合查询（无限滚动加载）：一页商品行 + 对应 SKC 的销量/库存/趋势序列 */
export async function getTemuProductsPageAction(
  storeId: string | undefined,
  q: string | undefined,
  sale: "on" | "off" | undefined,
  page: number,
): Promise<{ rows: TemuProductRow[]; salesInfo: TemuProductSalesInfo }> {
  const { rows } = await getTemuProductsAction(storeId, q, page, sale)
  const salesInfo = await getTemuProductSalesInfoAction(
    storeId,
    rows.map((r) => r.productSkcId),
  )
  return { rows, salesInfo }
}

export interface TemuFlowRow {
  id: string
  goodsId: string
  goodsName: string | null
  category: string | null
  goodsImageUrl: string | null
  source: string
  capturedAt: Date
  /** 货号（goodsId 关联 temu_product 回填，统一商品 ID） */
  productSn: string | null
  /** SKC（goodsId 经 temu_product 枢纽反查——goods-only 数据源的标识聚合） */
  productSkcId: string | null
  exposeNum: number | null
  clickNum: number | null
  payGoodsNum: number | null
  payOrderNum: number | null
  buyerNum: number | null
  addToCartUserNum: number | null
  goodsDetailVisitNum: number | null
  /** 商详访客去重数（流量情况-访客数） */
  goodsDetailVisitorNum: number | null
  /** 申报价格（聚合查询 SPU/goodsId 得出，分） */
  supplierPrice: number | null
  searchExposeNum: number | null
  searchClickNum: number | null
  recommendExposeNum: number | null
  recommendClickNum: number | null
  metrics: Record<string, unknown> | null
}

export interface TemuFlowCards {
  /** 今日总访客数（商详&店铺首页去重人数） */
  todayVisitors: number | null
  /** 今日支付买家数（去重） */
  todayBuyers: number | null
  /** 今日转化率 = 支付买家 ÷ 总访客（百分比，一位小数） */
  todayConversionRate: number | null
}

/** 流量分析（顶部三大盘卡 + 最新一批 flux-analysis-goods 明细） */
export async function getTemuFlowAction(
  storeId?: string,
): Promise<{ rows: TemuFlowRow[]; cards: TemuFlowCards }> {
  const emptyCards: TemuFlowCards = { todayVisitors: null, todayBuyers: null, todayConversionRate: null }
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return { rows: [], cards: emptyCards }

  // 流量分析为"今日"口径：每商品各店取最新一行（当日捕获），避免按页上报时
  // 只剩最后一页、以及旧行"当时的今日值"混入
  const latestSq = db
    .selectDistinctOn([temuProductFlows.storeId, temuProductFlows.goodsId], {
      id: temuProductFlows.id,
      storeId: temuProductFlows.storeId,
      goodsId: temuProductFlows.goodsId,
      goodsName: temuProductFlows.goodsName,
      category: temuProductFlows.category,
      goodsImageUrl: temuProductFlows.goodsImageUrl,
      productSpuId: temuProductFlows.productSpuId,
      source: temuProductFlows.source,
      capturedAt: temuProductFlows.capturedAt,
      exposeNum: temuProductFlows.exposeNum,
      clickNum: temuProductFlows.clickNum,
      goodsDetailVisitorNum: temuProductFlows.goodsDetailVisitorNum,
      payGoodsNum: temuProductFlows.payGoodsNum,
      payOrderNum: temuProductFlows.payOrderNum,
      buyerNum: temuProductFlows.buyerNum,
      addToCartUserNum: temuProductFlows.addToCartUserNum,
      goodsDetailVisitNum: temuProductFlows.goodsDetailVisitNum,
      searchExposeNum: temuProductFlows.searchExposeNum,
      searchClickNum: temuProductFlows.searchClickNum,
      recommendExposeNum: temuProductFlows.recommendExposeNum,
      recommendClickNum: temuProductFlows.recommendClickNum,
      metrics: temuProductFlows.metrics,
    })
    .from(temuProductFlows)
    .where(
      and(
        inArray(temuProductFlows.storeId, storeIds),
        eq(temuProductFlows.source, "flux-analysis-goods"),
        gte(temuProductFlows.capturedAt, startOfToday()),
      ),
    )
    .orderBy(
      temuProductFlows.storeId,
      temuProductFlows.goodsId,
      desc(temuProductFlows.capturedAt),
      desc(temuProductFlows.id),
    )
    .as("latest_goods")

  const flowRows = await db
    .select({
      id: latestSq.id,
      storeId: latestSq.storeId,
      goodsId: latestSq.goodsId,
      goodsName: latestSq.goodsName,
      category: latestSq.category,
      goodsImageUrl: latestSq.goodsImageUrl,
      source: latestSq.source,
      capturedAt: latestSq.capturedAt,
      productSpuId: latestSq.productSpuId,
      exposeNum: latestSq.exposeNum,
      clickNum: latestSq.clickNum,
      goodsDetailVisitorNum: latestSq.goodsDetailVisitorNum,
      payGoodsNum: latestSq.payGoodsNum,
      payOrderNum: latestSq.payOrderNum,
      buyerNum: latestSq.buyerNum,
      addToCartUserNum: latestSq.addToCartUserNum,
      goodsDetailVisitNum: latestSq.goodsDetailVisitNum,
      searchExposeNum: latestSq.searchExposeNum,
      searchClickNum: latestSq.searchClickNum,
      recommendExposeNum: latestSq.recommendExposeNum,
      recommendClickNum: latestSq.recommendClickNum,
      metrics: latestSq.metrics,
    })
    .from(latestSq)
    .orderBy(desc(latestSq.exposeNum))
    .limit(100)

  // 货号/SKC/申报价反查在应用层合并：关联子查询引用外层子查询列会被渲染成
  // 未限定列名并绑定到内层表（tp.goods_id = tp.goods_id 恒真），导致每行
  // 反查到同一条商品（货号/申报价全表重复的根因）。键：goodsId 精确优先，
  // 回落 productSpuId↔productId（两处 ID 空间实测一致）
  const goodsIds = [...new Set(flowRows.map((r) => r.goodsId).filter((v): v is string => !!v))]
  const spuIds = [
    ...new Set(flowRows.map((r) => r.productSpuId).filter((v): v is string => !!v)),
  ]
  const productRows: {
    storeId: string
    goodsId: string | null
    productId: string | null
    productSn: string | null
    supplierPrice: number | null
    productSkcId: string
  }[] =
    goodsIds.length > 0 || spuIds.length > 0
      ? await db
          .select({
            storeId: temuProducts.storeId,
            goodsId: temuProducts.goodsId,
            productId: temuProducts.productId,
            productSn: temuProducts.productSn,
            supplierPrice: temuProducts.supplierPrice,
            productSkcId: temuProducts.productSkcId,
          })
          .from(temuProducts)
          .where(
            and(
              inArray(temuProducts.storeId, storeIds),
              or(
                goodsIds.length > 0 ? inArray(temuProducts.goodsId, goodsIds) : undefined,
                spuIds.length > 0 ? inArray(temuProducts.productId, spuIds) : undefined,
              ),
            ),
          )
      : []
  const byGoods = new Map<string, (typeof productRows)[number]>()
  const bySpu = new Map<string, (typeof productRows)[number]>()
  // 同 goods 多 SKC 行：优先保留带货号/带价格的行
  const better = (
    a: (typeof productRows)[number] | undefined,
    b: (typeof productRows)[number],
  ) => !a || ((!a.productSn || !a.supplierPrice) && b.productSn && b.supplierPrice)
  for (const p of productRows) {
    if (p.goodsId) {
      const k = `${p.storeId}|${p.goodsId}`
      if (better(byGoods.get(k), p)) byGoods.set(k, p)
    }
    if (p.productId) {
      const k = `${p.storeId}|${p.productId}`
      if (better(bySpu.get(k), p)) bySpu.set(k, p)
    }
  }
  const rows = flowRows.map((r) => {
    const p =
      byGoods.get(`${r.storeId}|${r.goodsId}`) ??
      (r.productSpuId ? bySpu.get(`${r.storeId}|${r.productSpuId}`) : undefined)
    return {
      ...r,
      productSn: p?.productSn ?? null,
      productSkcId: p?.productSkcId ?? null,
      supplierPrice: p?.supplierPrice ?? null,
    }
  })

  // 顶部三卡：flux-analysis-summary 各店铺最新快照求和（今日访客/支付买家），
  // 转化率 = 汇总买家 ÷ 汇总访客（分店比率不可加总）
  const latestSummaries = await db
    .selectDistinctOn([temuMetricSnapshots.storeId], {
      storeId: temuMetricSnapshots.storeId,
      capturedAt: temuMetricSnapshots.capturedAt,
      metrics: temuMetricSnapshots.metrics,
    })
    .from(temuMetricSnapshots)
    .where(
      and(inArray(temuMetricSnapshots.storeId, storeIds), eq(temuMetricSnapshots.source, "flux-analysis-summary")),
    )
    .orderBy(temuMetricSnapshots.storeId, desc(temuMetricSnapshots.capturedAt))
  const num2 = (v: unknown) => {
    const x = Number(v)
    return Number.isFinite(x) ? x : 0
  }
  const todayVisitors = latestSummaries.reduce(
    (s, r) => s + num2((r.metrics as Record<string, unknown>)?.todayTotalVisitorsNum),
    0,
  )
  const todayBuyers = latestSummaries.reduce(
    (s, r) => s + num2((r.metrics as Record<string, unknown>)?.todayPayBuyerNum),
    0,
  )
  const cards = {
    todayVisitors: latestSummaries.length > 0 ? todayVisitors : null,
    todayBuyers: latestSummaries.length > 0 ? todayBuyers : null,
    todayConversionRate:
      latestSummaries.length > 0 && todayVisitors > 0
        ? Math.round((todayBuyers / todayVisitors) * 10000) / 100
        : null,
  }

  return { rows, cards }
}

// ---------- 销售概览统计（类目占比 / TOP 榜 / 广告效果 / 转化漏斗） ----------

/** 当日零点（服务器本地时区）：日口径指标只认当日捕获的行 */
function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// 插件按"页"上报销售总览（每页一个 capturedAt），且插件与库侧对未变化的页做
// 内容哈希去重（旧行保留旧时间戳）。因此不能按"某个 capturedAt 批次"圈定
// 整批数据——那只会选中最后上报的一页。这里统一改为：每个 SKC（或 goods）
// 各取最新一行再汇总，未变化页的旧行同样参与，口径才完整。

export interface TemuCategoryShare {
  category: string
  todaySalesVolume: number
  last7DaysSalesVolume: number
  last30DaysSalesVolume: number
}

/** 售出类目占比：每 SKC 最新行按类目汇总销量（今日/7日/30日三口径，空类目归"未分类"） */
export async function getTemuCategoryShareAction(storeId?: string): Promise<TemuCategoryShare[]> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return []
  const latestSq = db
    .selectDistinctOn([temuSalesOverviews.storeId, temuSalesOverviews.skcId], {
      category: temuSalesOverviews.category,
      capturedAt: temuSalesOverviews.capturedAt,
      todaySalesVolume: temuSalesOverviews.todaySalesVolume,
      last7DaysSalesVolume: temuSalesOverviews.last7DaysSalesVolume,
      last30DaysSalesVolume: temuSalesOverviews.last30DaysSalesVolume,
    })
    .from(temuSalesOverviews)
    .where(inArray(temuSalesOverviews.storeId, storeIds))
    .orderBy(
      temuSalesOverviews.storeId,
      temuSalesOverviews.skcId,
      desc(temuSalesOverviews.capturedAt),
      desc(temuSalesOverviews.id),
    )
    .as("latest_skc")
  const todayStart = startOfToday()
  const rows = await db
    .select({
      category: latestSq.category,
      // 今日口径只累计当日捕获的行：旧行的 today 值是捕获当时的"今日"，
      // 混入会把昨日销量重复计入
      today: sql<string>`coalesce(sum(case when ${gte(latestSq.capturedAt, todayStart)} then coalesce(${latestSq.todaySalesVolume}, 0) else 0 end), 0)`,
      last7: sql<string>`coalesce(sum(${latestSq.last7DaysSalesVolume}), 0)`,
      last30: sql<string>`coalesce(sum(${latestSq.last30DaysSalesVolume}), 0)`,
    })
    .from(latestSq)
    .groupBy(latestSq.category)
  return rows.map((r) => ({
    category: r.category?.trim() || "未分类",
    todaySalesVolume: Number(r.today ?? 0),
    last7DaysSalesVolume: Number(r.last7 ?? 0),
    last30DaysSalesVolume: Number(r.last30 ?? 0),
  }))
}

export interface TemuSalesTopRow {
  skcId: string
  productName: string | null
  category: string | null
  /** 货号（销售总览自带，缺失时回落商品表） */
  productSn: string | null
  /** 主图（关联 temu_product 补齐，榜单缩略图用） */
  mainImageUrl: string | null
  /** 申报供货价（分，CNY；预估销售额 = 销量 × 价格 / 100） */
  supplierPrice: number | null
  todaySalesVolume: number | null
  last7DaysSalesVolume: number | null
  last30DaysSalesVolume: number | null
}

/** 售出 TOP 榜：每 SKC 最新行按近 7 日销量预排序取前 60（三口径字段齐备，前端按口径重排取 10） */
export async function getTemuSalesTopAction(storeId?: string): Promise<TemuSalesTopRow[]> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return []
  const latestSq = db
    .selectDistinctOn([temuSalesOverviews.storeId, temuSalesOverviews.skcId], {
      storeId: temuSalesOverviews.storeId,
      skcId: temuSalesOverviews.skcId,
      productName: temuSalesOverviews.productName,
      category: temuSalesOverviews.category,
      productSn: temuSalesOverviews.productSn,
      capturedAt: temuSalesOverviews.capturedAt,
      todaySalesVolume: temuSalesOverviews.todaySalesVolume,
      last7DaysSalesVolume: temuSalesOverviews.last7DaysSalesVolume,
      last30DaysSalesVolume: temuSalesOverviews.last30DaysSalesVolume,
    })
    .from(temuSalesOverviews)
    .where(inArray(temuSalesOverviews.storeId, storeIds))
    .orderBy(
      temuSalesOverviews.storeId,
      temuSalesOverviews.skcId,
      desc(temuSalesOverviews.capturedAt),
      desc(temuSalesOverviews.id),
    )
    .as("latest_skc")
  const todayStart = startOfToday()
  // 按 SKC 聚合（SQL GROUP BY）：多店铺视图下同一 SKC 出现在各店批次中，
  // 不聚合会导致列表 key 重复且榜单口径失真；三口径销量跨店求和
  const rows = await db
    .select({
      skcId: latestSq.skcId,
      productName: sql<string | null>`max(${latestSq.productName})`,
      category: sql<string | null>`max(${latestSq.category})`,
      productSn: sql<string | null>`coalesce(max(${latestSq.productSn}), max(${temuProducts.productSn}))`,
      mainImageUrl: sql<string | null>`max(${temuProducts.mainImageUrl})`,
      supplierPrice: sql<string | null>`max(${temuProducts.supplierPrice})`,
      // 今日口径只累计当日捕获的行（同类目占比）
      today: sql<string>`coalesce(sum(case when ${gte(latestSq.capturedAt, todayStart)} then coalesce(${latestSq.todaySalesVolume}, 0) else 0 end), 0)`,
      last7: sql<string>`coalesce(sum(${latestSq.last7DaysSalesVolume}), 0)`,
      last30: sql<string>`coalesce(sum(${latestSq.last30DaysSalesVolume}), 0)`,
    })
    .from(latestSq)
    .leftJoin(
      temuProducts,
      and(
        eq(temuProducts.storeId, latestSq.storeId),
        eq(temuProducts.productSkcId, latestSq.skcId),
      ),
    )
    .groupBy(latestSq.skcId)
    .orderBy(desc(sql`coalesce(sum(${latestSq.last7DaysSalesVolume}), 0)`))
    .limit(60)
  return rows.map((r) => ({
    skcId: r.skcId,
    productName: r.productName,
    category: r.category,
    productSn: r.productSn,
    mainImageUrl: r.mainImageUrl,
    supplierPrice: r.supplierPrice != null ? Number(r.supplierPrice) : null,
    todaySalesVolume: Number(r.today),
    last7DaysSalesVolume: Number(r.last7),
    last30DaysSalesVolume: Number(r.last30),
  }))
}

export interface TemuProductSalesInfo {
  /** 销售管理最新批次：skcId → 今日销量/仓内可用/已发货/可售天数（跨店求和，天数取最大） */
  latest: Record<
    string,
    { todaySalesVolume: number | null; warehouseAvailableStock: number | null; shippedStock: number | null; availableSaleDays: number | null }
  >
  /** 近 30 天日序列（分日分店取最后批次再跨店求和）：skcId → [{day, value}] */
  series: Record<string, { day: string; value: number }[]>
}

/** 商品信息页的销量/库存补充：商品列表接口本身无今日销量与库存，从销售管理最新批次取 */
export async function getTemuProductSalesInfoAction(
  storeId: string | undefined,
  skcIds: string[],
): Promise<TemuProductSalesInfo> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  const ids = (skcIds || []).map(String).filter(Boolean).slice(0, 50)
  if (storeIds.length === 0 || ids.length === 0) return { latest: {}, series: {} }

  const since = new Date(Date.now() - 31 * 86400 * 1000)
  // 每 SKC 各店最新行再跨店求和；今日口径只认当日捕获的行（同上）
  const latestSq = db
    .selectDistinctOn([temuSalesOverviews.storeId, temuSalesOverviews.skcId], {
      skcId: temuSalesOverviews.skcId,
      capturedAt: temuSalesOverviews.capturedAt,
      todaySalesVolume: temuSalesOverviews.todaySalesVolume,
      warehouseAvailableStock: temuSalesOverviews.warehouseAvailableStock,
      shippedStock: temuSalesOverviews.shippedStock,
      availableSaleDays: temuSalesOverviews.availableSaleDays,
    })
    .from(temuSalesOverviews)
    .where(
      and(inArray(temuSalesOverviews.storeId, storeIds), inArray(temuSalesOverviews.skcId, ids)),
    )
    .orderBy(
      temuSalesOverviews.storeId,
      temuSalesOverviews.skcId,
      desc(temuSalesOverviews.capturedAt),
      desc(temuSalesOverviews.id),
    )
    .as("latest_skc")
  const todayStart = startOfToday()
  const [latestRows, historyRows] = await Promise.all([
    db
      .select({
        skcId: latestSq.skcId,
        todaySalesVolume: sql<string>`coalesce(sum(case when ${gte(latestSq.capturedAt, todayStart)} then coalesce(${latestSq.todaySalesVolume}, 0) else 0 end), 0)`,
        warehouseAvailableStock: sql<string>`coalesce(sum(${latestSq.warehouseAvailableStock}), 0)`,
        shippedStock: sql<string>`coalesce(sum(${latestSq.shippedStock}), 0)`,
        availableSaleDays: sql<string | null>`max(${latestSq.availableSaleDays})`,
      })
      .from(latestSq)
      .groupBy(latestSq.skcId),
    db
      .select({
        skcId: temuSalesOverviews.skcId,
        storeId: temuSalesOverviews.storeId,
        todaySalesVolume: temuSalesOverviews.todaySalesVolume,
        capturedAt: temuSalesOverviews.capturedAt,
      })
      .from(temuSalesOverviews)
      .where(
        and(
          inArray(temuSalesOverviews.storeId, storeIds),
          inArray(temuSalesOverviews.skcId, ids),
          gte(temuSalesOverviews.capturedAt, since),
        ),
      ),
  ])

  const latest: TemuProductSalesInfo["latest"] = {}
  for (const r of latestRows) {
    latest[r.skcId] = {
      todaySalesVolume: Number(r.todaySalesVolume),
      warehouseAvailableStock: Number(r.warehouseAvailableStock),
      shippedStock: Number(r.shippedStock),
      availableSaleDays: r.availableSaleDays != null ? Number(r.availableSaleDays) : null,
    }
  }

  // 直采日序列优先（销售管理"销售趋势"接口，TEMU 官方口径 30 天逐日）：
  // SKU 日销量经 SKU↔SKC 映射按 SKC 聚合求和；有直采数据的 SKC 不再用快照推算
  const directRows = await db
    .select({
      skcId: temuSkuMaps.skcId,
      day: temuSkuSalesDailies.date,
      value: sql<string>`sum(${temuSkuSalesDailies.salesNumber})`,
    })
    .from(temuSkuSalesDailies)
    .innerJoin(
      temuSkuMaps,
      and(
        eq(temuSkuMaps.storeId, temuSkuSalesDailies.storeId),
        eq(temuSkuMaps.skuId, temuSkuSalesDailies.skuId),
      ),
    )
    .where(
      and(
        inArray(temuSkuSalesDailies.storeId, storeIds),
        inArray(temuSkuMaps.skcId, ids),
        gte(temuSkuSalesDailies.date, sql`(current_date - 30)::date`),
      ),
    )
    .groupBy(temuSkuMaps.skcId, temuSkuSalesDailies.date)
  const directSeries = new Map<string, { day: string; value: number }[]>()
  for (const r of directRows) {
    const day = String(r.day)
    const list = directSeries.get(r.skcId) || (directSeries.set(r.skcId, []), directSeries.get(r.skcId)!)
    list.push({ day, value: Number(r.value) })
  }

  // 分日分店取最后批次，再按日跨店求和（多店视图口径一致）——快照推算，仅作
  // 无直采数据 SKC 的回落
  const dayStoreLatest = new Map<string, { ts: number; vol: number }>()
  for (const r of historyRows) {
    const day = new Date(r.capturedAt).toLocaleDateString("sv-SE")
    const key = `${r.skcId}|${day}|${r.storeId}`
    const prev = dayStoreLatest.get(key)
    const ts = r.capturedAt.getTime()
    if (prev && prev.ts >= ts) continue
    dayStoreLatest.set(key, { ts, vol: r.todaySalesVolume ?? 0 })
  }
  const fallbackSeries: TemuProductSalesInfo["series"] = {}
  for (const [key, v] of dayStoreLatest) {
    const [skcId, day] = key.split("|")
    const list = fallbackSeries[skcId] || (fallbackSeries[skcId] = [])
    const existing = list.find((p) => p.day === day)
    if (existing) existing.value += v.vol
    else list.push({ day, value: v.vol })
  }
  const series: TemuProductSalesInfo["series"] = {}
  const seen = new Set<string>()
  for (const [skcId, list] of directSeries) {
    list.sort((a, b) => (a.day < b.day ? -1 : 1))
    series[skcId] = list
    seen.add(skcId)
  }
  for (const [skcId, list] of Object.entries(fallbackSeries)) {
    if (!seen.has(skcId)) series[skcId] = list
  }
  return { latest, series }
}

export interface TemuAdsEffect {
  /** 近 7 日逐日（date 为 YYYY-MM-DD；未采集的天补 0，恒定 7 条） */
  days: { date: string; adSpend: number; gmv: number | null; orders: number | null }[]
  /** 近 7 日汇总（roi = gmv / adSpend，花费为 0 时 null） */
  last7: { adSpend: number; gmv: number; orders: number; roi: number | null }
}

/** 广告效果：近 7 日逐日花费/GMV/订单（未采集的天补 0）+ 近 7 日汇总与 ROI。
 *  日期窗口用应用本地时间计算并 inArray 精确匹配，避免 DB 会话 UTC 时区的
 *  current_date 在东八区晚间把窗口整体偏移一天 */
export async function getTemuAdsEffectAction(storeId?: string): Promise<TemuAdsEffect> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return { days: [], last7: { adSpend: 0, gmv: 0, orders: 0, roi: null } }
  const dayStr = (d: Date) => d.toLocaleDateString("sv-SE")
  const window = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return dayStr(d)
  })
  const rows = await db
    .select({
      date: temuAdsDailies.date,
      adSpend: sql<string | null>`sum(${temuAdsDailies.adSpend})`,
      gmv: sql<string | null>`sum(${temuAdsDailies.gmv})`,
      orders: sql<string | null>`sum(${temuAdsDailies.orders})`,
    })
    .from(temuAdsDailies)
    .where(and(inArray(temuAdsDailies.storeId, storeIds), inArray(temuAdsDailies.date, window)))
    .groupBy(temuAdsDailies.date)
  const rowByDate = new Map(rows.map((r) => [String(r.date), r]))
  const days = window.map((date) => {
    const r = rowByDate.get(date)
    return {
      date,
      adSpend: Math.round(Number(r?.adSpend ?? 0) * 100) / 100,
      gmv: r?.gmv != null ? Math.round(Number(r.gmv) * 100) / 100 : null,
      orders: r?.orders != null ? Number(r.orders) : null,
    }
  })
  const adSpend = Math.round(days.reduce((s, d) => s + d.adSpend, 0) * 100) / 100
  const gmv = Math.round(days.reduce((s, d) => s + (d.gmv ?? 0), 0) * 100) / 100
  const orders = days.reduce((s, d) => s + (d.orders ?? 0), 0)
  return { days, last7: { adSpend, gmv, orders, roi: adSpend > 0 ? Math.round((gmv / adSpend) * 100) / 100 : null } }
}

export interface TemuFlowFunnel {
  exposeNum: number
  clickNum: number
  goodsDetailVisitNum: number
  addToCartUserNum: number
  payGoodsNum: number
}

/** 转化漏斗：当日流量批次（flux-analysis-goods）每商品最新行全量求和 曝光→点击→商详→加购→支付 */
export async function getTemuFlowFunnelAction(storeId?: string): Promise<TemuFlowFunnel | null> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return null
  // 流量分析为"今日"口径：只认当日捕获的行（旧行是当时的"今日"数值，混入会
  // 重复计算），每商品各店取最新一行再全量求和
  const latestSq = db
    .selectDistinctOn([temuProductFlows.storeId, temuProductFlows.goodsId], {
      exposeNum: temuProductFlows.exposeNum,
      clickNum: temuProductFlows.clickNum,
      goodsDetailVisitNum: temuProductFlows.goodsDetailVisitNum,
      addToCartUserNum: temuProductFlows.addToCartUserNum,
      payGoodsNum: temuProductFlows.payGoodsNum,
    })
    .from(temuProductFlows)
    .where(
      and(
        inArray(temuProductFlows.storeId, storeIds),
        eq(temuProductFlows.source, "flux-analysis-goods"),
        gte(temuProductFlows.capturedAt, startOfToday()),
      ),
    )
    .orderBy(
      temuProductFlows.storeId,
      temuProductFlows.goodsId,
      desc(temuProductFlows.capturedAt),
      desc(temuProductFlows.id),
    )
    .as("latest_goods")
  const [row] = await db
    .select({
      exposeNum: sql<string | null>`sum(${latestSq.exposeNum})`,
      clickNum: sql<string | null>`sum(${latestSq.clickNum})`,
      goodsDetailVisitNum: sql<string | null>`sum(${latestSq.goodsDetailVisitNum})`,
      addToCartUserNum: sql<string | null>`sum(${latestSq.addToCartUserNum})`,
      payGoodsNum: sql<string | null>`sum(${latestSq.payGoodsNum})`,
    })
    .from(latestSq)
  if (!row) return null
  return {
    exposeNum: Number(row.exposeNum ?? 0),
    clickNum: Number(row.clickNum ?? 0),
    goodsDetailVisitNum: Number(row.goodsDetailVisitNum ?? 0),
    addToCartUserNum: Number(row.addToCartUserNum ?? 0),
    payGoodsNum: Number(row.payGoodsNum ?? 0),
  }
}

export interface TemuAdsRow {
  id: string
  goodsId: string | null
  skcId: string | null
  /** 货号（上报缺失时 goodsId 关联 temu_product 回填） */
  productSn: string | null
  /** SKC 标识聚合（goods-only 条目经 temu_product 反查补齐） */
  productSkcId: string | null
  productName: string | null
  /** 主图（goodsId 关联 temu_product 反查） */
  mainImageUrl: string | null
  capturedAt: Date
  spend: number | null
  impressions: number | null
  clicks: number | null
  orders: number | null
  gmv: number | null
  /** 净申报价销售额（全域，分） */
  netOrderPayAmt: number | null
  /** ROAS 数值（全域） */
  roasVal: number | null
  /** 净每笔成交花费（分） */
  netTransactionCost: number | null
  /** 净件数 */
  netGoodsNum: number | null
  mallName: string | null
}

/** 商品推广（ads.temu.com 商品级报表：各店铺各自最新一批快照） */
export interface TemuAdsCards {
  /** 总花费（元） */
  totalSpend: number | null
  /** 申报价销售额（全域，元）—— orderPayAmtAll 缺失时回退净口径 */
  salesAmount: number | null
  /** 投资回报率 ROAS（全域）—— roasAll 回退 netRoas */
  roas: number | null
  /** 每笔订单成交花费（全域，元）—— transactionCost 回退 总花费÷订单数 */
  costPerOrder: number | null
}

/** 广告推广（最新一批商品级报表 + 店铺级大盘卡） */
export async function getTemuAdsAction(
  storeId?: string,
): Promise<{ rows: TemuAdsRow[]; cards: TemuAdsCards }> {
  const emptyCards: TemuAdsCards = { totalSpend: null, salesAmount: null, roas: null, costPerOrder: null }
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return { rows: [], cards: emptyCards }
  // 日期严格隔离：本轮批次 = 当日捕获的行（今日未采集 → 空表），
  // 每条商品广告（storeId+goodsId+skcId）当日取最新一行
  const latestSq = db
    .selectDistinctOn(
      [temuProductAds.storeId, temuProductAds.goodsId, temuProductAds.skcId],
      {
        id: temuProductAds.id,
        storeId: temuProductAds.storeId,
        goodsId: temuProductAds.goodsId,
        skcId: temuProductAds.skcId,
        productSn: temuProductAds.productSn,
        productName: temuProductAds.productName,
        capturedAt: temuProductAds.capturedAt,
        spend: temuProductAds.spend,
        impressions: temuProductAds.impressions,
        clicks: temuProductAds.clicks,
        orders: temuProductAds.orders,
        gmv: temuProductAds.gmv,
        netOrderPayAmt: temuProductAds.netOrderPayAmt,
        roasVal: temuProductAds.roasVal,
        netTransactionCost: temuProductAds.netTransactionCost,
        netGoodsNum: temuProductAds.netGoodsNum,
        mallMeta: temuProductAds.mallMeta,
      },
    )
    .from(temuProductAds)
    .where(
      and(inArray(temuProductAds.storeId, storeIds), gte(temuProductAds.capturedAt, startOfToday())),
    )
    .orderBy(
      temuProductAds.storeId,
      temuProductAds.goodsId,
      temuProductAds.skcId,
      desc(temuProductAds.capturedAt),
      desc(temuProductAds.id),
    )
    .as("latest_ad")
  const adRows = await db
    .select({
      id: latestSq.id,
      storeId: latestSq.storeId,
      goodsId: latestSq.goodsId,
      skcId: latestSq.skcId,
      productSn: latestSq.productSn,
      productName: latestSq.productName,
      capturedAt: latestSq.capturedAt,
      spend: latestSq.spend,
      impressions: latestSq.impressions,
      clicks: latestSq.clicks,
      orders: latestSq.orders,
      gmv: latestSq.gmv,
      netOrderPayAmt: latestSq.netOrderPayAmt,
      roasVal: latestSq.roasVal,
      netTransactionCost: latestSq.netTransactionCost,
      netGoodsNum: latestSq.netGoodsNum,
      mallMeta: latestSq.mallMeta,
    })
    .from(latestSq)
    .orderBy(desc(latestSq.spend))
    .limit(100)

  // 货号/SKC/主图反查在应用层合并（同流量页：关联子查询的列名绑定 bug
  // 会让每行反查到同一条商品——主图全表重复的根因）
  const adGoodsIds = [
    ...new Set(adRows.map((r) => r.goodsId).filter((v): v is string => !!v)),
  ]
  const adProductRows = adGoodsIds.length
    ? await db
        .select({
          storeId: temuProducts.storeId,
          goodsId: temuProducts.goodsId,
          productSn: temuProducts.productSn,
          productSkcId: temuProducts.productSkcId,
          mainImageUrl: temuProducts.mainImageUrl,
        })
        .from(temuProducts)
        .where(and(inArray(temuProducts.storeId, storeIds), inArray(temuProducts.goodsId, adGoodsIds)))
    : []
  const adByGoods = new Map<string, (typeof adProductRows)[number]>()
  for (const p of adProductRows) {
    if (!p.goodsId) continue
    const k = `${p.storeId}|${p.goodsId}`
    // 同 goods 多 SKC：优先保留带货号/主图的行
    const cur = adByGoods.get(k)
    if (!cur || ((!cur.productSn || !cur.mainImageUrl) && p.productSn && p.mainImageUrl)) adByGoods.set(k, p)
  }
  const rows = adRows.map((r) => {
    const p = r.goodsId ? adByGoods.get(`${r.storeId}|${r.goodsId}`) : undefined
    return {
      id: r.id,
      goodsId: r.goodsId,
      skcId: r.skcId,
      productSn: r.productSn ?? p?.productSn ?? null,
      /** SKC 标识聚合：优先条目自带，缺失时 goodsId 经 temu_product 反查 */
      productSkcId: r.skcId ?? p?.productSkcId ?? null,
      productName: r.productName,
      /** 主图（goodsId 关联 temu_product 反查） */
      mainImageUrl: p?.mainImageUrl ?? null,
      capturedAt: r.capturedAt,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      orders: r.orders,
      gmv: r.gmv,
      netOrderPayAmt: r.netOrderPayAmt,
      roasVal: r.roasVal,
      netTransactionCost: r.netTransactionCost,
      netGoodsNum: r.netGoodsNum,
      mallName: (r.mallMeta as { mallNames?: string[] } | null)?.mallNames?.[0] ?? null,
    }
  })

  // 大盘卡由今日批次商品行聚合（金额分→元）：彻底弃用 ads-report-summary 快照
  // 解析——其 trans_val/回退除法曾产出 ROAS 五位数乃至 5000000000000000 的极端值、
  // 每笔成交花费为空；行聚合与表格同源，口径一致
  const sum = (get: (r: typeof rows[number]) => number | null) =>
    rows.reduce((s, r) => s + (get(r) ?? 0), 0)
  const totalSpendFen = sum((r) => r.spend)
  const gmvFen = sum((r) => r.gmv) || sum((r) => r.netOrderPayAmt)
  const orders = sum((r) => r.orders)
  const yuan = (fen: number) => Math.round(fen) / 100
  const cards: TemuAdsCards = {
    totalSpend: yuan(totalSpendFen),
    salesAmount: yuan(gmvFen),
    roas:
      totalSpendFen > 0 && gmvFen > 0 ? Math.round((gmvFen / totalSpendFen) * 100) / 100 : null,
    // 每笔成交花费：totalSpendFen/orders 的单位是"分/单"，须再 /100 转元
    // （此前漏除 100，把分当元展示，数值放大 100 倍）
    costPerOrder: orders > 0 ? Math.round(totalSpendFen / orders) / 100 : null,
  }
  return { rows, cards }
}

// ---------- 店铺管理（企业管理员） ----------

export interface CreateTemuStoreResult {
  ok: true
  store: { id: string; name: string }
  /** 新 token：仅此一次明文返回，前端弹窗展示 */
  deviceToken: string
}

export async function createTemuStoreAction(input: {
  name: string
  mallId?: string
  mallName?: string
}): Promise<CreateTemuStoreResult> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const data = createTemuStoreSchema.parse(input)
  const deviceToken = randomBytes(24).toString("hex")
  const [row] = await db
    .insert(temuStores)
    .values({
      enterpriseId,
      name: data.name,
      deviceToken,
      mallId: data.mallId || null,
      mallName: data.mallName || null,
    })
    .returning({ id: temuStores.id, name: temuStores.name })
  revalidatePath("/temu")
  return { ok: true, store: row, deviceToken }
}

/**
 * 确认收录插件发现的店铺：按 mallId 建店（自动绑定 mallId/mallName + 生成 token）。
 * 确认后插件下个同步周期（≤10 分钟）自动拉取该店铺，后续数据即归属到它。
 */
export async function confirmDiscoveredStoreAction(input: { mallId: string }) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const mallId = String(input.mallId || "").slice(0, 32)
  if (!mallId) throw new Error("缺少 mallId")

  const [existing] = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(and(eq(temuStores.enterpriseId, enterpriseId), eq(temuStores.mallId, mallId)))
    .limit(1)
  if (existing) return { ok: true, store: existing, duplicated: true }

  const [discovered] = await db
    .select({ mallName: temuDiscoveredMalls.mallName })
    .from(temuDiscoveredMalls)
    .where(and(eq(temuDiscoveredMalls.enterpriseId, enterpriseId), eq(temuDiscoveredMalls.mallId, mallId)))
    .limit(1)
  const mallName = discovered?.mallName || `店铺 ${mallId.slice(-4)}`

  const deviceToken = randomBytes(24).toString("hex")
  const [row] = await db
    .insert(temuStores)
    .values({
      enterpriseId,
      name: mallName,
      deviceToken,
      mallId,
      mallName,
    })
    .returning({ id: temuStores.id, name: temuStores.name })
  revalidatePath("/temu")
  return { ok: true, store: row, deviceToken }
}

export async function resetTemuStoreTokenAction(input: { id: string }): Promise<{ ok: true; deviceToken: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { id } = resetTemuStoreTokenSchema.parse(input)
  const deviceToken = randomBytes(24).toString("hex")
  const rows = await db
    .update(temuStores)
    .set({ deviceToken, updatedAt: sql`now()` })
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .returning({ id: temuStores.id })
  if (rows.length === 0) throw new Error("店铺不存在")
  revalidatePath("/temu")
  return { ok: true, deviceToken }
}

/** 编辑店铺名称 / mallId 绑定（插件多店巡检按 mallId 归属，改完插件侧自动同步） */
export async function updateTemuStoreAction(input: {
  id: string
  name?: string
  mallId?: string | null
  mallName?: string | null
}) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const data = updateTemuStoreSchema.parse(input)
  const { id, ...patch } = data
  const set: Record<string, unknown> = { updatedAt: sql`now()` }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.mallId !== undefined) set.mallId = patch.mallId || null
  if (patch.mallName !== undefined) set.mallName = patch.mallName || null
  const rows = await db
    .update(temuStores)
    .set(set)
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .returning({ id: temuStores.id })
  if (rows.length === 0) throw new Error("店铺不存在")
  revalidatePath("/temu")
  return { ok: true }
}

export async function toggleTemuStoreAction(input: { id: string; enabled: boolean }) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { id, enabled } = toggleTemuStoreSchema.parse(input)
  const rows = await db
    .update(temuStores)
    .set({ enabled, updatedAt: sql`now()` })
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .returning({ id: temuStores.id })
  if (rows.length === 0) throw new Error("店铺不存在")
  revalidatePath("/temu")
  return { ok: true }
}

export async function deleteTemuStoreAction(input: { id: string }) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { id } = deleteTemuStoreSchema.parse(input)
  const rows = await db
    .delete(temuStores)
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .returning({ id: temuStores.id })
  if (rows.length === 0) throw new Error("店铺不存在")
  revalidatePath("/temu")
  return { ok: true }
}

/**
 * 清空单店全部采集数据（保留店铺本身、token 与发现记录）：用于重新采集测试。
 * 注意：插件端整页去重缓存在 Service Worker 内存中，空闲约 30 秒随 SW 休眠
 * 自动重置——清空后稍候（或重启浏览器）再触发采集，即可全量重新入库。
 */
export async function clearTemuStoreDataAction(input: { id: string }) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { id } = deleteTemuStoreSchema.parse(input)
  const owned = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .limit(1)
  if (owned.length === 0) throw new Error("店铺不存在")
  const counts: Record<string, number> = {}
  await db.transaction(async (tx) => {
    counts["temu_metric_snapshot"] = (
      await tx.delete(temuMetricSnapshots).where(eq(temuMetricSnapshots.storeId, id)).returning({ id: temuMetricSnapshots.id })
    ).length
    counts["temu_sales_overview"] = (
      await tx.delete(temuSalesOverviews).where(eq(temuSalesOverviews.storeId, id)).returning({ id: temuSalesOverviews.id })
    ).length
    counts["temu_product"] = (
      await tx.delete(temuProducts).where(eq(temuProducts.storeId, id)).returning({ id: temuProducts.id })
    ).length
    counts["temu_product_flow"] = (
      await tx.delete(temuProductFlows).where(eq(temuProductFlows.storeId, id)).returning({ id: temuProductFlows.id })
    ).length
    counts["temu_product_ads"] = (
      await tx.delete(temuProductAds).where(eq(temuProductAds.storeId, id)).returning({ id: temuProductAds.id })
    ).length
    counts["temu_ads_daily"] = (
      await tx.delete(temuAdsDailies).where(eq(temuAdsDailies.storeId, id)).returning({ id: temuAdsDailies.id })
    ).length
    counts["temu_sku_sales_daily"] = (
      await tx.delete(temuSkuSalesDailies).where(eq(temuSkuSalesDailies.storeId, id)).returning({ id: temuSkuSalesDailies.id })
    ).length
    counts["temu_sku_map"] = (
      await tx.delete(temuSkuMaps).where(eq(temuSkuMaps.storeId, id)).returning({ id: temuSkuMaps.id })
    ).length
    counts["temu_activity"] = (
      await tx.delete(temuActivities).where(eq(temuActivities.storeId, id)).returning({ id: temuActivities.id })
    ).length
    counts["temu_ingest_log"] = (
      await tx.delete(temuIngestLogs).where(eq(temuIngestLogs.storeId, id)).returning({ id: temuIngestLogs.id })
    ).length
  })
  revalidatePath("/temu")
  return { ok: true, counts }
}

// ---------- 内部 ----------

/** 企业 → 店铺 id 列表（store 过滤可选；店铺管理双层隔离的锚点） */
async function resolveStoreIds(enterpriseId: string, storeId?: string): Promise<string[]> {
  const conds = [eq(temuStores.enterpriseId, enterpriseId)]
  if (storeId) conds.push(eq(temuStores.id, storeId))
  const rows = await db.select({ id: temuStores.id }).from(temuStores).where(and(...conds))
  return rows.map((r) => r.id)
}
