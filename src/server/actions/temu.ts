"use server"

import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { revalidatePath } from "next/cache"
import { db } from "@/db/client"
import {
  temuStores,
  temuMetricSnapshots,
  temuSalesOverviews,
  temuProducts,
  temuProductFlows,
  temuProductAds,
  temuAdsDailies,
  temuAdsProductDailies,
  temuSkuSalesDailies,
  temuSkuMaps,
  temuActivities,
  temuIngestLogs,
  type TemuSyncStatus,
} from "@/db/schema"
import {
  requireEnterpriseContext,
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { encrypt } from "@/lib/crypto"
import {
  createTemuStoreSchema,
  updateTemuStoreSchema,
  toggleTemuStoreSchema,
  toggleTemuStoreSyncSchema,
  deleteTemuStoreSchema,
} from "@/server/schemas/temu"
import { temuCached, invalidateTemuCache } from "@/server/services/temu-cache"
import { syncStore, verifyStoreToken } from "@/server/services/temu-sync"
import { TEMU_TZ, temuDayStr, temuStartOfToday, temuYesterdayStr } from "@/server/services/temu-time"

/**
 * TEMU 数据面板 Server Actions（手册 §6：查询 requireEnterpriseContext，
 * 写操作 requireEnterpriseAdmin；全部强制 getCurrentEnterpriseScope 企业隔离）
 */

// ---------- 查询 ----------

export interface TemuStoreBrief {
  id: string
  name: string
  mallId: string | null
  mallName: string | null
  enabled: boolean
  /** none=未录入 active=有效 invalid=已失效待重录 */
  tokenState: string
  /** full=全托 semi=半托（token 验证回写） */
  mallType: string | null
  tokenExpiresAt: Date | null
  syncEnabled: boolean
  lastSyncAt: Date | null
  lastSyncStatus: TemuSyncStatus | null
}

/** 店铺列表查询（action 与 overview 内部共用：省去重复鉴权与二次查询） */
function listStores(enterpriseId: string): Promise<TemuStoreBrief[]> {
  return db
    .select({
      id: temuStores.id,
      name: temuStores.name,
      mallId: temuStores.mallId,
      mallName: temuStores.mallName,
      enabled: temuStores.enabled,
      tokenState: temuStores.tokenState,
      mallType: temuStores.mallType,
      tokenExpiresAt: temuStores.tokenExpiresAt,
      syncEnabled: temuStores.syncEnabled,
      lastSyncAt: temuStores.lastSyncAt,
      lastSyncStatus: temuStores.lastSyncStatus,
    })
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, enterpriseId))
    .orderBy(asc(temuStores.sortOrder), asc(temuStores.createdAt))
}

/** 店铺列表（面板店铺筛选与管理页共用；按拖拽排序 sortOrder → 创建时间） */
export async function getTemuStoresAction(): Promise<TemuStoreBrief[]> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return listStores(enterpriseId)
}

/** 店铺拖拽排序入参：ids 全量 uuid 校验（非 uuid 值拼进 VALUES 会打爆
 *  Postgres 22P02，先收口为友好错误） */
const reorderTemuStoresSchema = z.object({
  ids: z.array(z.string().uuid()).max(100),
})

/** 店铺拖拽排序（管理页行拖动，ids 为新顺序；企业隔离逐店校验） */
export async function reorderTemuStoresAction(input: { ids: string[] }) {
  const parsed = reorderTemuStoresSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const ids = parsed.data.ids
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  if (ids.length > 0) {
    // 单条 UPDATE ... FROM (VALUES) 批量写入全部新序（替代逐店 N 次往返）；
    // WHERE enterprise_id 保持企业隔离——他店 id 不命中即静默跳过（与原逐条行为一致）
    const values = sql.join(
      ids.map((id, i) => sql`(${id}::uuid, ${i}::int)`),
      sql`, `,
    )
    await db.execute(sql`
      UPDATE ${temuStores}
      SET sort_order = data.seq, updated_at = now()
      FROM (VALUES ${values}) AS data(id, seq)
      WHERE ${temuStores}.id = data.id AND ${temuStores}.enterprise_id = ${enterpriseId}
    `)
  }
  invalidateTemuCache(enterpriseId)
  revalidatePath("/temu")
  return { ok: true }
}

export interface TemuOverview {
  /** 最新销售汇总（今日/7日/30日销量，销售管理口径 SKC 求和） */
  latest: Record<string, number | null>
  /** 近 N 天每日销售汇总（趋势图，本地日；saleVolume=今日销量，sevenDays=七日滚动销量） */
  trend: { date: string; saleVolume: number | null; sevenDays: number | null }[]
  /** 商品总数（temu_product 当前态） */
  productCount: number
  /** 售罄预警（最新售罄快照：插件 soldout-overview / 官方 api-soldout） */
  soldout: Record<string, number | null>
  /** 各店铺（含 token 状态与最近同步时间） */
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
  return temuCached(`${enterpriseId}:${storeId ?? "all"}:overview`, () =>
    loadTemuOverview(enterpriseId, storeId),
  )
}

async function loadTemuOverview(enterpriseId: string, storeId?: string): Promise<TemuOverview> {
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  const stores = await listStores(enterpriseId)
  const empty: TemuOverview = {
    latest: {}, trend: [], productCount: 0, soldout: {}, stores,
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
  // 日界取北京时间（Temu 卖家中心口径；服务器容器时区不参与分日）
  const tz = TEMU_TZ

  const [trendAgg, productCountRows, soldoutRows, adsRows] = await Promise.all([
    // 销售管理口径按日聚合：每 (店, 日, 批次 capturedAt) 先对 SKC 求和，再每
    // (店, 日) 取最新批次（官方 API 每轮同步一个 capturedAt；插件历史行按
    // 上报时间），最后跨店求和成当日合计。sum 忽略 null、全 null 得 null。
    db.execute<{
      day: string
      saleVolume: number | null
      sevenDays: number | null
      thirtyDays: number | null
    }>(sql`
      WITH batch AS (
        SELECT store_id, (captured_at AT TIME ZONE ${tz})::date AS day, captured_at,
               sum(today_sales_volume)::int AS today_sum,
               sum(last7_days_sales_volume)::int AS seven_sum,
               sum(last30_days_sales_volume)::int AS thirty_sum
        FROM ${temuSalesOverviews}
        WHERE store_id IN (${sql.join(storeIds.map((id) => sql`${id}::uuid`), sql`, `)})
          AND captured_at >= ${since.toISOString()}::timestamptz
        GROUP BY store_id, day, captured_at
      ),
      latest AS (
        SELECT DISTINCT ON (store_id, day) store_id, day, today_sum, seven_sum, thirty_sum
        FROM batch
        ORDER BY store_id, day, captured_at DESC
      )
      SELECT day::text AS day,
             sum(today_sum)::int AS "saleVolume",
             sum(seven_sum)::int AS "sevenDays",
             sum(thirty_sum)::int AS "thirtyDays"
      FROM latest
      GROUP BY day
      ORDER BY day
    `),
    db.select({ c: count() }).from(temuProducts).where(inArray(temuProducts.storeId, storeIds)),
    db
      .select()
      .from(temuMetricSnapshots)
      .where(
        and(
          inArray(temuMetricSnapshots.storeId, storeIds),
          inArray(temuMetricSnapshots.source, ["soldout-overview", "api-soldout"]),
        ),
      )
      .orderBy(desc(temuMetricSnapshots.capturedAt))
      .limit(1),
    // 广告日报（今日 + 昨日；官方广告 API mall.query 同步写入，每轮滚动覆盖）
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

  const byDay = new Map<
    string,
    { saleVolume: number | null; sevenDays: number | null; thirtyDays: number | null }
  >()
  for (const r of trendAgg) {
    byDay.set(r.day, {
      saleVolume: r.saleVolume,
      sevenDays: r.sevenDays,
      thirtyDays: r.thirtyDays,
    })
  }

  const todayStr = temuDayStr()
  const yesterdayStr = temuYesterdayStr()
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

  const soldout = soldoutRows[0]
  return {
    latest: {
      saleVolume: todaySnap?.saleVolume ?? null,
      sevenDaysSaleVolume: todaySnap?.sevenDays ?? null,
      thirtyDaysSaleVolume: todaySnap?.thirtyDays ?? null,
    },
    trend,
    productCount: productCountRows[0]?.c ?? 0,
    soldout: soldout
      ? {
          todaySellOutNum: soldout.todaySellOutNum,
          todaySoonSellOutNum: soldout.todaySoonSellOutNum,
          increaseSellOutNum: soldout.increaseSellOutNum,
          alreadySoldOutNumber: soldout.alreadySoldOutNumber,
        }
      : {},
    stores,
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
  /** 在售站点列表（goods-list 源 bindSites 拼接，如「US、EU」） */
  siteNames: string | null
  skcCreatedAt: number | null
  addedSiteAt: number | null
  mallName: string | null
  /** 归属店铺名（展开面板「其他信息」展示） */
  storeName: string | null
  lastSeenAt: Date
}

/** 商品列表（分页 + SKC/SPU(goodsId/productId)/货号/商品名 模糊搜索 + 在售筛选 + 排序） */
export async function getTemuProductsAction(
  storeId: string | undefined,
  q: string | undefined,
  page: number,
  sale?: "on" | "off",
  sort?: string,
): Promise<{ rows: TemuProductRow[]; total: number }> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  // page/q 就地收口（对齐 temuListQuerySchema 口径 page 1~500、q≤100）：
  // page<1 会使 OFFSET 为负直接打爆 Postgres，超长 q 也不该全量进 ilike
  const safePage = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), 500)
  const safeQ = q?.slice(0, 100)
  return temuCached(
    `${enterpriseId}:products:${storeId ?? "all"}:${safeQ ?? ""}:${sale ?? ""}:${sort ?? "listed"}:${safePage}`,
    () => loadTemuProducts(enterpriseId, storeId, safeQ, safePage, sale, sort),
  )
}

async function loadTemuProducts(
  enterpriseId: string,
  storeId: string | undefined,
  q: string | undefined,
  page: number,
  sale?: "on" | "off",
  sort?: string,
): Promise<{ rows: TemuProductRow[]; total: number }> {
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
    // 在售：官方 API skcSiteStatus=1（实测 1=在售且 100% 落在销售管理数据内）；
    // 11 为插件历史口径，一并兼容
    conds.push(sql`${temuProducts.skcStatus} in (1, 11)`)
  } else if (sale === "off") {
    // 未上架 = 非在售（0 未发布到站点 / null 未知 / 其他码）
    conds.push(
      sql`(${temuProducts.skcStatus} is null or ${temuProducts.skcStatus} not in (1, 11))`,
    )
  }

  // 排序口径归一（未知值回落默认）
  const sortKey =
    sort === "today" || sort === "last7" || sort === "sn" ? sort : "listed"
  // 销量排序的关联子查询：每 SKC 取最新数据日行（跨店同款罕见，取其一即可）
  const salesSortSq =
    sortKey === "today" || sortKey === "last7"
      ? db
          .selectDistinctOn([temuSalesOverviews.skcId], {
            skcId: temuSalesOverviews.skcId,
            todaySalesVolume: temuSalesOverviews.todaySalesVolume,
            last7DaysSalesVolume: temuSalesOverviews.last7DaysSalesVolume,
          })
          .from(temuSalesOverviews)
          .where(inArray(temuSalesOverviews.storeId, storeIds))
          .orderBy(temuSalesOverviews.skcId, desc(temuSalesOverviews.capturedDay))
          .as("sales_sort")
      : undefined

  // 排序口径（用户选定）：上架时间默认新→旧；销量高→低；货号 B 后数字
  // 自然序小→大且空值最上；末级统一 lastSeenAt 保持翻页稳定
  const orderBy =
    sortKey === "today"
      ? [
          desc(sql`coalesce(${salesSortSq!.todaySalesVolume}, 0)`),
          desc(temuProducts.lastSeenAt),
        ]
      : sortKey === "last7"
        ? [
            desc(sql`coalesce(${salesSortSq!.last7DaysSalesVolume}, 0)`),
            desc(temuProducts.lastSeenAt),
          ]
        : sortKey === "sn"
          ? [
              // 空值（null/''）最上：空为 true，desc 让 true 组在前
              sql`(${temuProducts.productSn} is null or ${temuProducts.productSn} = '') desc`,
              // B 后数字自然序（提取首段数字）；无数字与空值同组靠前
              sql`nullif(substring(${temuProducts.productSn} from '[0-9]+'), '')::numeric asc nulls first`,
              asc(temuProducts.productSn),
              desc(temuProducts.lastSeenAt),
            ]
          : [
              // 默认：上架时间新→旧（skcCreatedAt 为毫秒时间戳）
              desc(sql`coalesce(${temuProducts.skcCreatedAt}, 0)`),
              desc(temuProducts.lastSeenAt),
            ]

  const productCols = {
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
    siteNames: temuProducts.siteNames,
    skcCreatedAt: temuProducts.skcCreatedAt,
    addedSiteAt: temuProducts.addedSiteAt,
    mallName: sql<string | null>`${temuProducts.mallMeta}->'mallNames'->>0`,
    storeName: temuStores.name,
    lastSeenAt: temuProducts.lastSeenAt,
  }

  // 归属店铺名恒关联；销量排序才额外关联销售行（$dynamic 按需挂 join）
  let rowsQuery = db
    .select(productCols)
    .from(temuProducts)
    .leftJoin(temuStores, eq(temuStores.id, temuProducts.storeId))
    .$dynamic()
  if (salesSortSq) {
    rowsQuery = rowsQuery.leftJoin(salesSortSq, eq(salesSortSq.skcId, temuProducts.productSkcId))
  }

  const [rows, totalRows] = await Promise.all([
    rowsQuery
      .where(and(...conds))
      .orderBy(...orderBy)
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
  sort?: string,
): Promise<{ rows: TemuProductRow[]; salesInfo: TemuProductSalesInfo }> {
  const { rows } = await getTemuProductsAction(storeId, q, page, sale, sort)
  const salesInfo = await getTemuProductSalesInfoAction(
    storeId,
    rows.map((r) => r.productSkcId),
  )
  return { rows, salesInfo }
}

// ---------- 销售概览统计（类目占比 / TOP 榜 / 广告效果 / 转化漏斗） ----------

/** 当日零点（北京时间）：日口径指标只认当日捕获的行——Temu 日界是 CST，
 *  服务器容器多为 UTC，用本地零点会把 CST 00-08 点的采集排除在"今日"外 */
function startOfToday(): Date {
  return temuStartOfToday()
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
  return temuCached(`${enterpriseId}:${storeId ?? "all"}:cat-share`, () =>
    loadTemuCategoryShare(enterpriseId, storeId),
  )
}

async function loadTemuCategoryShare(enterpriseId: string, storeId?: string): Promise<TemuCategoryShare[]> {
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

/** 售出 TOP 榜：每 SKC 聚合后取 今日/近7日/近30日 三口径各自前 60 的并集
 *  （前端按口径重排取 10——只按单一口径预筛会漏其他口径的真实前十，已实测） */
export async function getTemuSalesTopAction(storeId?: string): Promise<TemuSalesTopRow[]> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return temuCached(`${enterpriseId}:${storeId ?? "all"}:sales-top`, () =>
    loadTemuSalesTop(enterpriseId, storeId),
  )
}

async function loadTemuSalesTop(enterpriseId: string, storeId?: string): Promise<TemuSalesTopRow[]> {
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
  const mapped = rows.map((r) => ({
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
  // 三口径各自 top60 并集（去重）；返回序按近7日降序，前端会按所选口径重排
  const byMetric = (key: "todaySalesVolume" | "last7DaysSalesVolume" | "last30DaysSalesVolume") =>
    [...mapped].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 60)
  const union = new Map<string, (typeof mapped)[number]>()
  for (const r of [...byMetric("todaySalesVolume"), ...byMetric("last7DaysSalesVolume"), ...byMetric("last30DaysSalesVolume")]) {
    union.set(r.skcId, r)
  }
  return [...union.values()].sort((a, b) => b.last7DaysSalesVolume - a.last7DaysSalesVolume)
}

/** SKU 明细行（salesv2 skuQuantityDetailList 原样字段，前端防御性取值） */
export interface TemuSkuDetailRow {
  productSkuId?: number | string | null
  skuExtCode?: string | null
  className?: string | null
  todaySaleVolume?: number | null
  lastSevenDaysSaleVolume?: number | null
  lastThirtyDaysSaleVolume?: number | null
  totalSaleVolume?: number | null
  supplierPrice?: number | null
  availableSaleDays?: number | string | null
  lackQuantity?: number | null
  inCartNumber7d?: number | null
  inCardNumber?: number | null
  stockDays?: number | null
  safeInventoryDays?: number | null
  canPurchase?: boolean | null
  priceReviewStatus?: number | null
  isVerifyPrice?: boolean | null
  /** 仓组名 / 备货配置（salesv2 SKU 行内，实测 100% 返回；展开面板其他信息组） */
  warehouseGroupName?: string | null
  purchaseConfig?: string | null
  /** 细分库存（文档标 SKC 级，实测返回在 SKU 级行内） */
  inventoryNumInfo?: TemuInventoryInfo | null
}

/** 细分库存（salesv2 inventoryNumInfo，官方 7 项口径） */
export interface TemuInventoryInfo {
  waitOnShelfNum?: number | null
  waitApproveInventoryNum?: number | null
  waitInStock?: number | null
  waitReceiveNum?: number | null
  waitDeliveryInventoryNum?: number | null
  waitQcNum?: number | null
  unavailableWarehouseInventoryNum?: number | null
}

/** SKC 级核价聚合（真实数据中两字段暂无区分度，仅透传待校准） */
export interface TemuPriceReview {
  /** 任一 SKU isVerifyPrice=true */
  verified: boolean
  /** 首个非空 priceReviewStatus 原始码 */
  reviewStatus: number | null
}

/** 商品信息展开面板字段（来自最新销售批次 overview + SKU 明细聚合） */
export interface TemuProductDetailExtra {
  last7DaysSalesVolume: number | null
  last30DaysSalesVolume: number | null
  isFirst: boolean
  /** 加入站点时长（天） */
  onSalesDurationDays: number | null
  inCartNumber7d: number | null
  inCardNumber: number | null
  inventoryInfo: TemuInventoryInfo | null
  stockDays: number | null
  canPurchase: boolean
  illegalReason: string | null
  /** 1 未完成 / 2 已完成 */
  pictureAuditStatus: number | null
  priceReview: TemuPriceReview
}

export interface TemuProductSalesInfo {
  /** 销售管理最新批次：skcId → 今日销量/仓内可用/已发货/可售天数/热销标记/SKU 明细/展开面板字段（跨店求和，天数取最大） */
  latest: Record<
    string,
    {
      todaySalesVolume: number | null
      warehouseAvailableStock: number | null
      shippedStock: number | null
      availableSaleDays: number | null
      /** 热销款（salesv2 hotTag，任一店为热销即标记） */
      hotTag: boolean
      /** SKU 级明细（最新批次 priceDetail，跨店时取最新店的整份） */
      skus: TemuSkuDetailRow[]
      /** 展开面板字段（overview + SKU 明细聚合） */
      extra: TemuProductDetailExtra
      /** 叶子类目（salesv2 category；goods-list 的 leafCat 实测官方不返回，
       *  展开面板类目路径的叶子来源） */
      leafCategory: string | null
    }
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
  // 键含 SKC 清单（排序后拼接）：同页刷新命中，翻页换清单不串
  const ids = (skcIds || []).map(String).filter(Boolean).slice(0, 50).sort()
  return temuCached(`${enterpriseId}:sales-info:${storeId ?? "all"}:${ids.join(",")}`, () =>
    loadTemuProductSalesInfo(enterpriseId, storeId, ids),
  )
}

async function loadTemuProductSalesInfo(
  enterpriseId: string,
  storeId: string | undefined,
  ids: string[],
): Promise<TemuProductSalesInfo> {
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
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
      priceDetail: temuSalesOverviews.priceDetail,
      overview: temuSalesOverviews.overview,
      category: temuSalesOverviews.category,
      hotFlag: sql<boolean>`(${temuSalesOverviews.overview} ->> 'hotTag') = 'true'`.as("hotFlag"),
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
        hotTag: sql<boolean>`bool_or(${latestSq.hotFlag})`,
        // 跨店同 SKC 时取最新批次所在店的整份 SKU 明细与 overview
        priceDetail: sql<TemuSkuDetailRow[] | null>`(array_agg(${latestSq.priceDetail} order by ${latestSq.capturedAt} desc))[1]`,
        overview: sql<Record<string, unknown> | null>`(array_agg(${latestSq.overview} order by ${latestSq.capturedAt} desc))[1]`,
        category: sql<string | null>`(array_agg(${latestSq.category} order by ${latestSq.capturedAt} desc) filter (where ${latestSq.category} is not null))[1]`,
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
  // SKU 级申报价（price.list.get 回填的 sku_map 列）：salesv2 SKU 明细的
  // supplierPrice 实测已不返回，展开子表价格由此合并
  const priceSkuIds = [
    ...new Set(
      latestRows.flatMap((r) =>
        (Array.isArray(r.priceDetail) ? r.priceDetail : [])
          .map((s) => (s.productSkuId != null ? String(s.productSkuId) : null))
          .filter((v): v is string => !!v),
      ),
    ),
  ]
  const skuPriceMap = new Map<string, number>()
  if (priceSkuIds.length > 0) {
    const priceRows = await db
      .select({ skuId: temuSkuMaps.skuId, supplierPrice: temuSkuMaps.supplierPrice })
      .from(temuSkuMaps)
      .where(
        and(inArray(temuSkuMaps.storeId, storeIds), inArray(temuSkuMaps.skuId, priceSkuIds)),
      )
    for (const p of priceRows) {
      if (p.supplierPrice != null) skuPriceMap.set(p.skuId, p.supplierPrice)
    }
  }
  for (const r of latestRows) {
    const skus = (Array.isArray(r.priceDetail) ? r.priceDetail : []).map((s) => ({
      ...s,
      supplierPrice: s.supplierPrice ?? (s.productSkuId != null ? skuPriceMap.get(String(s.productSkuId)) ?? null : null),
    }))
    const ov = r.overview ?? {}
    const numOv = (k: string): number | null => {
      const v = ov[k]
      return typeof v === "number" && Number.isFinite(v) ? v : null
    }
    const sumSku = (pick: (s: TemuSkuDetailRow) => number | null | undefined) =>
      skus.reduce((acc, s) => acc + (pick(s) ?? 0), 0)
    const inv = (ov.inventoryNumInfo ?? null) as TemuInventoryInfo | null
    // 细分库存实测随 SKU 行返回（SKC 级 overview 不带）：跨 SKU 求和为 SKC 口径；
    // 七类恒定齐全（无值补 0），供库存数据悬停逐类换行展示
    const invKeys: Array<keyof TemuInventoryInfo> = [
      "waitOnShelfNum",
      "waitApproveInventoryNum",
      "waitInStock",
      "waitReceiveNum",
      "waitDeliveryInventoryNum",
      "waitQcNum",
      "unavailableWarehouseInventoryNum",
    ]
    const invAgg: TemuInventoryInfo = {}
    let hasInv = false
    for (const k of invKeys) {
      const total = skus.reduce((acc, s) => acc + (s.inventoryNumInfo?.[k] ?? 0), 0)
      invAgg[k] = total
      if (total > 0) hasInv = true
    }
    const stockDays =
      skus.find((s) => s.stockDays != null)?.stockDays ??
      skus.find((s) => s.safeInventoryDays != null)?.safeInventoryDays ??
      null
    latest[r.skcId] = {
      todaySalesVolume: Number(r.todaySalesVolume),
      warehouseAvailableStock: Number(r.warehouseAvailableStock),
      shippedStock: Number(r.shippedStock),
      availableSaleDays: r.availableSaleDays != null ? Number(r.availableSaleDays) : null,
      hotTag: r.hotTag === true,
      skus,
      leafCategory: r.category?.trim() || null,
      extra: {
        last7DaysSalesVolume: sumSku((s) => s.lastSevenDaysSaleVolume),
        last30DaysSalesVolume: sumSku((s) => s.lastThirtyDaysSaleVolume),
        isFirst: ov.isFirst === true,
        onSalesDurationDays: numOv("onSalesDurationOffline"),
        inCartNumber7d: sumSku((s) => s.inCartNumber7d),
        inCardNumber: sumSku((s) => s.inCardNumber),
        inventoryInfo: hasInv ? invAgg : (inv && typeof inv === "object" ? inv : null),
        stockDays,
        canPurchase: skus.some((s) => s.canPurchase === true),
        illegalReason:
          typeof ov.illegalReason === "string" && ov.illegalReason.trim() !== ""
            ? ov.illegalReason.slice(0, 200)
            : null,
        pictureAuditStatus: numOv("pictureAuditStatus"),
        priceReview: {
          verified: skus.some((s) => s.isVerifyPrice === true),
          reviewStatus: skus.find((s) => s.priceReviewStatus != null)?.priceReviewStatus ?? null,
        },
      },
    }
  }

  // 快照推算序列：分日分店取最后批次，再按日跨店求和（多店视图口径一致）。
  // （曾有 temu_sku_sales_daily「直采」表优先分支——该表自插件下线后无任何写入方、
  //  存量止于 2026-09-16，直采优先会让在售 SKC 拿到陈旧/空序列，2026-10-22 移除）
  const dayStoreLatest = new Map<string, { ts: number; vol: number }>()
  for (const r of historyRows) {
    const day = new Date(r.capturedAt).toLocaleDateString("sv-SE", { timeZone: TEMU_TZ })
    const key = `${r.skcId}|${day}|${r.storeId}`
    const prev = dayStoreLatest.get(key)
    const ts = r.capturedAt.getTime()
    if (prev && prev.ts >= ts) continue
    dayStoreLatest.set(key, { ts, vol: r.todaySalesVolume ?? 0 })
  }
  const series: TemuProductSalesInfo["series"] = {}
  for (const [key, v] of dayStoreLatest) {
    const [skcId, day] = key.split("|")
    const list = series[skcId] || (series[skcId] = [])
    const existing = list.find((p) => p.day === day)
    if (existing) existing.value += v.vol
    else list.push({ day, value: v.vol })
  }
  for (const list of Object.values(series)) {
    list.sort((a, b) => (a.day < b.day ? -1 : 1))
  }
  return { latest, series }
}

export interface TemuAdsRow {
  /** 货品 id（官方报表商品维度） */
  productId: string
  productSkcId: string | null
  productSn: string | null
  productName: string | null
  mainImageUrl: string | null
  /** 花费（分，ad 推广维度，窗口内求和） */
  adSpend: number | null
  /** 申报价销售额（分，ad 推广维度） */
  orderPayAmt: number | null
  /** ROAS（窗口聚合：销售额÷花费；单行 roas 加总无意义） */
  roas: number | null
  /** 每笔成交花费（分，窗口聚合） */
  transactionCost: number | null
  goodsNum: number | null
  imprCnt: number | null
  clkCnt: number | null
  orderPayCnt: number | null
}

/** 广告商品日报（官方 goods.query 聚合：各商品窗口内求和） */
export interface TemuAdsCards {
  /** 总花费（元） */
  totalSpend: number | null
  /** 申报价销售额（推广维度，元） */
  salesAmount: number | null
  /** 投资回报率 ROAS */
  roas: number | null
  /** 每笔订单成交花费（元） */
  costPerOrder: number | null
}

/** 广告推广 tab（官方 bg.glo.searchrec.ad.reports.* 同步的日报数据） */
export async function getTemuAdsAction(
  storeId?: string,
  range?: number,
): Promise<{
  rows: TemuAdsRow[]
  cards: TemuAdsCards
  range: number
  /** 数据截至日（日报最新日期；null = 窗口内无数据） */
  dataThrough: string | null
}> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const days = range === 30 ? 30 : 7
  return temuCached(`${enterpriseId}:${storeId ?? "all"}:ads:v2:${days}`, () =>
    loadTemuAds(enterpriseId, storeId, days),
  )
}

async function loadTemuAds(enterpriseId: string, storeId?: string, range = 7) {
  const emptyCards: TemuAdsCards = { totalSpend: null, salesAmount: null, roas: null, costPerOrder: null }
  const storeIds = await resolveStoreIds(enterpriseId, storeId)
  if (storeIds.length === 0) {
    return { rows: [] as TemuAdsRow[], cards: emptyCards, range, dataThrough: null }
  }
  // 窗口按北京时间日界（与同步入库同口径），列出精确日期 inArray 匹配
  const dayStr = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: TEMU_TZ })
  const window = Array.from({ length: range }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (range - 1 - i))
    return dayStr(d)
  })

  // —— 商品级：窗口内按商品求和（分口径），花费降序取前 100 ——
  const aggRows = await db
    .select({
      productId: temuAdsProductDailies.productId,
      adSpend: sql<string | null>`sum(${temuAdsProductDailies.adSpend})`,
      orderPayAmt: sql<string | null>`sum(${temuAdsProductDailies.orderPayAmt})`,
      goodsNum: sql<string | null>`sum(${temuAdsProductDailies.goodsNum})`,
      imprCnt: sql<string | null>`sum(${temuAdsProductDailies.imprCnt})`,
      clkCnt: sql<string | null>`sum(${temuAdsProductDailies.clkCnt})`,
      orderPayCnt: sql<string | null>`sum(${temuAdsProductDailies.orderPayCnt})`,
    })
    .from(temuAdsProductDailies)
    .where(
      and(
        inArray(temuAdsProductDailies.storeId, storeIds),
        inArray(temuAdsProductDailies.date, window),
      ),
    )
    .groupBy(temuAdsProductDailies.productId)
    .orderBy(desc(sql`sum(${temuAdsProductDailies.adSpend})`))
    .limit(100)

  // 商品信息（名称/主图/货号/SKC）应用层合并：productId → temu_product 反查
  const productIds = aggRows.map((r) => r.productId)
  const productRows = productIds.length
    ? await db
        .select({
          storeId: temuProducts.storeId,
          productId: temuProducts.productId,
          productSkcId: temuProducts.productSkcId,
          productSn: temuProducts.productSn,
          productName: temuProducts.productName,
          mainImageUrl: temuProducts.mainImageUrl,
        })
        .from(temuProducts)
        .where(
          and(
            inArray(temuProducts.storeId, storeIds),
            inArray(temuProducts.productId, productIds),
          ),
        )
    : []
  const productBy = new Map<string, (typeof productRows)[number]>()
  for (const p of productRows) {
    if (!p.productId) continue
    const cur = productBy.get(p.productId)
    // 同 productId 多 SKC：优先保留带主图/货号的行
    if (!cur || ((!cur.mainImageUrl || !cur.productSn) && p.mainImageUrl && p.productSn)) {
      productBy.set(p.productId, p)
    }
  }

  const rows: TemuAdsRow[] = aggRows.map((r) => {
    const p = productBy.get(r.productId)
    const adSpend = r.adSpend != null ? Number(r.adSpend) : null
    const orderPayAmt = r.orderPayAmt != null ? Number(r.orderPayAmt) : null
    const orders = r.orderPayCnt != null ? Number(r.orderPayCnt) : null
    return {
      productId: r.productId,
      productSkcId: p?.productSkcId ?? null,
      productSn: p?.productSn ?? null,
      productName: p?.productName ?? null,
      mainImageUrl: p?.mainImageUrl ?? null,
      adSpend,
      orderPayAmt,
      roas: adSpend != null && adSpend > 0 && orderPayAmt != null
        ? Math.round((orderPayAmt / adSpend) * 100) / 100
        : null,
      transactionCost: adSpend != null && orders != null && orders > 0 ? adSpend / orders : null,
      goodsNum: r.goodsNum != null ? Number(r.goodsNum) : null,
      imprCnt: r.imprCnt != null ? Number(r.imprCnt) : null,
      clkCnt: r.clkCnt != null ? Number(r.clkCnt) : null,
      orderPayCnt: orders,
    }
  })

  // —— 大盘卡：店铺级日报（temu_ads_daily，元口径）优先，无行时商品级聚合兜底 ——
  const mallRows = await db
    .select({
      date: temuAdsDailies.date,
      adSpend: sql<string | null>`sum(${temuAdsDailies.adSpend})`,
      gmv: sql<string | null>`sum(${temuAdsDailies.gmv})`,
      orders: sql<string | null>`sum(${temuAdsDailies.orders})`,
    })
    .from(temuAdsDailies)
    .where(and(inArray(temuAdsDailies.storeId, storeIds), inArray(temuAdsDailies.date, window)))
    .groupBy(temuAdsDailies.date)

  let cards: TemuAdsCards = emptyCards
  if (mallRows.length > 0) {
    const spend = mallRows.reduce((s, r) => s + Number(r.adSpend ?? 0), 0)
    const gmv = mallRows.reduce((s, r) => s + Number(r.gmv ?? 0), 0)
    const orders = mallRows.reduce((s, r) => s + Number(r.orders ?? 0), 0)
    cards = {
      totalSpend: Math.round(spend * 100) / 100,
      salesAmount: Math.round(gmv * 100) / 100,
      roas: spend > 0 ? Math.round((gmv / spend) * 100) / 100 : null,
      costPerOrder: orders > 0 ? Math.round((spend / orders) * 100) / 100 : null,
    }
  } else if (rows.length > 0) {
    const spendFen = rows.reduce((s, r) => s + (r.adSpend ?? 0), 0)
    const gmvFen = rows.reduce((s, r) => s + (r.orderPayAmt ?? 0), 0)
    const orders = rows.reduce((s, r) => s + (r.orderPayCnt ?? 0), 0)
    cards = {
      totalSpend: Math.round(spendFen) / 100,
      salesAmount: Math.round(gmvFen) / 100,
      roas: spendFen > 0 ? Math.round((gmvFen / spendFen) * 100) / 100 : null,
      costPerOrder: orders > 0 ? Math.round(spendFen / orders) / 100 : null,
    }
  }

  const dates = mallRows.map((r) => String(r.date)).sort()
  return { rows, cards, range, dataThrough: dates.length > 0 ? dates[dates.length - 1] : null }
}

// ---------- 店铺管理（企业管理员） ----------

export async function createTemuStoreAction(input: {
  name: string
  mallId?: string
  mallName?: string
}): Promise<{ ok: true; store: { id: string; name: string } }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const data = createTemuStoreSchema.parse(input)
  const [row] = await db
    .insert(temuStores)
    .values({
      enterpriseId,
      name: data.name,
      mallId: data.mallId || null,
      mallName: data.mallName || null,
    })
    .returning({ id: temuStores.id, name: temuStores.name })
  invalidateTemuCache(enterpriseId)
  revalidatePath("/temu")
  return { ok: true, store: row }
}

/**
 * 录入/更新店铺 access_token（卖家中心授权页复制，自研应用 365 天有效）。
 * 保存后立刻调官方接口验证（bg.mall.info.get 判全托/半托），验证失败会回写
 * invalid 状态并把错误带回前端提示。
 */
export async function setTemuStoreTokenAction(input: {
  id: string
  accessToken: string
}): Promise<{ ok: boolean; error?: string; mallType?: "full" | "semi"; mallId?: string }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const id = String(input.id || "")
  const accessToken = String(input.accessToken || "").trim()
  if (!/^[0-9a-z]{32,128}$/i.test(accessToken)) {
    return { ok: false, error: "access_token 格式不正确（应为卖家中心复制的授权令牌）" }
  }
  const rows = await db
    .update(temuStores)
    .set({
      accessTokenEncrypted: encrypt(accessToken),
      tokenState: "active",
      tokenExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      updatedAt: sql`now()`,
    })
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .returning({ id: temuStores.id })
  if (rows.length === 0) throw new Error("店铺不存在")

  const verify = await verifyStoreToken(id)
  invalidateTemuCache(enterpriseId)
  revalidatePath("/temu")
  return verify
}

/** 手动触发单店同步（worker 15 分钟循环之外立即拉一次官方 API） */
export async function syncTemuStoreAction(
  input: { id: string },
): Promise<{ ok: boolean; skipped?: string; status?: TemuSyncStatus }> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const id = String(input.id || "")
  const owned = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .limit(1)
  if (owned.length === 0) throw new Error("店铺不存在")
  const outcome = await syncStore(id)
  revalidatePath("/temu")
  return {
    ok: !outcome.skipped && (outcome.status?.ok ?? true),
    skipped: outcome.skipped,
    status: outcome.status,
  }
}

/** 同步开关（关掉后不参与定时轮询，手动同步不受影响） */
export async function toggleTemuStoreSyncAction(input: { id: string; syncEnabled: boolean }) {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { id, syncEnabled } = toggleTemuStoreSyncSchema.parse(input)
  const rows = await db
    .update(temuStores)
    .set({ syncEnabled, updatedAt: sql`now()` })
    .where(and(eq(temuStores.id, id), eq(temuStores.enterpriseId, enterpriseId)))
    .returning({ id: temuStores.id })
  if (rows.length === 0) throw new Error("店铺不存在")
  invalidateTemuCache(enterpriseId)
  revalidatePath("/temu")
  return { ok: true }
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
  invalidateTemuCache(enterpriseId)
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
  invalidateTemuCache(enterpriseId)
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
  invalidateTemuCache(enterpriseId)
  revalidatePath("/temu")
  return { ok: true }
}

/**
 * 清空单店全部采集数据（保留店铺本身与 token）：用于重新同步验证。
 * 官方 API 定时同步会在下次轮询时全量重建数据。
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
    counts["temu_ads_product_daily"] = (
      await tx.delete(temuAdsProductDailies).where(eq(temuAdsProductDailies.storeId, id)).returning({ id: temuAdsProductDailies.id })
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
  invalidateTemuCache(enterpriseId)
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
