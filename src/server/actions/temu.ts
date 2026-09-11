"use server"

import { randomBytes } from "node:crypto"
import { and, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/db/client"
import {
  temuStores,
  temuMetricSnapshots,
  temuSalesOverviews,
  temuProducts,
  temuProductFlows,
  temuActivities,
} from "@/db/schema"
import {
  requireEnterpriseContext,
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import {
  createTemuStoreSchema,
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

/** 店铺列表（面板店铺筛选与管理页共用） */
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
    .orderBy(temuStores.createdAt)
  return rows
}

export interface TemuOverview {
  /** 最新大盘快照（今日/7日/30日销量、在售商品数等） */
  latest: Record<string, number | null>
  /** 近 N 天每日最新销量（趋势图，本地日） */
  trend: { date: string; saleVolume: number | null }[]
  /** 商品总数（temu_product 当前态） */
  productCount: number
  /** 售罄预警（最新 soldout 快照） */
  soldout: Record<string, number | null>
  /** 各店铺最后上报时间 */
  stores: TemuStoreBrief[]
}

export async function getTemuOverviewAction(storeId?: string): Promise<TemuOverview> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  const empty: TemuOverview = { latest: {}, trend: [], productCount: 0, soldout: {}, stores: await getTemuStoresAction() }
  if (storeIds.length === 0) return empty

  const since = new Date(Date.now() - 30 * 86400 * 1000)

  const [latestRows, trendRows, productCountRows, soldoutRows] = await Promise.all([
    db
      .select()
      .from(temuMetricSnapshots)
      .where(and(inArray(temuMetricSnapshots.storeId, storeIds), eq(temuMetricSnapshots.source, "dashboard-stats")))
      .orderBy(desc(temuMetricSnapshots.capturedAt))
      .limit(1),
    db
      .select({
        saleVolume: temuMetricSnapshots.saleVolume,
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
  ])

  // 每日取最后一条快照（按天分组覆盖）
  const byDay = new Map<string, number | null>()
  for (const r of trendRows) {
    const d = new Date(r.capturedAt).toLocaleDateString("sv-SE") // YYYY-MM-DD（本地时区）
    byDay.set(d, r.saleVolume)
  }

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
    trend: [...byDay.entries()].map(([date, saleVolume]) => ({ date, saleVolume })),
    productCount: productCountRows[0]?.c ?? 0,
    soldout: soldout
      ? {
          todaySellOutNum: soldout.todaySellOutNum,
          todaySoonSellOutNum: soldout.todaySoonSellOutNum,
          increaseSellOutNum: soldout.increaseSellOutNum,
        }
      : {},
    stores: await getTemuStoresAction(),
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
  skcCreatedAt: number | null
  addedSiteAt: number | null
  mallName: string | null
  lastSeenAt: Date
}

/** 商品列表（分页 + 名称/货号搜索） */
export async function getTemuProductsAction(
  storeId: string | undefined,
  q: string | undefined,
  page: number,
): Promise<{ rows: TemuProductRow[]; total: number }> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return { rows: [], total: 0 }

  const PAGE_SIZE = 20
  const conds = [inArray(temuProducts.storeId, storeIds)]
  if (q) {
    conds.push(
      sql`(${temuProducts.productName} ilike ${"%" + q + "%"} or ${temuProducts.productSn} ilike ${"%" + q + "%"})`,
    )
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
        skcCreatedAt: temuProducts.skcCreatedAt,
        addedSiteAt: temuProducts.addedSiteAt,
        mallName: sql<string | null>`${temuProducts.mallMeta}->'mallNames'->>0`,
        lastSeenAt: temuProducts.lastSeenAt,
      })
      .from(temuProducts)
      .where(and(...conds))
      .orderBy(desc(temuProducts.lastSeenAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ c: count() }).from(temuProducts).where(and(...conds)),
  ])
  return { rows, total: totalRows[0]?.c ?? 0 }
}

export interface TemuFlowRow {
  id: string
  goodsId: string
  goodsName: string | null
  category: string | null
  goodsImageUrl: string | null
  source: string
  capturedAt: Date
  exposeNum: number | null
  clickNum: number | null
  payGoodsNum: number | null
  payOrderNum: number | null
  buyerNum: number | null
  addToCartUserNum: number | null
  goodsDetailVisitNum: number | null
  searchExposeNum: number | null
  searchClickNum: number | null
  recommendExposeNum: number | null
  recommendClickNum: number | null
  metrics: Record<string, unknown> | null
}

/** 流量分析（最新一批 flux-analysis-goods 明细 + 增长计数标量） */
export async function getTemuFlowAction(storeId?: string): Promise<{
  rows: TemuFlowRow[]
  summary: Record<string, unknown>
}> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return { rows: [], summary: {} }

  // 各店铺各自最新一批快照：多店铺上报时刻互不相同，按店铺分别取最新
  // （此前全局取唯一最新 capturedAt 再精确匹配，其他店铺的数据永远选不中）
  const latestPerStore = await db
    .selectDistinctOn([temuProductFlows.storeId], {
      storeId: temuProductFlows.storeId,
      capturedAt: temuProductFlows.capturedAt,
    })
    .from(temuProductFlows)
    .where(
      and(
        inArray(temuProductFlows.storeId, storeIds),
        eq(temuProductFlows.source, "flux-analysis-goods"),
      ),
    )
    .orderBy(temuProductFlows.storeId, desc(temuProductFlows.capturedAt))
  if (latestPerStore.length === 0) return { rows: [], summary: {} }

  const rows = await db
    .select({
      id: temuProductFlows.id,
      goodsId: temuProductFlows.goodsId,
      goodsName: temuProductFlows.goodsName,
      category: temuProductFlows.category,
      goodsImageUrl: temuProductFlows.goodsImageUrl,
      source: temuProductFlows.source,
      capturedAt: temuProductFlows.capturedAt,
      exposeNum: temuProductFlows.exposeNum,
      clickNum: temuProductFlows.clickNum,
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
        eq(temuProductFlows.source, "flux-analysis-goods"),
        or(
          ...latestPerStore.map((p) =>
            and(
              eq(temuProductFlows.storeId, p.storeId),
              eq(temuProductFlows.capturedAt, p.capturedAt),
            ),
          ),
        ),
      ),
    )
    .orderBy(desc(temuProductFlows.exposeNum))
    .limit(100)

  // 增长计数标量在同源 metric 快照的 metrics jsonb 里（取全局最新一批
  // ——多店铺时为最近上报店铺的快照，v1 汇总口径）
  const [m] = await db
    .select({ metrics: temuMetricSnapshots.metrics })
    .from(temuMetricSnapshots)
    .where(and(inArray(temuMetricSnapshots.storeId, storeIds), eq(temuMetricSnapshots.source, "dashboard-stats")))
    .orderBy(desc(temuMetricSnapshots.capturedAt))
    .limit(1)

  return { rows, summary: (m?.metrics as Record<string, unknown>) ?? {} }
}

export interface TemuActivityRow {
  id: string
  source: string
  capturedAt: Date
  payload: Record<string, unknown> | null
}

/** 活动数据（宽前缀整包，按时间倒序） */
export async function getTemuActivityAction(storeId?: string): Promise<TemuActivityRow[]> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return []
  return db
    .select({
      id: temuActivities.id,
      source: temuActivities.source,
      capturedAt: temuActivities.capturedAt,
      payload: temuActivities.payload,
    })
    .from(temuActivities)
    .where(inArray(temuActivities.storeId, storeIds))
    .orderBy(desc(temuActivities.capturedAt))
    .limit(50)
}

/** 销售总览明细（各店铺各自最新一批 SKC 快照） */
export async function getTemuSalesOverviewAction(storeId?: string) {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) return []
  // 多店铺上报时刻互不相同：按店铺分别取最新（同 getTemuFlowAction）
  const latestPerStore = await db
    .selectDistinctOn([temuSalesOverviews.storeId], {
      storeId: temuSalesOverviews.storeId,
      capturedAt: temuSalesOverviews.capturedAt,
    })
    .from(temuSalesOverviews)
    .where(inArray(temuSalesOverviews.storeId, storeIds))
    .orderBy(temuSalesOverviews.storeId, desc(temuSalesOverviews.capturedAt))
  if (latestPerStore.length === 0) return []
  return db
    .select({
      id: temuSalesOverviews.id,
      skcId: temuSalesOverviews.skcId,
      productName: temuSalesOverviews.productName,
      category: temuSalesOverviews.category,
      supplierId: temuSalesOverviews.supplierId,
      capturedAt: temuSalesOverviews.capturedAt,
    })
    .from(temuSalesOverviews)
    .where(
      or(
        ...latestPerStore.map((p) =>
          and(
            eq(temuSalesOverviews.storeId, p.storeId),
            eq(temuSalesOverviews.capturedAt, p.capturedAt),
          ),
        ),
      ),
    )
    .limit(100)
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

// ---------- 内部 ----------

/** 企业 → 店铺 id 列表（store 过滤可选；店铺管理双层隔离的锚点） */
async function resolveStoreIds(enterpriseId: string, storeId?: string): Promise<string[]> {
  const conds = [eq(temuStores.enterpriseId, enterpriseId)]
  if (storeId) conds.push(eq(temuStores.id, storeId))
  const rows = await db.select({ id: temuStores.id }).from(temuStores).where(and(...conds))
  return rows.map((r) => r.id)
}
