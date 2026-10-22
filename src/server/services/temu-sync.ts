import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  temuAdsDailies,
  temuAdsProductDailies,
  temuIngestLogs,
  temuMetricSnapshots,
  temuProducts,
  temuSalesOverviews,
  temuSkuMaps,
  temuStores,
  type TemuSyncStatus,
} from "@/db/schema"
import { decrypt } from "@/lib/crypto"
import {
  callTemuApi,
  forEachTemuPage,
  isTemuTokenExpired,
  type TemuCallContext,
} from "@/lib/temu-api/client"
import { getTemuAppCredential } from "@/lib/temu-api/app-config"
import { invalidateTemuCache } from "@/server/services/temu-cache"
import { temuDayOfTs, temuDayStr } from "@/server/services/temu-time"

/**
 * TEMU 官方 API 数据同步
 *
 * 每店铺串行拉六源（3 qps 限速在 client 内）：
 * - api-goods-list      bg.glo.goods.list.get（PA）→ temu_product 基础信息
 * - api-lifecycle       bg.glo.product.search（PA）→ temu_product 选中状态 + SKU 映射
 * - api-sales-overview  bg.goods.salesv2.get（CN）→ temu_sales_overview 快照 + 标识/申报价回填
 * - api-soldout         bg.glo.goods.topselling.soldout.get（PA）→ temu_metric_snapshot
 * - api-price-list      bg.glo.goods.price.list.get（PA）→ SKC 级申报价全量回填
 * - api-ads-reports     bg.glo.searchrec.ad.reports.mall/goods.query（PA，全托）→ 广告日报两表
 *
 * 核价/调价/活动工作台为实时拉取（bg.price.review.* / bg.full.adjust.price.* /
 * bg.marketing.activity.*），不经本同步落库。
 *
 * 每源独立 try/catch 记 temu_ingest_log 与 lastSyncStatus；token 过期（7000007）
 * 直接中止并把店铺标记 invalid，等重新录入。
 */

/* ─── 小工具 ─── */

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

/** 标识提取：官方 API 的 id 是 INTEGER（也容忍字符串形态） */
function idStr(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v)).slice(0, max)
  return str(v, max)
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v)
  }
  return null
}

/** 可售天数字符串（"3.5"）→ 数值 */
function ratio(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n
}

function contentHashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/* ─── 各数据源 ─── */

type SourceResult = { ok: boolean; count?: number; error?: string }

/** bg.glo.goods.list.get（PA，page/pageSize≤100）→ temu_product 基础信息 */
async function syncGoodsList(storeId: string, ctx: TemuCallContext): Promise<number> {
  let accepted = 0
  await forEachTemuPage<{ data?: unknown[]; totalCount?: number }>(
    "bg.glo.goods.list.get",
    {},
    ctx,
    async (result, pageNo) => {
      const data = Array.isArray(result?.data) ? (result.data as Record<string, unknown>[]) : []
      accepted += await upsertGoodsBatch(storeId, data)
      return data.length >= 100 && pageNo < 500
    },
    { pageSize: 100, pageField: "page" },
  )
  return accepted
}

async function upsertGoodsBatch(storeId: string, items: Record<string, unknown>[]): Promise<number> {
  const bySkc = new Map<string, typeof temuProducts.$inferInsert>()
  const skuMapValues: { storeId: string; skuId: string; skcId: string }[] = []
  const seenSku = new Set<string>()

  for (const it of items) {
    const skcId = idStr(it.productSkcId, 32)
    if (!skcId) continue
    const cats = isRecord(it.categories) ? it.categories : {}
    const leaf = isRecord(cats.leafCat) ? str(cats.leafCat.catName, 120) : null
    const cat1 = isRecord(cats.cat1) ? str(cats.cat1.catName, 120) : null
    // goods.list.get 已不返回 bindSites（实测 100 行 0 命中）——site_names 不再
    // 由本源写入（存量列保留，替代源待官方确认）
    bySkc.set(skcId, {
      storeId,
      productSkcId: skcId,
      productId: idStr(it.productId, 32),
      productName: str(it.productName, 500),
      productSn: str(it.extCode, 64),
      mainImageUrl: str(it.mainImageUrl, 1000),
      category: leaf,
      leafCategoryName: leaf,
      cat1Name: cat1,
      // 站点状态（响应 skcSiteStatus；查询侧入参叫 skcTopStatus）
      skcStatus: num(it.skcSiteStatus),
      // 官方口径为上架时间（秒级时间戳可能性大，原样存档，前端按 ms 展示历史兼容）
      skcCreatedAt: num(it.createdAt),
      // SKU 概要（含虚拟库存）→ SKU↔SKC 映射
    })
    const skus = Array.isArray(it.productSkuSummaries)
      ? (it.productSkuSummaries as Record<string, unknown>[])
      : []
    for (const sku of skus) {
      const skuId = idStr(sku.productSkuId, 32)
      if (!skuId || seenSku.has(skuId)) continue
      seenSku.add(skuId)
      skuMapValues.push({ storeId, skuId, skcId })
    }
  }

  if (bySkc.size > 0) {
    // 只写本源字段（两源保护模式：不抹 sales/lifecycle 源先落的列）
    await db
      .insert(temuProducts)
      .values([...bySkc.values()])
      .onConflictDoUpdate({
        target: [temuProducts.storeId, temuProducts.productSkcId],
        set: {
          productId: sql`excluded.product_id`,
          productName: sql`excluded.product_name`,
          productSn: sql`excluded.product_sn`,
          mainImageUrl: sql`excluded.main_image_url`,
          category: sql`excluded.category`,
          leafCategoryName: sql`excluded.leaf_category_name`,
          cat1Name: sql`excluded.cat1_name`,
          skcStatus: sql`excluded.skc_status`,
          skcCreatedAt: sql`coalesce(excluded.skc_created_at, ${temuProducts.skcCreatedAt})`,
          lastSeenAt: sql`now()`,
        },
      })
  }
  if (skuMapValues.length > 0) {
    await db.insert(temuSkuMaps).values(skuMapValues).onConflictDoNothing()
  }
  return bySkc.size
}

/** bg.glo.product.search（PA，pageNum/pageSize≤100）→ 选中状态 + SKU 映射 */
async function syncLifecycle(storeId: string, ctx: TemuCallContext): Promise<number> {
  let touched = 0
  await forEachTemuPage<{ dataList?: unknown[]; total?: number }>(
    "bg.glo.product.search",
    {},
    ctx,
    async (result, pageNo) => {
      const list = Array.isArray(result?.dataList)
        ? (result.dataList as Record<string, unknown>[])
        : []
      touched += await upsertLifecycleBatch(storeId, list)
      return list.length >= 100 && pageNo < 500
    },
    { pageSize: 100, pageField: "pageNum" },
  )
  return touched
}

async function upsertLifecycleBatch(storeId: string, items: Record<string, unknown>[]): Promise<number> {
  const rows: (typeof temuProducts.$inferInsert)[] = []
  const skuMapValues: { storeId: string; skuId: string; skcId: string }[] = []
  const seenSku = new Set<string>()

  for (const it of items) {
    const productId = idStr(it.productId, 32)
    const skcList = Array.isArray(it.skcList) ? (it.skcList as Record<string, unknown>[]) : []
    for (const skc of skcList) {
      const skcId = idStr(skc.skcId, 32)
      if (!skcId) continue
      const selectStatus = num(skc.selectStatus)
      rows.push({
        storeId,
        productSkcId: skcId,
        productId,
        // selectStatus：平台「选中」语义（核价通过被选中上架）；原值留档
        hasSkcSelected: selectStatus === 1,
      })
      // SKU 映射：bg.glo.product.search 行顶层无 skuList（实测 20/20 行键仅
      // skcList/productId），真身嵌在 skcList[].skuList——skcId 即所在 skc 项
      const skuList = Array.isArray(skc.skuList) ? (skc.skuList as Record<string, unknown>[]) : []
      for (const sku of skuList) {
        const skuId = idStr(sku.skuId, 32)
        if (!skuId || seenSku.has(skuId)) continue
        seenSku.add(skuId)
        skuMapValues.push({ storeId, skuId, skcId })
      }
    }
  }

  if (rows.length > 0) {
    await db
      .insert(temuProducts)
      .values(rows)
      .onConflictDoUpdate({
        target: [temuProducts.storeId, temuProducts.productSkcId],
        set: {
          productId: sql`coalesce(excluded.product_id, ${temuProducts.productId})`,
          hasSkcSelected: sql`excluded.has_skc_selected`,
          lastSeenAt: sql`now()`,
        },
      })
  }
  if (skuMapValues.length > 0) {
    await db.insert(temuSkuMaps).values(skuMapValues).onConflictDoNothing()
  }
  return rows.length
}

/** bg.goods.salesv2.get（CN，pageNo/pageSize≤500 名义上限）
 *  实测（2026-10-19，RoseBlanche 608 SKC）：pageSize≥100 稳定触发官方侧
 *  100000000 query warehouse sales info error（文档宣称 [1,500] 与实现不符），
 *  50 稳定成功——保守取 50。 */
async function syncSalesOverview(storeId: string, ctx: TemuCallContext): Promise<number> {
  const capturedAt = new Date()
  let inserted = 0
  await forEachTemuPage<{ subOrderList?: unknown[]; total?: number }>(
    "bg.goods.salesv2.get",
    {},
    ctx,
    async (result, pageNo) => {
      const list = Array.isArray(result?.subOrderList)
        ? (result.subOrderList as Record<string, unknown>[])
        : []
      if (list.length > 0) {
        inserted += await upsertSalesBatch(storeId, capturedAt, list)
      }
      return list.length >= 50 && pageNo < 500
    },
    { pageSize: 50, pageField: "pageNo" },
  )
  return inserted
}

async function upsertSalesBatch(
  storeId: string,
  capturedAt: Date,
  items: Record<string, unknown>[],
): Promise<number> {
  const capturedDay = temuDayStr(capturedAt)
  const values = items.slice(0, 500).map((it) => {
    const skus = Array.isArray(it.skuQuantityDetailList)
      ? (it.skuQuantityDetailList as Record<string, unknown>[])
      : []
    const sum = (pick: (s: Record<string, unknown>) => unknown) =>
      skus.reduce((acc, s) => acc + (num(pick(s)) ?? 0), 0)
    // 仓库可用库存：salesv2 SKC 行已不返回顶层 inventoryNumInfo（实测 0/10 行），
    // 按各 SKU 的 inventoryNumInfo.warehouseInventoryNum 求和（口径同
    // temu-fulfillment sumSkuWarehouseStock：任一 SKU 有值即计，全无则 null）
    let whSum = 0
    let whAny = false
    for (const s of skus) {
      const inv = isRecord(s.inventoryNumInfo) ? s.inventoryNumInfo : {}
      const v = num(inv.warehouseInventoryNum)
      if (v != null) {
        whSum += v
        whAny = true
      }
    }
    return {
      storeId,
      skcId: idStr(it.productSkcId, 32) ?? "",
      capturedAt,
      capturedDay,
      productName: str(it.productName, 500),
      category: str(it.category, 120),
      supplierId: null,
      productSn: str(it.skcExtCode, 64),
      // SKC 级销量：官方只给 SKU 行与仓组行，按 SKU 求和
      todaySalesVolume: sum((s) => s.todaySaleVolume),
      last7DaysSalesVolume: sum((s) => s.lastSevenDaysSaleVolume),
      last30DaysSalesVolume: sum((s) => s.lastThirtyDaysSaleVolume),
      warehouseAvailableStock: whAny ? whSum : null,
      shippedStock: null,
      availableSaleDays:
        ratio(skus[0]?.availableSaleDays) ??
        ratio(skus[0]?.availableSaleDaysFromInventory) ??
        ratio(skus[0]?.warehouseAvailableSaleDays),
      priceDetail: skus,
      overview: it,
      mallMeta: null,
      contentHash: contentHashOf(it),
    } satisfies typeof temuSalesOverviews.$inferInsert
  }).filter((v) => !!v.skcId)

  // 每 (店, SKC, 日) 一行、每轮覆盖更新：内容未变化的商品也续期到本批次，
  // 概览「当日最新批次求和」才恒为全量（contentHash 去重曾致批次只剩变化
  // 子集、今日销量大幅低估）
  const rows = await db
    .insert(temuSalesOverviews)
    .values(values)
    .onConflictDoUpdate({
      target: [
        temuSalesOverviews.storeId,
        temuSalesOverviews.skcId,
        temuSalesOverviews.capturedDay,
      ],
      set: {
        capturedAt: sql`excluded.captured_at`,
        productName: sql`excluded.product_name`,
        category: sql`excluded.category`,
        productSn: sql`excluded.product_sn`,
        todaySalesVolume: sql`excluded.today_sales_volume`,
        last7DaysSalesVolume: sql`excluded.last7_days_sales_volume`,
        last30DaysSalesVolume: sql`excluded.last30_days_sales_volume`,
        warehouseAvailableStock: sql`excluded.warehouse_available_stock`,
        availableSaleDays: sql`excluded.available_sale_days`,
        priceDetail: sql`excluded.price_detail`,
        overview: sql`excluded.overview`,
        contentHash: sql`excluded.content_hash`,
      },
    })
    .returning({ id: temuSalesOverviews.id })

  // 标识回填：只补空不覆盖（商品详情源的名称/货号优先），SKU 行内映射同步落 sku_map；
  // SKU 申报价仅以 price.list.get 为源（salesv2 已不返回 supplierPrice，实测 0/10）
  const backfill = new Map<string, { productId: string | null; productName: string | null; productSn: string | null; skuIds: string[] }>()
  const mapValues: { storeId: string; skuId: string; skcId: string }[] = []
  const seenSku = new Set<string>()
  for (const it of items.slice(0, 500)) {
    const skcId = idStr(it.productSkcId, 32)
    if (!skcId) continue
    const productId = idStr(it.productId, 32)
    const productSn = str(it.skcExtCode, 64)
    const productName = str(it.productName, 500)
    if (!productId && !productSn && !productName) continue
    const skus = Array.isArray(it.skuQuantityDetailList)
      ? (it.skuQuantityDetailList as Record<string, unknown>[])
      : []
    for (const s of skus) {
      const skuId = idStr(s.productSkuId, 32)
      if (!skuId || seenSku.has(skuId)) continue
      seenSku.add(skuId)
      mapValues.push({ storeId, skuId, skcId })
    }
    backfill.set(skcId, { productId, productName, productSn, skuIds: [] })
  }
  if (backfill.size > 0) {
    await db
      .insert(temuProducts)
      .values(
        [...backfill.entries()].map(([skcId, v]) => ({
          storeId,
          productSkcId: skcId,
          productId: v.productId,
          productName: v.productName,
          productSn: v.productSn,
        })),
      )
      .onConflictDoUpdate({
        target: [temuProducts.storeId, temuProducts.productSkcId],
        set: {
          productId: sql`coalesce(${temuProducts.productId}, excluded.product_id)`,
          productName: sql`coalesce(${temuProducts.productName}, excluded.product_name)`,
          productSn: sql`coalesce(${temuProducts.productSn}, excluded.product_sn)`,
          lastSeenAt: sql`now()`,
        },
      })
  }
  if (mapValues.length > 0) {
    await db.insert(temuSkuMaps).values(mapValues).onConflictDoNothing()
  }
  return rows.length
}

/** bg.glo.goods.topselling.soldout.get（PA，无翻页）→ 售罄快照 */
async function syncSoldout(storeId: string, ctx: TemuCallContext): Promise<number> {
  const envelope = await callTemuApi<{ sellOutProducts?: unknown }>(
    "bg.glo.goods.topselling.soldout.get",
    {},
    ctx,
  )
  const products = Array.isArray(envelope.result?.sellOutProducts)
    ? (envelope.result.sellOutProducts as Record<string, unknown>[])
    : []
  if (products.length === 0) return 0
  const normalized = products.map((p) => ({
    id: idStr(p.sellOutProductId, 64),
    name: str(p.productName, 500),
    image: str(p.productPicture, 1000),
    leafCategory: isRecord(p.categories) && isRecord(p.categories.leafCat)
      ? str((p.categories.leafCat as Record<string, unknown>).catName, 120)
      : null,
    sites: Array.isArray(p.bindSites)
      ? (p.bindSites as Record<string, unknown>[]).map((s) => str(s.siteName, 64)).filter((v): v is string => !!v)
      : [],
  }))
  const inserted = await db
    .insert(temuMetricSnapshots)
    .values({
      storeId,
      source: "api-soldout",
      capturedAt: new Date(),
      alreadySoldOutNumber: normalized.length,
      metrics: { count: normalized.length, products: normalized },
      mallMeta: null,
      contentHash: contentHashOf(normalized.map((p) => p.id).sort()),
    })
    .onConflictDoNothing()
    .returning({ id: temuMetricSnapshots.id })
  return inserted.length
}

/** bg.glo.goods.price.list.get（PA，productSkuIds 批查）→ SKC 级申报价回填。
 *  goods-list 响应无价格字段、salesv2 只覆盖销售管理内商品；本源按 sku_map
 *  全量 SKU 批查（每批 50，接口无翻页、批量上限未文档化），按 SKC 取最小
 *  SKU 供货价写入 temu_product.supplierPrice。 */
async function syncPriceList(storeId: string, ctx: TemuCallContext): Promise<number> {
  const skuRows = await db
    .select({ skuId: temuSkuMaps.skuId })
    .from(temuSkuMaps)
    .where(eq(temuSkuMaps.storeId, storeId))
  const skuIds = skuRows.map((r) => Number(r.skuId)).filter((v) => Number.isFinite(v))
  if (skuIds.length === 0) return 0

  let updated = 0
  const BATCH = 50
  for (let i = 0; i < skuIds.length; i += BATCH) {
    const batch = skuIds.slice(i, i + BATCH)
    const envelope = await callTemuApi<{
      productSkuSupplierPriceList?: unknown
    }>("bg.glo.goods.price.list.get", { productSkuIds: batch }, ctx)
    const list = Array.isArray(envelope.result?.productSkuSupplierPriceList)
      ? (envelope.result.productSkuSupplierPriceList as Record<string, unknown>[])
      : []
    // SKU 级价格落 sku_map（salesv2 SKU 明细的 supplierPrice 实测已不返回，
    // 展开 SKU 子表的价格源）；官方价格变动即时覆盖
    const skuPrices = list
      .map((it) => ({
        skuId: idStr(it.productSkuId, 32),
        skcId: idStr(it.productSkcId, 32),
        supplierPrice: num(it.supplierPrice),
      }))
      .filter((p): p is { skuId: string; skcId: string; supplierPrice: number } =>
        !!p.skuId && !!p.skcId && p.supplierPrice != null)
    if (skuPrices.length > 0) {
      await db
        .insert(temuSkuMaps)
        .values(skuPrices.map((p) => ({ storeId, ...p })))
        .onConflictDoUpdate({
          target: [temuSkuMaps.storeId, temuSkuMaps.skuId],
          set: { supplierPrice: sql`excluded.supplier_price` },
        })
    }
    // 批内最小价仅用于新建行的初值；已存在行的 SKC 级申报价改为按 sku_map 全量
    // 重算（min of 该 SKC 全部 SKU 最新价）——官方分批返回缺某 SKU 时不再用批内
    // min 抬高主表价，与商品页 SKU 子表展示恒一致
    const bySkc = new Map<string, number>()
    for (const it of list) {
      const skcId = idStr(it.productSkcId, 32)
      const price = num(it.supplierPrice)
      if (!skcId || price == null) continue
      const prev = bySkc.get(skcId)
      if (prev == null || price < prev) bySkc.set(skcId, price)
    }
    if (bySkc.size === 0) continue
    const rows = await db
      .insert(temuProducts)
      .values(
        [...bySkc.entries()].map(([skcId, supplierPrice]) => ({
          storeId,
          productSkcId: skcId,
          supplierPrice,
        })),
      )
      .onConflictDoUpdate({
        target: [temuProducts.storeId, temuProducts.productSkcId],
        set: {
          supplierPrice: sql`coalesce((select min(m.supplier_price) from ${temuSkuMaps} m where m.store_id = ${storeId} and m.skc_id = ${temuProducts.productSkcId}), ${temuProducts.supplierPrice})`,
          lastSeenAt: sql`now()`,
        },
      })
      .returning({ id: temuProducts.id })
    updated += rows.length
  }
  return updated
}

/* ─── 广告报表（全托广告API组，PA） ─── */

/** 报表指标四维口径之一（total 全域 / ad 推广 / netTotal 净全域 / netAd 净推广） */
type AdMetricDim = "total" | "ad" | "netTotal" | "netAd"

/** 报表指标取值：item[name][dim].val（文档每指标为 {total/ad/netTotal/netAd:{val}}）；
 *  字段名按候选数组依次取（adSpend/spend 两口径都认，口径同工作台 adDetailMetric） */
function adMetric(
  item: Record<string, unknown>,
  names: string[],
  dim: AdMetricDim,
): number | null {
  for (const name of names) {
    const m = isRecord(item[name]) ? (item[name] as Record<string, unknown>) : {}
    const d = isRecord(m[dim]) ? (m[dim] as Record<string, unknown>) : {}
    const v = num(d.val)
    if (v != null) return v
  }
  return null
}

interface AdsReportResult {
  reportInfo?: {
    reportsItemList?: unknown
    summary?: unknown
    reportsSummary?: unknown
  }
}

/** 广告报表窗口（天）：跨度 >1 天官方才按天级行返回；官方数据滞后修正，
 *  滚动窗口幂等覆盖（昨日/今日行随每轮同步刷新）。35 天兜住页面近 30 日
 *  视图（调用次数不变，仅窗口拉长；后台创建的广告对接口不可见，本源只
 *  覆盖通过 API 创建的广告——见 docs/temu-openapi-guide.md 实测备注） */
const ADS_REPORT_WINDOW_DAYS = 35

/** 北京时间 [startDay 0点, 今日 23:59:59.999] 的毫秒时间戳对 */
function adsReportWindow(days: number): { startTs: number; endTs: number } {
  const todayStr = temuDayStr()
  const startStr = temuDayStr(new Date(Date.now() - (days - 1) * 86400_000))
  return {
    startTs: new Date(`${startStr}T00:00:00+08:00`).getTime(),
    endTs: new Date(`${todayStr}T23:59:59.999+08:00`).getTime(),
  }
}

/**
 * bg.glo.searchrec.ad.reports.mall.query + goods.query（PA，全托广告API组）
 * → temu_ads_daily（店铺级日行，元口径）+ temu_ads_product_daily（商品级日行，分口径）。
 * 主指标取 ad 推广维度，全量四维存 metrics；单品推广口径（不传 selectedAdManagedType）。
 */
async function syncAdsReports(storeId: string, ctx: TemuCallContext): Promise<number> {
  const { startTs, endTs } = adsReportWindow(ADS_REPORT_WINDOW_DAYS)

  // —— 店铺级：mall.query 天级行 → temu_ads_daily ——
  // 广告组频控比常规组紧（实测背靠背两次调用即 4000004 限频），
  // mall 与 goods 之间停顿削峰
  const mall = await callTemuApi<AdsReportResult>(
    "bg.glo.searchrec.ad.reports.mall.query",
    { startTs, endTs },
    ctx,
  )
  const mallItems = (Array.isArray(mall.result?.reportInfo?.reportsItemList)
    ? (mall.result.reportInfo.reportsItemList as Record<string, unknown>[])
    : []
  ).filter((it) => num(it.ts) != null)
  for (const it of mallItems) {
    const date = temuDayOfTs(num(it.ts) as number)
    // temu_ads_daily 金额列为元口径（插件历史约定），官方分 → ÷100
    // 花费字段名 adSpend/spend 两口径都认（指南 §8.10 写 spend，与工作台同款兼容）
    const spendFen = adMetric(it, ["adSpend", "spend"], "ad")
    const gmvFen = adMetric(it, ["orderPayAmt"], "ad")
    await db
      .insert(temuAdsDailies)
      .values({
        storeId,
        date,
        adSpend: spendFen != null ? spendFen / 100 : 0,
        impressions: adMetric(it, ["imprCnt"], "ad"),
        clicks: adMetric(it, ["clkCnt"], "ad"),
        orders: adMetric(it, ["orderPayCnt"], "ad"),
        gmv: gmvFen != null ? gmvFen / 100 : null,
        metrics: it,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [temuAdsDailies.storeId, temuAdsDailies.date],
        set: {
          adSpend: sql`excluded.ad_spend`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          orders: sql`excluded.orders`,
          gmv: sql`excluded.gmv`,
          metrics: sql`excluded.metrics`,
          updatedAt: sql`now()`,
        },
      })
  }

  // 广告组限频削峰（见上），两接口间隔 1.5s 再发
  await new Promise((r) => setTimeout(r, 1500))

  // —— 商品级：goods.query 天级行（不传 productId = 全店商品）→ temu_ads_product_daily ——
  const goods = await callTemuApi<AdsReportResult>(
    "bg.glo.searchrec.ad.reports.goods.query",
    { startTs, endTs },
    ctx,
  )
  const goodsItems = (Array.isArray(goods.result?.reportInfo?.reportsItemList)
    ? (goods.result.reportInfo.reportsItemList as Record<string, unknown>[])
    : []
  ).filter((it) => num(it.ts) != null && idStr(it.productId, 32))
  let goodsRows = 0
  const BATCH = 100
  for (let i = 0; i < goodsItems.length; i += BATCH) {
    const batch = goodsItems.slice(i, i + BATCH)
    const values = batch.map((it) => ({
      storeId,
      date: temuDayOfTs(num(it.ts) as number),
      productId: idStr(it.productId, 32) as string,
      adSpend: adMetric(it, ["adSpend", "spend"], "ad"),
      imprCnt: adMetric(it, ["imprCnt"], "ad"),
      clkCnt: adMetric(it, ["clkCnt"], "ad"),
      cartCnt: adMetric(it, ["cartCnt"], "ad"),
      orderPayCnt: adMetric(it, ["orderPayCnt"], "ad"),
      orderPayAmt: adMetric(it, ["orderPayAmt"], "ad"),
      goodsNum: adMetric(it, ["goodsNum"], "ad"),
      roas: adMetric(it, ["roas"], "ad"),
      acos: adMetric(it, ["acos"], "ad"),
      transactionCost: adMetric(it, ["transactionCost"], "ad"),
      metrics: it,
      updatedAt: new Date(),
    }))
    await db
      .insert(temuAdsProductDailies)
      .values(values)
      .onConflictDoUpdate({
        target: [
          temuAdsProductDailies.storeId,
          temuAdsProductDailies.date,
          temuAdsProductDailies.productId,
        ],
        set: {
          adSpend: sql`excluded.ad_spend`,
          imprCnt: sql`excluded.impr_cnt`,
          clkCnt: sql`excluded.clk_cnt`,
          cartCnt: sql`excluded.cart_cnt`,
          orderPayCnt: sql`excluded.order_pay_cnt`,
          orderPayAmt: sql`excluded.order_pay_amt`,
          goodsNum: sql`excluded.goods_num`,
          roas: sql`excluded.roas`,
          acos: sql`excluded.acos`,
          transactionCost: sql`excluded.transaction_cost`,
          metrics: sql`excluded.metrics`,
          updatedAt: sql`now()`,
        },
      })
    goodsRows += values.length
  }
  return mallItems.length + goodsRows
}

/* ─── 调度入口 ─── */

export interface StoreSyncOutcome {
  storeId: string
  skipped?: string
  status?: TemuSyncStatus
}

/**
 * 店铺级调用上下文（企业级凭证 + 店铺 token 解密 + 每店限速桶）。
 * sync 循环与工作台实时 action（核价/调价/备货等）共用同一构造，
 * 限速按 rateKey=storeId 合并计数：进程内令牌桶（Web 进程内 sync 与
 * 工作台 action 共桶）+ client 的 Redis 跨进程闸门（同店相邻调用跨进程
 * ≥334ms，worker 与 Web 叠加不再超官方 3qps/店；Redis 不可用降级为
 * 进程内桶，瞬时突发由 client 对 4000000 的延迟重试兜底，见 docs §5.1）。
 */
export async function getTemuCallContext(
  store: Pick<typeof temuStores.$inferSelect, "id" | "enterpriseId" | "accessTokenEncrypted">,
): Promise<TemuCallContext | { error: string }> {
  if (!store.accessTokenEncrypted) return { error: "未录入 access_token" }
  const app = await getTemuAppCredential(store.enterpriseId)
  if (!app) return { error: "该企业未配置 TEMU 应用凭证（超管 → 企业管理 → TEMU应用）" }
  let accessToken: string
  try {
    accessToken = decrypt(store.accessTokenEncrypted)
  } catch (err) {
    // 解密失败（ENCRYPTION_KEY 轮换后未重加密/密文损坏）兜底为 error 返回，
    // 走 syncStore 既有 skipped 路径，不外抛中断整轮（口径同 app-config 解密兜底）
    console.error(
      "[temu-sync] access_token 解密失败（ENCRYPTION_KEY 轮换后未重加密？）：",
      err instanceof Error ? err.message : err,
    )
    return { error: "access_token 解密失败（ENCRYPTION_KEY 轮换后未重加密？）" }
  }
  return {
    appKey: app.appKey,
    appSecret: app.appSecret,
    accessToken,
    rateKey: store.id,
    qps: 3,
  }
}

const SOURCES: Array<{ source: string; run: (storeId: string, ctx: TemuCallContext) => Promise<number> }> = [
  { source: "api-goods-list", run: syncGoodsList },
  { source: "api-lifecycle", run: syncLifecycle },
  { source: "api-sales-overview", run: syncSalesOverview },
  { source: "api-soldout", run: syncSoldout },
  { source: "api-price-list", run: syncPriceList },
  { source: "api-ads-reports", run: syncAdsReports },
]

/** 同步单个店铺（手动按钮与 worker 循环共用）。token 失效会标记店铺并中止。 */
export async function syncStore(storeId: string): Promise<StoreSyncOutcome> {
  const [store] = await db.select().from(temuStores).where(eq(temuStores.id, storeId)).limit(1)
  if (!store) return { storeId, skipped: "店铺不存在" }
  if (!store.enabled) return { storeId, skipped: "店铺已停用" }
  if (!store.accessTokenEncrypted) return { storeId, skipped: "未录入 access_token" }

  const built = await getTemuCallContext(store)
  if ("error" in built) return { storeId, skipped: built.error }
  const ctx = built

  const startedAt = new Date()
  const status: TemuSyncStatus = {
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    sources: {},
  }

  for (const { source, run } of SOURCES) {
    // salesv2（全托管销售管理）与全托广告API组是全托专属，半托店铺无此数据，
    // 跳过不算失败
    if (
      store.mallType === "semi" &&
      (source === "api-sales-overview" || source === "api-ads-reports")
    ) {
      status.sources[source] = { ok: true, count: 0, skipped: true }
      await db.insert(temuIngestLogs).values({
        storeId,
        source,
        itemCount: 0,
        acceptedCount: 0,
        detail: { via: "official-api", skipped: "semi-managed store（无全托销售管理/广告数据）" },
      })
      continue
    }
    try {
      const count = await run(storeId, ctx)
      status.sources[source] = { ok: true, count }
      await db.insert(temuIngestLogs).values({
        storeId,
        source,
        itemCount: count,
        acceptedCount: count,
        detail: { via: "official-api" },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      status.ok = false
      status.sources[source] = { ok: false, error: message.slice(0, 500) }
      await db.insert(temuIngestLogs).values({
        storeId,
        source,
        itemCount: 0,
        acceptedCount: 0,
        detail: { via: "official-api", error: message.slice(0, 500) },
      })
      if (isTemuTokenExpired(err)) {
        // token 失效：余下源必败，中止并标记待重录
        await db
          .update(temuStores)
          .set({ tokenState: "invalid", updatedAt: new Date() })
          .where(eq(temuStores.id, storeId))
        break
      }
    }
  }

  status.finishedAt = new Date().toISOString()
  await db
    .update(temuStores)
    .set({ lastSyncAt: new Date(), lastSyncStatus: status, updatedAt: new Date() })
    .where(eq(temuStores.id, storeId))
  invalidateTemuCache(store.enterpriseId)
  return { storeId, status }
}

/**
 * 验证店铺 token 并回写类型/编号（录入后调用）：
 * bg.mall.info.get（CN）判全托/半托；bg.open.accesstoken.info.get.global（PA）
 * 尽力取 uniqueId 存 mallId。任一成功即视为 token 有效。
 */
export async function verifyStoreToken(
  storeId: string,
): Promise<{ ok: boolean; error?: string; mallType?: "full" | "semi"; mallId?: string }> {
  const [store] = await db.select().from(temuStores).where(eq(temuStores.id, storeId)).limit(1)
  if (!store) return { ok: false, error: "店铺不存在" }
  if (!store.accessTokenEncrypted) return { ok: false, error: "未录入 access_token" }

  const app = await getTemuAppCredential(store.enterpriseId)
  if (!app) return { ok: false, error: "该企业未配置 TEMU 应用凭证（超管 → 企业管理 → TEMU应用）" }

  let accessToken: string
  try {
    accessToken = decrypt(store.accessTokenEncrypted)
  } catch (err) {
    console.error(
      "[temu-sync] access_token 解密失败（ENCRYPTION_KEY 轮换后未重加密？）：",
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "access_token 解密失败（ENCRYPTION_KEY 轮换后未重加密？）" }
  }

  const ctx: TemuCallContext = {
    appKey: app.appKey,
    appSecret: app.appSecret,
    accessToken,
    rateKey: `verify-${storeId}`,
    qps: 3,
  }

  let mallType: "full" | "semi" | undefined
  let mallId: string | undefined
  try {
    const mall = await callTemuApi<{ semiManagedMall?: boolean }>("bg.mall.info.get", {}, ctx)
    mallType = mall.result?.semiManagedMall === true ? "semi" : "full"
  } catch (err) {
    if (isTemuTokenExpired(err)) {
      return { ok: false, error: "access_token 无效或已过期，请重新授权复制" }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  // uniqueId/mallName 尽力而为（实测 result 形如 { mallName, uniqueId, expiredTime, apiScopeList }），
  // 失败不影响验证结论
  let mallName: string | undefined
  try {
    const info = await callTemuApi<Record<string, unknown>>(
      "bg.open.accesstoken.info.get.global",
      {},
      ctx,
    )
    const r = isRecord(info.result) ? info.result : {}
    const candidate = str(r.uniqueId, 64)
    if (candidate) mallId = candidate
    mallName = str(r.mallName, 100) ?? undefined
  } catch {
    // 忽略：主验证已通过
  }

  await db
    .update(temuStores)
    .set({
      tokenState: "active",
      ...(mallType ? { mallType } : {}),
      ...(mallId ? { mallId } : {}),
      ...(mallName ? { mallName } : {}),
      updatedAt: new Date(),
    })
    .where(eq(temuStores.id, storeId))
  invalidateTemuCache(store.enterpriseId)
  return { ok: true, mallType, mallId }
}

/** worker 定时轮询入口：遍历启用同步且 token 正常的店铺 */
export async function syncDueStores(maxAgeMs: number): Promise<StoreSyncOutcome[]> {
  const rows = await db.select().from(temuStores)
  const due = rows.filter(
    (s) =>
      s.enabled &&
      s.syncEnabled &&
      s.accessTokenEncrypted &&
      s.tokenState !== "invalid" &&
      (!s.lastSyncAt || Date.now() - s.lastSyncAt.getTime() >= maxAgeMs),
  )
  const outcomes: StoreSyncOutcome[] = []
  for (const store of due) {
    // 逐店隔离：单店异常（token 密文损坏等预期外错误）记为该店失败 outcome，
    // 不中断余下店铺的整轮同步
    try {
      outcomes.push(await syncStore(store.id))
    } catch (err) {
      console.error(
        `[temu-sync] 店铺 ${store.id} 同步异常：`,
        err instanceof Error ? err.message : err,
      )
      outcomes.push({
        storeId: store.id,
        status: {
          ok: false,
          startedAt: "",
          finishedAt: new Date().toISOString(),
          // fatal 伪源位承载整店级异常（syncStore 未及落到 per-source 日志的场景）
          sources: {
            fatal: { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
          },
        },
      })
    }
    // 多店连跑削峰：每店限速桶独立（官方口径 3qps/店铺），叠加突发会触发
    // 网关 SYSTEM_EXCEPTION（实测瞬时、重试即恢复）——店间稍作停顿平滑聚合速率
    if (store.id !== due[due.length - 1]?.id) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  return outcomes
}
