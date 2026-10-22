"use server"

import { and, desc, eq, ilike, inArray, or } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import { temuProducts, temuSkuMaps, temuStores, temuAds } from "@/db/schema"
import type { ModuleName } from "@/db/schema/_shared"
import {
  requireEnterpriseContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { MODULE_LABELS } from "@/lib/modules"
import {
  callTemuApi,
  isTemuPermissionError,
  isTemuTokenExpired,
  type TemuCallContext,
} from "@/lib/temu-api/client"
import { getTemuCallContext } from "@/server/services/temu-sync"
import { temuCached, invalidateTemuCache } from "@/server/services/temu-cache"
import {
  PRICE_REVIEW_STATUS,
  ADJUST_ORDER_STATUS,
  TEMU_AD_SHOW_STATUS,
} from "@/lib/temu-api/workbench-labels"
import {
  temuPriceReviewQuerySchema,
  temuPriceReviewRejectSchema,
  temuAdjustOrderQuerySchema,
  temuAdjustApproveSchema,
  temuAdProductsQuerySchema,
  temuAdCreateSchema,
  temuAdModifySchema,
} from "@/server/schemas/temu"

/**
 * Temu 运营工作台 Server Actions（核价/调价/广告）
 *
 * 与同步落库的数据面板不同，本组为「实时拉取」：页面打开即调官方 API
 * （核价/调价单时效性强，落库反而陈旧），读走
 * temu-cache 30s 短缓存，写操作直连后失效缓存。
 *
 * 权限：查询 requireEnterpriseContext（企业成员可看）；价格/广告类写操作
 * 校验对应 tab 模块权限（可查看当前页面即有该页功能按钮权限，2026-10-22 口径）。
 * 全部强制企业隔离（store 必须属于当前企业）。
 */

/* ─── 状态/类型口径 ─── */

/* 展示文案映射在 @/lib/temu-api/workbench-labels（"use server" 文件只允许
   导出 async 函数，常量对象放这里会被 Next.js 构建器拒绝） */

const PRICE_REVIEW_STATUS_CODE: Record<string, number> = {
  pending: 0,
  supplier: 1,
  passed: 2,
  rejected: 3,
  discarded: 4,
  syncing: 5,
}

const ADJUST_STATUS_CODE: Record<string, number> = {
  pending: 0,
  supplier: 1,
  success: 2,
  failed: 3,
}

/* ─── 公共 ─── */

type StoreRow = typeof temuStores.$inferSelect

/** 校验店铺归属当前企业并返回店铺行（工作台全部 action 的入口守卫）。
 *  requireModule：写操作传入对应 tab 模块（页面可见即可用按钮）；查询传 null */
async function requireTemuStore(
  storeId: string,
  requireModule: ModuleName | null,
): Promise<{ ok: true; store: StoreRow } | { ok: false; error: string }> {
  const ctx = await requireEnterpriseContext()
  if (requireModule && !ctx.canAccess(requireModule)) {
    return {
      ok: false,
      error: `当前账号没有「${MODULE_LABELS[requireModule]}」页面权限，无法执行该操作`,
    }
  }
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const [store] = await db
    .select()
    .from(temuStores)
    .where(and(eq(temuStores.id, storeId), eq(temuStores.enterpriseId, enterpriseId)))
    .limit(1)
  if (!store) return { ok: false, error: "店铺不存在或不属于当前企业" }
  if (!store.enabled) return { ok: false, error: "店铺已停用" }
  return { ok: true, store }
}

/** 官方 API 错误 → 面板可读信息；token 过期顺手标记店铺 invalid（与同步链路口径一致） */
async function toWorkbenchError(storeId: string, err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message : String(err)
  if (isTemuTokenExpired(err)) {
    await db
      .update(temuStores)
      .set({ tokenState: "invalid", updatedAt: new Date() })
      .where(eq(temuStores.id, storeId))
    return "access_token 已过期，请在店铺管理重新录入"
  }
  if (isTemuPermissionError(err)) {
    return "店铺 token 未授权该接口组（卖家中心授权勾选或自研专属接口未开通）"
  }
  return message.slice(0, 300) || "官方接口调用失败"
}

function buildCallContext(
  store: StoreRow,
  ctx: TemuCallContext | { error: string },
): { ok: true; ctx: TemuCallContext } | { ok: false; error: string } {
  if ("error" in ctx) return { ok: false, error: ctx.error }
  return { ok: true, ctx }
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

function idStr(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v)).slice(0, max)
  if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, max)
  return null
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]).filter(isRecord) : []
}

/* ─── 核价工作台（全托） ─── */

export interface TemuPriceReviewProduct {
  productSkcId: string
  productName: string | null
  mainImageUrl: string | null
  productSn: string | null
}

export interface TemuPriceReviewRow {
  orderId: number
  status: number
  statusLabel: string
  /** 申报价格（分） */
  supplyPrice: number | null
  priceCurrency: string | null
  /** 建议价格（分） */
  suggestSupplyPrice: number | null
  suggestPriceCurrency: string | null
  /** 建议价相对申报价的变化百分比（正=建议降价） */
  deltaPct: number | null
  siteNames: string[]
  /** 站点 id（官方 siteNameList 实测不返回，名称由 TEMU_SITES 字典映射） */
  siteIds: number[]
  canBargain: boolean
  skuIds: string[]
  /** 经 sku_map 反查关联的商品（展示名称/主图） */
  products: TemuPriceReviewProduct[]
}

/** 核价单列表（bg.price.review.page.query，实时 + 30s 缓存；默认全状态最多 200 条） */
export async function getTemuPriceReviewsAction(input: {
  store: string
  status?: string
}): Promise<{ ok: true; rows: TemuPriceReviewRow[] } | { ok: false; error: string }> {
  const q = temuPriceReviewQuerySchema.parse(input)
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  if (store.mallType === "semi") {
    return { ok: false, error: "半托店铺核价走 semi 接口，暂未接入" }
  }
  return temuCached(`${store.enterpriseId}:price-review:${store.id}:${q.status ?? "all"}`, () =>
    loadPriceReviews(store, q.status),
  )
}

async function loadPriceReviews(
  store: StoreRow,
  status?: string,
): Promise<{ ok: true; rows: TemuPriceReviewRow[] } | { ok: false; error: string }> {
  const built = buildCallContext(store, await getTemuCallContext(store))
  if (!built.ok) return built
  const params: Record<string, unknown> = { pageSize: 50 }
  if (status && status in PRICE_REVIEW_STATUS_CODE) {
    params.orderStatusList = [PRICE_REVIEW_STATUS_CODE[status]]
  }
  const rows: TemuPriceReviewRow[] = []
  try {
    for (let pageNo = 1; pageNo <= 4; pageNo += 1) {
      const envelope = await callTemuApi<{
        reviewSamplePriceList?: unknown
      }>("bg.price.review.page.query", { ...params, pageNo }, built.ctx)
      const list = asList(envelope.result?.reviewSamplePriceList)
      for (const it of list) {
        const orderId = num(it.orderId)
        if (orderId == null) continue
        const supplyPrice = num(it.supplyPrice)
        const suggest = num(it.suggestSupplyPrice)
        rows.push({
          orderId,
          status: num(it.orderStatus) ?? -1,
          statusLabel: PRICE_REVIEW_STATUS[num(it.orderStatus) ?? -1] ?? `未知(${it.orderStatus})`,
          supplyPrice,
          priceCurrency: str(it.priceCurrency, 8),
          suggestSupplyPrice: suggest,
          suggestPriceCurrency: str(it.suggestPriceCurrency, 8),
          deltaPct:
            supplyPrice != null && suggest != null && supplyPrice > 0
              ? Math.round(((supplyPrice - suggest) / supplyPrice) * 1000) / 10
              : null,
          siteNames: (Array.isArray(it.siteNameList) ? it.siteNameList : [])
            .map((s) => str(s, 32))
            .filter((v): v is string => !!v),
          siteIds: (Array.isArray(it.siteIds) ? it.siteIds : [])
            .map((v) => num(v))
            .filter((v): v is number => v != null),
          canBargain: it.canBargain === true,
          skuIds: (Array.isArray(it.productSkuIdList) ? it.productSkuIdList : [])
            .map((v) => idStr(v, 32))
            .filter((v): v is string => !!v),
          products: [],
        })
      }
      if (list.length < 50) break
    }
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(store.id, err) }
  }

  // SKU → SKC → 商品信息（名称/主图/货号）反查合并
  const skuIds = [...new Set(rows.flatMap((r) => r.skuIds))].slice(0, 500)
  if (skuIds.length > 0) {
    const maps = await db
      .select({
        skuId: temuSkuMaps.skuId,
        productSkcId: temuProducts.productSkcId,
        productName: temuProducts.productName,
        mainImageUrl: temuProducts.mainImageUrl,
        productSn: temuProducts.productSn,
      })
      .from(temuSkuMaps)
      .innerJoin(
        temuProducts,
        and(
          eq(temuSkuMaps.skcId, temuProducts.productSkcId),
          eq(temuSkuMaps.storeId, temuProducts.storeId),
        ),
      )
      .where(and(eq(temuSkuMaps.storeId, store.id), inArray(temuSkuMaps.skuId, skuIds)))
    const bySku = new Map<string, TemuPriceReviewProduct>()
    for (const m of maps) {
      if (!bySku.has(m.skuId)) {
        bySku.set(m.skuId, {
          productSkcId: m.productSkcId,
          productName: m.productName,
          mainImageUrl: m.mainImageUrl,
          productSn: m.productSn,
        })
      }
    }
    for (const r of rows) {
      const seen = new Set<string>()
      for (const sku of r.skuIds) {
        const p = bySku.get(sku)
        if (p && !seen.has(p.productSkcId)) {
          seen.add(p.productSkcId)
          r.products.push(p)
        }
      }
    }
  }
  // 最新在最上：官方单号单调递增，orderId 降序即时间倒序
  rows.sort((a, b) => b.orderId - a.orderId)
  return { ok: true, rows }
}

/** 同意核价单建议价入参（orderId 畸形值在进官方接口前先收口为友好错误） */
const temuPriceReviewConfirmSchema = z.object({
  store: z.string().uuid(),
  orderId: z.coerce.number().int().positive(),
})

/** 同意核价单建议价（bg.price.review.confirm，需核价调价页权限） */
export async function confirmTemuPriceReviewAction(input: {
  store: string
  orderId: number
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = temuPriceReviewConfirmSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, "temu_price")
  if (!guard.ok) return { ok: false, error: guard.error }
  const built = buildCallContext(guard.store, await getTemuCallContext(guard.store))
  if (!built.ok) return { ok: false, error: built.error }
  try {
    await callTemuApi("bg.price.review.confirm", { orderId: parsed.data.orderId }, built.ctx)
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(guard.store.id, err) }
  }
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true }
}

/** 不同意核价单建议价并给出新申报价（bg.price.review.reject，需核价调价页权限） */
export async function rejectTemuPriceReviewAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const q = temuPriceReviewRejectSchema.parse(input)
  const guard = await requireTemuStore(q.store, "temu_price")
  if (!guard.ok) return { ok: false, error: guard.error }
  const built = buildCallContext(guard.store, await getTemuCallContext(guard.store))
  if (!built.ok) return { ok: false, error: built.error }
  try {
    await callTemuApi(
      "bg.price.review.reject",
      {
        orderId: q.orderId,
        bargainReasonList: [
          {
            componentList: q.reasons.map((r) => ({ type: r.type, reason: r.reason })),
          },
        ],
        priceItemList: q.priceItemList,
      },
      built.ctx,
    )
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(guard.store.id, err) }
  }
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true }
}

/* ─── 调价工作台（全托） ─── */

export interface TemuAdjustOrderRow {
  priceOrderSn: string
  status: number
  statusLabel: string
  skcId: string | null
  skcExtCode: string | null
  productId: string | null
  productName: string | null
  orderCreateTime: number | null
  /** 0=日常价 1=活动价 */
  priceType: number | null
  adjustReason: string | null
  source: string | null
  /** 调价后申报价格（分；2026-10-22 探针实测为 number，num() 仍兼容 string） */
  newSupplyPrice: number | null
  /** 当前申报价（分；接口不返回，按 skcId 反查 temu_products.supplierPrice） */
  currentSupplyPrice: number | null
  priceCurrency: string | null
  image: string | null
  skuItems: { skuId: string; price: number | null; skuExtCode: string | null; spec: string | null }[]
}

/** 调价单列表（bg.full.adjust.price.page.query，实时 + 30s 缓存；status 必填） */
export async function getTemuAdjustOrdersAction(input: {
  store: string
  status: string
}): Promise<{ ok: true; rows: TemuAdjustOrderRow[] } | { ok: false; error: string }> {
  const q = temuAdjustOrderQuerySchema.parse(input)
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  if (store.mallType === "semi") {
    return { ok: false, error: "半托店铺调价走 semi 接口，暂未接入" }
  }
  return temuCached(`${store.enterpriseId}:adjust:${store.id}:${q.status}`, () =>
    loadAdjustOrders(store, ADJUST_STATUS_CODE[q.status]),
  )
}

async function loadAdjustOrders(
  store: StoreRow,
  status: number,
): Promise<{ ok: true; rows: TemuAdjustOrderRow[] } | { ok: false; error: string }> {
  const built = buildCallContext(store, await getTemuCallContext(store))
  if (!built.ok) return built
  const rows: TemuAdjustOrderRow[] = []
  try {
    for (let pageNo = 1; pageNo <= 4; pageNo += 1) {
      const envelope = await callTemuApi<{ list?: unknown }>(
        "bg.full.adjust.price.page.query",
        { status, pageNo, pageSize: 50 },
        built.ctx,
      )
      const list = asList(envelope.result?.list)
      for (const it of list) {
        const sn = str(it.priceOrderSn, 64)
        if (!sn) continue
        // 行内不返回 status（2026-10-22 探针实证 0/20 行带该键）；每档列表
        // 本身按查询入参 status 过滤，行状态直接由入参回填
        rows.push({
          priceOrderSn: sn,
          status,
          statusLabel: ADJUST_ORDER_STATUS[status] ?? `未知(${status})`,
          skcId: idStr(it.skcId, 32),
          skcExtCode: str(it.skcExtCode, 64),
          productId: idStr(it.productId, 32),
          productName: str(it.productName, 500),
          orderCreateTime: num(it.orderCreateTime),
          priceType: num(it.priceType),
          adjustReason: str(it.adjustReason, 200),
          source: str(it.source, 64),
          newSupplyPrice: num(it.newSupplyPrice),
          currentSupplyPrice: null,
          priceCurrency: str(it.priceCurrency, 8),
          image: (Array.isArray(it.imageList) ? str(it.imageList[0], 1000) : null),
          skuItems: asList(it.skuInfoItemList).map((s) => ({
            skuId: idStr(s.productSkuId, 32) ?? "",
            price: num(s.price),
            skuExtCode: str(s.skuExtCode, 64),
            spec: str(s.spec, 120),
          })).filter((s) => !!s.skuId),
        })
      }
      if (list.length < 50) break
    }
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(store.id, err) }
  }
  // 当前申报价：调价单接口不返回——优先按单内 SKU 反查 temu_sku_map（SKU 级、
  // 逐单即时，多 SKU 取最小）；无匹配回落 SKC 级 temu_products（price.list.get
  // 同步源，本质是 SKC 内最小价，SKU 异价时与单内实际 SKU 价可偏差）
  const skuIds = [...new Set(rows.flatMap((r) => r.skuItems.map((s) => s.skuId)).filter(Boolean))]
  const skuPriceBy = new Map<string, number>()
  if (skuIds.length > 0) {
    const skuRows = await db
      .select({ skuId: temuSkuMaps.skuId, supplierPrice: temuSkuMaps.supplierPrice })
      .from(temuSkuMaps)
      .where(and(eq(temuSkuMaps.storeId, store.id), inArray(temuSkuMaps.skuId, skuIds)))
    for (const s of skuRows) {
      if (s.supplierPrice != null) {
        const prev = skuPriceBy.get(s.skuId)
        if (prev == null || s.supplierPrice < prev) skuPriceBy.set(s.skuId, s.supplierPrice)
      }
    }
  }
  const skcIds = [...new Set(rows.map((r) => r.skcId).filter((v): v is string => !!v))]
  const skcPriceBy = new Map<string, number>()
  if (skcIds.length > 0) {
    const priceRows = await db
      .select({ skcId: temuProducts.productSkcId, supplierPrice: temuProducts.supplierPrice })
      .from(temuProducts)
      .where(
        and(
          eq(temuProducts.storeId, store.id),
          inArray(temuProducts.productSkcId, skcIds),
        ),
      )
    for (const p of priceRows) {
      if (p.skcId && p.supplierPrice != null && !skcPriceBy.has(p.skcId)) {
        skcPriceBy.set(p.skcId, p.supplierPrice)
      }
    }
  }
  for (const r of rows) {
    const skuPrices = r.skuItems
      .map((s) => skuPriceBy.get(s.skuId))
      .filter((v): v is number => v != null)
    if (skuPrices.length > 0) r.currentSupplyPrice = Math.min(...skuPrices)
    else if (r.skcId) r.currentSupplyPrice = skcPriceBy.get(r.skcId) ?? null
  }
  // 最新在最上：按创建时间倒序，缺失时间的行沉底
  rows.sort((a, b) => (b.orderCreateTime ?? 0) - (a.orderCreateTime ?? 0))
  return { ok: true, rows }
}

/** 批量通过调价单（bg.full.adjust.price.batch.review；官方仅支持通过，需核价调价页权限） */
export async function batchApproveTemuAdjustAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const q = temuAdjustApproveSchema.parse(input)
  const guard = await requireTemuStore(q.store, "temu_price")
  if (!guard.ok) return { ok: false, error: guard.error }
  const built = buildCallContext(guard.store, await getTemuCallContext(guard.store))
  if (!built.ok) return { ok: false, error: built.error }
  try {
    await callTemuApi(
      "bg.full.adjust.price.batch.review",
      { adjustList: q.priceOrderSns.map((sn) => ({ result: 1, priceOrderSn: sn })) },
      built.ctx,
    )
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(guard.store.id, err) }
  }
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true }
}

/* ─── 广告工作台（bg.glo.searchrec.ad.*，实时 + 注册表 temu_ad） ─── */

/**
 * 平台限制（2026-10-20 实测）：卖家后台手动创建的广告对官方接口不可见
 * （90 天报表窗口覆盖真实消耗时段仍返回 0 行），只有通过 API 创建的广告
 * 数据可查——「我的广告」以本站注册表为准，报表区块口径同此。
 *
 * bg.glo 变体参数口径：detail/goods.create 传 productIdList（实测确认）；
 * ad.create/ad.modify 请求结构按官方文档（.zcode/temu-doc-audit/
 * doc-bg.glo.searchrec.ad.create/modify.json，2026-06-25 版）——create 为
 * createAdReqs[{productId, budget, roas(实际值×10000), roasType}]，响应读
 * successProductIdLists/successCreateProductNum（无 successGoodsIdLists/
 * alreadyCreatedGoodsNum 字段）；modify 为 {modifyAdDTO:{productId, roas,
 * budget}, status}。
 */

const AD_CREATE_ROAS_TYPE = 1

/** detail.query summary 指标（四维结构取 ad 推广维度；字段名 adSpend/spend 两口径都认） */
function adDetailMetric(detail: Record<string, unknown>, names: string[]): number | null {
  const summary = isRecord(detail.summary) ? detail.summary : {}
  for (const name of names) {
    const m = isRecord(summary[name]) ? (summary[name] as Record<string, unknown>) : {}
    const d = isRecord(m.ad) ? (m.ad as Record<string, unknown>) : {}
    const v = num(d.val)
    if (v != null) return v
  }
  return null
}

/** 广告组频控削峰（实测背靠背两次调用即 4000004），分批 detail.query 间停顿 */
const ADS_BATCH_SIZE = 20

export interface TemuAdPlanRow {
  productId: string
  productName: string | null
  mainImageUrl: string | null
  productSn: string | null
  /** 实时预算（分）与目标 ROAS（detail.query） */
  budget: number | null
  roas: number | null
  adShowStatus: number | null
  adShowStatusLabel: string
  adPhase: number | null
  /** 实时指标摘要（分） */
  spendFen: number | null
  orderPayAmtFen: number | null
  roasSummary: number | null
  /** 实时成交订单数（summary.orderPayCnt，卡片兜底口径用） */
  orderCnt: number | null
  createdAt: string
}

/** 我的广告查询入参（store 非 uuid 时在查库前收口为友好错误） */
const temuAdPlansQuerySchema = z.object({
  store: z.string().uuid(),
})

/** 我的广告（注册表 + detail.query 实时状态/指标，30s 缓存） */
export async function getTemuAdPlansAction(input: {
  store: string
}): Promise<{ ok: true; rows: TemuAdPlanRow[] } | { ok: false; error: string }> {
  const parsed = temuAdPlansQuerySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  return temuCached(`${store.enterpriseId}:ad-plans:${store.id}`, () => loadAdPlans(store))
}

async function loadAdPlans(
  store: StoreRow,
): Promise<{ ok: true; rows: TemuAdPlanRow[] } | { ok: false; error: string }> {
  const registry = await db
    .select({
      productId: temuAds.productId,
      budget: temuAds.budget,
      roas: temuAds.roas,
      createdAt: temuAds.createdAt,
      productName: temuProducts.productName,
      mainImageUrl: temuProducts.mainImageUrl,
      productSn: temuProducts.productSn,
    })
    .from(temuAds)
    .leftJoin(
      temuProducts,
      and(eq(temuAds.productId, temuProducts.productId), eq(temuAds.storeId, temuProducts.storeId)),
    )
    .where(eq(temuAds.storeId, store.id))
  if (registry.length === 0) return { ok: true, rows: [] }

  const built = buildCallContext(store, await getTemuCallContext(store))
  if (!built.ok) return built

  // detail.query 实时状态（adsDetail 以 productId 对齐；批量间停顿削峰）
  const details = new Map<string, Record<string, unknown>>()
  try {
    const ids = registry.map((r) => Number(r.productId)).filter(Number.isFinite)
    for (let i = 0; i < ids.length; i += ADS_BATCH_SIZE) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500))
      const envelope = await callTemuApi<{ adsDetail?: unknown }>(
        "bg.glo.searchrec.ad.detail.query",
        { productIdList: ids.slice(i, i + ADS_BATCH_SIZE) },
        built.ctx,
      )
      for (const d of asList(envelope.result?.adsDetail)) {
        const pid = idStr(d.goodsId ?? d.productId, 32)
        if (pid) details.set(pid, d)
      }
    }
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(store.id, err) }
  }

  const rows: TemuAdPlanRow[] = registry.map((r) => {
    const d = details.get(r.productId)
    const status = d ? num(d.adShowStatus) : null
    return {
      productId: r.productId,
      productName: r.productName,
      mainImageUrl: r.mainImageUrl,
      productSn: r.productSn,
      budget: d ? num(d.budget) : r.budget,
      roas: d ? num(d.roas) : r.roas,
      adShowStatus: status,
      adShowStatusLabel:
        status != null ? TEMU_AD_SHOW_STATUS[status] ?? `状态码 ${status}` : "无实时状态",
      adPhase: d ? num(d.adPhase) : null,
      spendFen: d ? adDetailMetric(d, ["adSpend", "spend"]) : null,
      orderPayAmtFen: d ? adDetailMetric(d, ["orderPayAmt"]) : null,
      roasSummary: d ? adDetailMetric(d, ["roas"]) : null,
      orderCnt: d ? adDetailMetric(d, ["orderPayCnt"]) : null,
      createdAt: r.createdAt.toISOString(),
    }
  })
  return { ok: true, rows }
}

export interface TemuAdProductRow {
  productId: string
  productName: string | null
  productSn: string | null
  mainImageUrl: string | null
  /** 已在注册表（本站已创建过广告） */
  advertised: boolean
  /** goods.create.query 可投性；false 时 grayReasons 给原因 */
  eligible: boolean
  grayReasons: string[]
}

/** 创建广告候选商品（temu_product 同步列表 + 可投性/已创建合并，30s 缓存） */
export async function listTemuAdProductsAction(input: {
  store: string
  q?: string
}): Promise<{ ok: true; rows: TemuAdProductRow[] } | { ok: false; error: string }> {
  const q = temuAdProductsQuerySchema.parse(input)
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  return temuCached(`${store.enterpriseId}:ad-products:${store.id}:${q.q ?? ""}`, () =>
    loadAdProducts(store, q.q),
  )
}

async function loadAdProducts(
  store: StoreRow,
  q?: string,
): Promise<{ ok: true; rows: TemuAdProductRow[] } | { ok: false; error: string }> {
  // 搜索下推 SQL：单店全量可达上千 SKC（api-goods-list 每店全量同步），
  // 「任意 60 行后再应用层过滤」会漏掉窗口外商品——q 命中 productName/
  // productSn 的 ilike 或 productId 精确匹配；稳定排序保证候选列表不抖动
  const trimmed = q?.trim()
  const like = trimmed ? `%${trimmed}%` : null
  const products = await db
    .select({
      productId: temuProducts.productId,
      productName: temuProducts.productName,
      productSn: temuProducts.productSn,
      mainImageUrl: temuProducts.mainImageUrl,
    })
    .from(temuProducts)
    .where(
      and(
        eq(temuProducts.storeId, store.id),
        ...(like
          ? [
              or(
                ilike(temuProducts.productName, like),
                ilike(temuProducts.productSn, like),
                eq(temuProducts.productId, trimmed!),
              )!,
            ]
          : []),
      ),
    )
    .orderBy(desc(temuProducts.lastSeenAt), desc(temuProducts.productSkcId))
    .limit(300)
  // 同 productId 多 SKC 去重后截断 60（候选弹窗展示上限；300 行取数兜住
  // 多 SKC 重复，去重后不足 60 时也覆盖单店绝大多数候选场景）
  const seen = new Set<string>()
  const unique: {
    productId: string
    productName: string | null
    productSn: string | null
    mainImageUrl: string | null
  }[] = []
  for (const p of products) {
    if (!p.productId || seen.has(p.productId)) continue
    seen.add(p.productId)
    unique.push({
      productId: p.productId,
      productName: p.productName,
      productSn: p.productSn,
      mainImageUrl: p.mainImageUrl,
    })
    if (unique.length >= 60) break
  }

  const advertised = new Set(
    (
      await db
        .select({ productId: temuAds.productId })
        .from(temuAds)
        .where(eq(temuAds.storeId, store.id))
    ).map((r) => r.productId),
  )

  const rows: TemuAdProductRow[] = unique.map((p) => ({
    productId: p.productId,
    productName: p.productName,
    productSn: p.productSn,
    mainImageUrl: p.mainImageUrl,
    advertised: advertised.has(p.productId),
    eligible: false,
    grayReasons: [],
  }))
  if (rows.length === 0) return { ok: true, rows }

  const built = buildCallContext(store, await getTemuCallContext(store))
  if (!built.ok) return built
  try {
    const envelope = await callTemuApi<{ goodsInfoList?: unknown }>(
      "bg.glo.searchrec.ad.goods.create.query",
      { productIdList: rows.map((r) => Number(r.productId)).filter(Number.isFinite) },
      built.ctx,
    )
    // 返回 entries 语义：出现且无 grayReason=可投；带原因=不可投；未出现=不可投（接口未返回原因）
    const infoBy = new Map<string, string[]>()
    for (const it of asList(envelope.result?.goodsInfoList)) {
      const pid = idStr(it.goodsId ?? it.productId, 32)
      if (!pid) continue
      infoBy.set(
        pid,
        asList(it.grayReason)
          .map((g) => str(g.reason, 120))
          .filter((v): v is string => !!v),
      )
    }
    for (const r of rows) {
      const reasons = infoBy.get(r.productId)
      if (reasons == null) {
        r.grayReasons = ["接口未返回可投标记（视为不可投）"]
      } else if (reasons.length === 0) {
        r.eligible = true
      } else {
        r.grayReasons = reasons
      }
    }
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(store.id, err) }
  }
  return { ok: true, rows }
}

/** 创建广告（bg.glo.searchrec.ad.create，需广告推广页权限）→ 逐商品结果 + 注册表登记成功项 */
export async function createTemuAdsAction(input: unknown): Promise<
  | {
      ok: true
      successCount: number
      alreadyCount: number
      fails: { productId: string; reason: string | null }[]
    }
  | { ok: false; error: string }
> {
  const q = temuAdCreateSchema.parse(input)
  const guard = await requireTemuStore(q.store, "temu_ads")
  if (!guard.ok) return guard
  const built = buildCallContext(guard.store, await getTemuCallContext(guard.store))
  if (!built.ok) return { ok: false, error: built.error }
  const byId = new Map(q.items.map((it) => [it.productId, it]))
  try {
    // 官方口径（doc-bg.glo.searchrec.ad.create.json）：createAdReqs 条目为
    // {productId, budget, roas(实际值×10000 整数), roasType}——无 goodsId 字段
    const envelope = await callTemuApi<{
      successCreateProductNum?: number
      successProductIdLists?: unknown
      createGoodsFailObjList?: unknown
    }>(
      "bg.glo.searchrec.ad.create",
      {
        createAdReqs: q.items.map((it) => ({
          productId: Number(it.productId),
          budget: it.budget,
          roas: Math.round(it.roas * 10000),
          roasType: AD_CREATE_ROAS_TYPE,
        })),
      },
      built.ctx,
    )
    const successIds = (Array.isArray(envelope.result?.successProductIdLists)
      ? envelope.result.successProductIdLists
      : []
    )
      .map((v) => idStr(v, 32))
      .filter((v): v is string => !!v)
    if (successIds.length > 0) {
      await db
        .insert(temuAds)
        .values(
          successIds
            .map((pid) => byId.get(pid))
            .filter((it): it is { productId: string; budget: number; roas: number } => !!it)
            .map((it) => ({
              storeId: guard.store.id,
              productId: it.productId,
              budget: it.budget,
              roas: it.roas,
            })),
        )
        .onConflictDoNothing()
    }
    invalidateTemuCache(guard.store.enterpriseId)
    return {
      ok: true,
      successCount: successIds.length,
      // 官方响应无 alreadyCreatedGoodsNum 对应字段；「已创建」类失败经
      // createGoodsFailObjList 的 reason 呈现，此处恒 0（保留字段兼容 UI）
      alreadyCount: 0,
      fails: asList(envelope.result?.createGoodsFailObjList)
        .map((f) => ({
          productId: idStr(f.productId ?? f.goodsId, 32) ?? "",
          reason: str(f.reason, 300),
        }))
        .filter((f) => !!f.productId),
    }
  } catch (err) {
    const message = await toWorkbenchError(guard.store.id, err)
    const hint = message.includes("bad query params")
      ? "（官方拒绝了请求参数：请确认店铺已签署广告协议（230016103）且接口组已授权，roas 已按实际值×10000 取整提交）"
      : message.includes("230016103")
        ? "（该店铺尚未签署广告协议，请主账号在卖家后台 ads.temu.com 签署后重试）"
        : ""
    return { ok: false, error: `${message}${hint}` }
  }
}

/** 修改广告（bg.glo.searchrec.ad.modify，需广告推广页权限）：暂停/开启/改预算/改目标ROAS */
export async function modifyTemuAdAction(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const q = temuAdModifySchema.parse(input)
  if (q.action === "budget" && q.budget == null) return { ok: false, error: "缺少新预算" }
  if (q.action === "roas" && q.roas == null) return { ok: false, error: "缺少新目标 ROAS" }
  const guard = await requireTemuStore(q.store, "temu_ads")
  if (!guard.ok) return guard
  const built = buildCallContext(guard.store, await getTemuCallContext(guard.store))
  if (!built.ok) return { ok: false, error: built.error }
  const code = { pause: 2, open: 3, budget: 4, roas: 5 }[q.action]
  const [current] = await db
    .select({ budget: temuAds.budget, roas: temuAds.roas })
    .from(temuAds)
    .where(and(eq(temuAds.storeId, guard.store.id), eq(temuAds.productId, q.productId)))
    .limit(1)
  try {
    // 官方口径（doc-bg.glo.searchrec.ad.modify.json）：商品字段包在
    // modifyAdDTO{productId, roas, budget} 内 + 顶层 status（2/3/4/5 枚举）
    await callTemuApi(
      "bg.glo.searchrec.ad.modify",
      {
        modifyAdDTO: {
          productId: Number(q.productId),
          budget: q.budget ?? current?.budget ?? undefined,
          roas: q.roas ?? current?.roas ?? undefined,
        },
        status: code,
      },
      built.ctx,
    )
  } catch (err) {
    const message = await toWorkbenchError(guard.store.id, err)
    const hint = message.includes("bad query params")
      ? "（官方拒绝了请求参数：请核对商品是否有在售广告与 status 枚举是否匹配操作类型）"
      : ""
    return { ok: false, error: `${message}${hint}` }
  }
  if (q.budget != null || q.roas != null) {
    await db
      .update(temuAds)
      .set({
        ...(q.budget != null ? { budget: q.budget } : {}),
        ...(q.roas != null ? { roas: q.roas } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(temuAds.storeId, guard.store.id), eq(temuAds.productId, q.productId)))
  }
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true }
}
