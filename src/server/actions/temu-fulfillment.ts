"use server"

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db/client"
import { temuProducts, temuSalesOverviews, temuStores } from "@/db/schema"
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
  TemuApiError,
} from "@/lib/temu-api/client"
import { getTemuCallContext } from "@/server/services/temu-sync"
import { temuCached, invalidateTemuCache } from "@/server/services/temu-cache"
import { PURCHASE_ORDER_STATUS } from "@/lib/temu-api/workbench-labels"
import {
  temuPurchaseQuerySchema,
  temuPurchaseCancelSchema,
  temuStockableQuerySchema,
  temuStockApplyBatchSchema,
  temuAutoStockSchema,
} from "@/server/schemas/temu"

/**
 * Temu 备货工作台 Server Actions（M5-A 履约：采购单查询/取消 + VMI 批量申报/自动备货）
 *
 * 与核价调价工作台同模式：实时拉取不落库（备货单时效强、状态随发货推进，
 * 落库反而陈旧），读走 temu-cache 30s 短缓存；写操作校验备货页 tab 模块
 * 权限（页面可见即可用按钮，2026-10-22 口径）。
 * 接口口径 docs §8.13：purchaseorderv2.get 分页 + statusList 过滤、
 * cancel 结构来自 temu-go SDK 并经实测推进验证（单条 apply/edit 与条码
 * labelv2 入口 2026-10-22 随备货单 UI 收敛移除，批量申报仍走 apply）。
 */

/* ─── 状态预设（statusList 组合；状态字典 PURCHASE_ORDER_STATUS 在 workbench-labels） ─── */

/** 状态预设 → statusList（官方口径只有 statusList 有效，purchaseOrderStatus/status 被忽略）。
 *  closed 不含 10：官方入参枚举止于 9-已超时（doc-bg.purchaseorderv2.get.json），
 *  10-已取消为 temu-go 口径、未经官方文档确认，混入或致整组校验失败 */
const STATUS_PRESET: Record<string, number[] | undefined> = {
  todo: [0, 1],
  shipped: [2, 3],
  closed: [4, 5, 6, 7, 8, 9],
  all: undefined,
}

/* ─── 公共（与 temu-workbench 同款守卫，"use server" 文件仅能导出 async 函数故内联） ─── */

type StoreRow = typeof temuStores.$inferSelect

/** 校验店铺归属当前企业并返回店铺行（与 temu-workbench 同款守卫，
 *  "use server" 文件仅能导出 async 函数故内联）。requireModule：写操作传
 *  对应 tab 模块（页面可见即可用按钮）；查询传 null */
async function requireTemuStore(
  storeId: string,
  requireModule: ModuleName | null,
): Promise<{ ok: true; store: StoreRow } | { ok: false; error: string }> {
  let ctx
  try {
    ctx = await requireEnterpriseContext()
  } catch (err) {
    // 鉴权层抛错（FORBIDDEN: 需要企业管理员权限 / 未登录）转面板可读信息
    return {
      ok: false,
      error: err instanceof Error ? err.message.replace(/^FORBIDDEN: /, "") : String(err),
    }
  }
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

/* ─── 备货单查询 ─── */

export interface TemuPurchaseSkuRow {
  productSkuId: string
  /** 规格（颜色/尺码） */
  className: string | null
  /** 平台建议备货量 */
  adviceQuantity: number | null
  /** 已申报下单量 */
  purchaseQuantity: number | null
  /** 已发货量 */
  deliverQuantity: number | null
  /** 单 SKU 申报上限 */
  purchaseUpLimit: number | null
  thumbUrl: string | null
}

export interface TemuPurchaseOrderRow {
  subPurchaseOrderSn: string
  originalPurchaseOrderSn: string | null
  productSkcId: string | null
  /** 商品货号（官方顶层 productSn，2026-10-22 真实店探针实证） */
  productSn: string | null
  productName: string | null
  productPicture: string | null
  category: string | null
  status: number
  statusLabel: string
  /** 定制品不可申报（官方 3002） */
  isCustomProduct: boolean
  /** 1=紧急单 */
  urgencyType: number | null
  todayCanDeliver: boolean
  /** 可加量（edit 的业务门槛） */
  supportIncreaseNum: boolean
  /** 官方标记：可加入发货台（发货链路入口门槛） */
  isCanJoinDeliverPlatform: boolean
  /** 缺货标记 */
  lackTag: boolean
  purchaseTime: number | null
  expectLatestDeliverTime: number | null
  expectLatestArrivalTime: number | null
  receiveWarehouseName: string | null
  skuRows: TemuPurchaseSkuRow[]
  adviceTotal: number
  purchaseTotal: number
  deliverTotal: number
}

/** 备货单列表（bg.purchaseorderv2.get，实时 + 30s 缓存；默认待办=待接单+已接单待发货） */
export async function getTemuPurchaseOrdersAction(input: {
  store: string
  status?: string
}): Promise<{ ok: true; rows: TemuPurchaseOrderRow[]; total: number } | { ok: false; error: string }> {
  const q = temuPurchaseQuerySchema.parse(input)
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  return temuCached(`${store.enterpriseId}:purchase:${store.id}:${q.status}`, () =>
    loadPurchaseOrders(store, q.status),
  )
}

async function loadPurchaseOrders(
  store: StoreRow,
  status: string,
): Promise<{ ok: true; rows: TemuPurchaseOrderRow[]; total: number } | { ok: false; error: string }> {
  const built = await getTemuCallContext(store)
  if ("error" in built) return { ok: false, error: built.error }
  const statusList = STATUS_PRESET[status]
  const params: Record<string, unknown> = { pageNo: 1, pageSize: 50 }
  if (statusList) params.statusList = statusList
  const rows: TemuPurchaseOrderRow[] = []
  let total = 0
  try {
    for (let pageNo = 1; pageNo <= 4; pageNo += 1) {
      const envelope = await callTemuApi<{
        total?: number
        subOrderForSupplierList?: unknown
      }>("bg.purchaseorderv2.get", { ...params, pageNo }, built)
      total = num(envelope.result?.total) ?? total
      const pageRows = asList(envelope.result?.subOrderForSupplierList)
      for (const it of pageRows) {
        const sn = str(it.subPurchaseOrderSn, 64)
        if (!sn) continue
        const skuRows: TemuPurchaseSkuRow[] = asList(it.skuQuantityDetailList)
          .map((s) => ({
            productSkuId: idStr(s.productSkuId, 32) ?? "",
            className: str(s.className, 120),
            adviceQuantity: num(s.adviceQuantity),
            purchaseQuantity: num(s.purchaseQuantity),
            deliverQuantity: num(s.deliverQuantity),
            purchaseUpLimit: num(s.purchaseUpLimit),
            thumbUrl: Array.isArray(s.thumbUrlList) ? str(s.thumbUrlList[0], 1000) : null,
          }))
          .filter((s) => !!s.productSkuId)
        const statusNum = num(it.status) ?? -1
        const deliverInfo = isRecord(it.deliverInfo) ? it.deliverInfo : {}
        rows.push({
          subPurchaseOrderSn: sn,
          originalPurchaseOrderSn: str(it.originalPurchaseOrderSn, 64),
          productSkcId: idStr(it.productSkcId, 32),
          productSn: str(it.productSn, 64),
          productName: str(it.productName, 500),
          productPicture: str(it.productSkcPicture, 1000),
          category: str(it.category, 120),
          status: statusNum,
          statusLabel: PURCHASE_ORDER_STATUS[statusNum] ?? `未知(${it.status})`,
          isCustomProduct: it.isCustomProduct === true,
          urgencyType: num(it.urgencyType),
          todayCanDeliver: it.todayCanDeliver === true,
          supportIncreaseNum: it.supportIncreaseNum === true,
          isCanJoinDeliverPlatform: it.isCanJoinDeliverPlatform === true,
          lackTag: asList(it.lackOrSoldoutTagList).some((t) => t.isLack === true),
          purchaseTime: num(it.purchaseTime),
          expectLatestDeliverTime: num(
            deliverInfo.expectLatestDeliverTimeOrDefault ?? it.expectLatestDeliverTimeOrDefault,
          ),
          expectLatestArrivalTime: num(
            deliverInfo.expectLatestArrivalTimeOrDefault ?? it.expectLatestArrivalTimeOrDefault,
          ),
          receiveWarehouseName: str(deliverInfo.receiveWarehouseName, 120),
          skuRows,
          adviceTotal: skuRows.reduce((s, r) => s + (r.adviceQuantity ?? 0), 0),
          purchaseTotal: skuRows.reduce((s, r) => s + (r.purchaseQuantity ?? 0), 0),
          deliverTotal: skuRows.reduce((s, r) => s + (r.deliverQuantity ?? 0), 0),
        })
      }
      if (pageRows.length < 50) break
    }
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(store.id, err) }
  }
  rows.sort((a, b) => (b.purchaseTime ?? 0) - (a.purchaseTime ?? 0))
  return { ok: true, rows, total }
}

/* ─── 写操作（需备货页 tab 权限） ─── */

/** 批量取消备货单（bg.purchaseorder.cancel；仅待接单等早期状态，官方按单返回成败） */
export async function cancelTemuPurchaseOrdersAction(
  input: unknown,
): Promise<{ ok: true; failed: Array<{ sn: string; reason: string }> } | { ok: false; error: string }> {
  const q = temuPurchaseCancelSchema.parse(input)
  const guard = await requireTemuStore(q.store, "temu_purchase")
  if (!guard.ok) return { ok: false, error: guard.error }
  const built = await getTemuCallContext(guard.store)
  if ("error" in built) return { ok: false, error: built.error }
  let envelope: {
    result?: { successInfoList?: unknown; errorInfoList?: unknown; isSuccess?: boolean }
  }
  try {
    envelope = await callTemuApi("bg.purchaseorder.cancel", { subPurchaseOrderSnList: q.subPurchaseOrderSns }, built)
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(guard.store.id, err) }
  }
  // 官方按单返回成败（isSuccess=false 时 errorInfoList 列失败单原因）
  const failed = asList(envelope.result?.errorInfoList).map((e) => ({
    sn: str(e.subPurchaseOrderSn, 64) ?? "",
    reason: str(e.errorMsg ?? e.reason ?? e.failReason, 200) ?? "官方未返回原因",
  }))
  if (failed.length > 0 && failed.every((f) => !f.sn)) {
    return { ok: false, error: "官方拒绝了取消请求（单据状态或权限不满足）" }
  }
  // 取消落定后失效面板缓存：30s 内备货单待办不再把已取消单当待办
  // （与工作台写路径「直连后失效」口径一致）
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true, failed }
}

/* ─── 可申报备货商品（本地商品池 + salesv2 canPurchase） ─── */

export interface TemuStockableSku {
  skuId: string
  className: string | null
  canPurchase: boolean
}

export interface TemuStockableRow {
  productSkcId: string
  productName: string | null
  mainImageUrl: string | null
  /** 主图转存 URL（COS/本地；展示优先于 kwcdn 外链） */
  mainImageCosUrl: string | null
  productSn: string | null
  last7DaysSalesVolume: number | null
  warehouseAvailableStock: number | null
  availableSaleDays: number | null
  /** salesv2 任一 SKU canPurchase=true（官方无「可申报商品」查询接口，以此为准） */
  canPurchase: boolean
  skus: TemuStockableSku[]
}

/**
 * 可申报备货商品（本地 temu_product 在售池 join 最新销售行——库存/可售天数/
 * canPurchase/SKU 明细；官方无专门查询接口，VMI 申报按 SKC 直调 apply）。
 * 无搜索时按近 7 日销量降序取前 200（申报候选通常是动销品）。
 */
export async function getStockableProductsAction(input: {
  store: string
  q?: string
  onlyCanPurchase?: boolean
}): Promise<{ ok: true; rows: TemuStockableRow[] } | { ok: false; error: string }> {
  const q = temuStockableQuerySchema.parse(input)
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return guard
  const { store } = guard

  // 缓存键带 enterpriseId 前缀：申报/取消等写路径按企业前缀整体失效
  // （temu-cache invalidateTemuCache），单店裸键不会被覆盖到
  return temuCached(`${store.enterpriseId}:stockable:${store.id}:${q.q ?? ""}:${q.onlyCanPurchase}`, async () => {
    const conds = [
      eq(temuProducts.storeId, store.id),
      // 在售口径与商品页一致：官方 skcSiteStatus 1/11
      sql`${temuProducts.skcStatus} in (1, 11)`,
    ]
    if (q.q) {
      const like = `%${q.q}%`
      conds.push(
        or(
          ilike(temuProducts.productName, like),
          ilike(temuProducts.productSn, like),
          ilike(temuProducts.productSkcId, like),
        )!,
      )
    }
    const products = await db
      .select({
        productSkcId: temuProducts.productSkcId,
        productName: temuProducts.productName,
        mainImageUrl: temuProducts.mainImageUrl,
        mainImageCosUrl: temuProducts.mainImageCosUrl,
        productSn: temuProducts.productSn,
      })
      .from(temuProducts)
      .where(and(...conds))
      .orderBy(desc(temuProducts.productSkcId))
      .limit(200)
    if (products.length === 0) return { ok: true as const, rows: [] as TemuStockableRow[] }

    // 最新销售行（库存/可售天数/近7日销量/SKU 明细含 canPurchase）。
    // 注意 temu_product.last7_days_sales_volume 是插件时代死列（同步链路不写），
    // 近7日销量取最新销售行；可用库存列 warehouse_available_stock 官方已不在
    // SKC 顶层返回（恒空），改按 priceDetail 各 SKU inventoryNumInfo 求和（同商品页）
    const skcIds = products.map((p) => p.productSkcId)
    const salesRows = await db
      .select({
        skcId: temuSalesOverviews.skcId,
        last7DaysSalesVolume: temuSalesOverviews.last7DaysSalesVolume,
        availableSaleDays: temuSalesOverviews.availableSaleDays,
        priceDetail: temuSalesOverviews.priceDetail,
      })
      .from(temuSalesOverviews)
      .where(and(eq(temuSalesOverviews.storeId, store.id), inArray(temuSalesOverviews.skcId, skcIds)))
      .orderBy(desc(temuSalesOverviews.capturedAt))
    const latestBySkc = new Map<string, (typeof salesRows)[number]>()
    for (const row of salesRows) {
      if (!latestBySkc.has(row.skcId)) latestBySkc.set(row.skcId, row)
    }

    /** priceDetail 各 SKU 的仓库可用库存求和（官方仅 SKU 级返回，任一 SKU 有值即计） */
    const sumSkuWarehouseStock = (rows: unknown[]): number | null => {
      let sum = 0
      let any = false
      for (const item of rows) {
        const s = isRecord(item) ? item : null
        const inv = s && isRecord(s.inventoryNumInfo) ? s.inventoryNumInfo : null
        const v = inv ? num(inv.warehouseInventoryNum) : null
        if (v != null) {
          sum += v
          any = true
        }
      }
      return any ? sum : null
    }

    const rows: TemuStockableRow[] = []
    for (const p of products) {
      const latest = latestBySkc.get(p.productSkcId)
      const skuRows = asList(latest?.priceDetail)
      const skus: TemuStockableSku[] = skuRows
        .map((s) => ({
          skuId: idStr(s.productSkuId, 32) ?? "",
          className: str(s.className, 120),
          canPurchase: s.canPurchase === true,
        }))
        .filter((s) => !!s.skuId)
      const canPurchase = skus.some((s) => s.canPurchase)
      if (q.onlyCanPurchase && !canPurchase) continue
      rows.push({
        productSkcId: p.productSkcId,
        productName: p.productName,
        mainImageUrl: p.mainImageUrl,
        mainImageCosUrl: p.mainImageCosUrl,
        productSn: p.productSn,
        last7DaysSalesVolume: latest?.last7DaysSalesVolume ?? null,
        warehouseAvailableStock: sumSkuWarehouseStock(skuRows),
        availableSaleDays: latest?.availableSaleDays ?? null,
        canPurchase,
        skus,
      })
    }
    // 默认排序按真实近7日销量（商品表死列排序会退化为 skcId 倒序）
    rows.sort((a, b) => (b.last7DaysSalesVolume ?? 0) - (a.last7DaysSalesVolume ?? 0))
    return { ok: true as const, rows }
  })
}

export interface TemuStockApplyBatchResult {
  productSkcId: number
  productName: string
  ok: boolean
  error?: string
}

/**
 * 批量申报备货（逐项串行调 bg.purchaseorder.apply，3qps 令牌桶控频）。
 * 数量/商品限制以官方错误原样透传（apply 上限官方未文档化——定制品 3002、
 * 非本店商品 2000000 已实测；量上限首次真实申报确认）。
 */
export async function batchApplyTemuStockingAction(
  input: unknown,
): Promise<{ ok: true; results: TemuStockApplyBatchResult[] } | { ok: false; error: string }> {
  const q = temuStockApplyBatchSchema.parse(input)
  const guard = await requireTemuStore(q.store, "temu_purchase")
  if (!guard.ok) return guard
  const built = await getTemuCallContext(guard.store)
  if ("error" in built) return { ok: false, error: built.error }

  const results: TemuStockApplyBatchResult[] = []
  for (const item of q.items) {
    try {
      await callTemuApi(
        "bg.purchaseorder.apply",
        {
          productSkcId: item.productSkcId,
          purchaseDetailList: item.skuIds.map((id) => ({
            productSkuId: Number(id),
            productSkuPurchaseQuantity: item.quantity,
          })),
        },
        built,
      )
      results.push({ productSkcId: item.productSkcId, productName: item.productName ?? "", ok: true })
    } catch (err) {
      results.push({
        productSkcId: item.productSkcId,
        productName: item.productName ?? "",
        ok: false,
        error: await toWorkbenchError(guard.store.id, err),
      })
    }
  }
  // 任一项申报成功都会改变备货单/可申报池，失效面板缓存（与工作台写路径对齐）
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true, results }
}

/* ─── 质检（bg.goods.qualityinspection.get/detail；参数表 docs §8.17 官方文档站实证，
     业务级未实测——必填分页是 pageInfo{pageNo,pageSize} 包装结构） ─── */

export interface TemuQcInspectionRow {
  /** 质检子单 id（详情入参） */
  qcBillId: number | null
  productSkuId: string | null
  productSkcId: string | null
  spuId: string | null
  skuName: string | null
  spec: string | null
  catName: string | null
  purchaseNo: string | null
  qcResultUpdateTime: string | null
  thumbUrl: string | null
  /** 文档口径列表行不带质检结果值；官方若返回则透传（1-合格 2-不合格） */
  skuQcResult: number | null
}

/** 质检列表入参（skuQcResult/pageNo 畸形值在进官方接口前先收口为友好错误） */
const temuQcListQuerySchema = z.object({
  store: z.string().uuid(),
  /** 1-合格 2-不合格；缺省=全部 */
  skuQcResult: z.union([z.literal(1), z.literal(2)]).optional(),
  pageNo: z.coerce.number().int().min(1).max(500).default(1),
})

/** 质检列表（30s 缓存；默认筛选不合格由 UI 传 skuQcResult=2） */
export async function getTemuQualityInspectionsAction(input: {
  store: string
  /** 1-合格 2-不合格；缺省=全部 */
  skuQcResult?: 1 | 2
  pageNo?: number
}): Promise<{ ok: true; rows: TemuQcInspectionRow[]; total: number } | { ok: false; error: string }> {
  const parsed = temuQcListQuerySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  const { skuQcResult, pageNo } = parsed.data
  // 缓存键带 enterpriseId 前缀：写路径按企业前缀整体失效（同 stockable 键）
  return temuCached(`${store.enterpriseId}:qc-list:${store.id}:${skuQcResult ?? "all"}:${pageNo}`, async () => {
    const built = await getTemuCallContext(store)
    if ("error" in built) return { ok: false as const, error: built.error }
    try {
      const envelope = await callTemuApi<{ total?: unknown; skuList?: unknown }>(
        "bg.goods.qualityinspection.get",
        {
          pageInfo: { pageNo, pageSize: 20 },
          ...(skuQcResult ? { skuQcResult } : {}),
        },
        built,
      )
      const rows: TemuQcInspectionRow[] = asList(envelope.result?.skuList).map((it) => ({
        qcBillId: num(it.qcBillId),
        productSkuId: idStr(it.productSkuId, 32),
        productSkcId: idStr(it.productSkcId, 32),
        spuId: idStr(it.spuId, 32),
        skuName: str(it.skuName, 300),
        spec: str(it.spec, 120),
        catName: str(it.catName, 120),
        purchaseNo: str(it.purchaseNo, 64),
        qcResultUpdateTime: str(it.qcResultUpdateTime, 40),
        thumbUrl: str(it.thumbUrl, 500),
        skuQcResult: num(it.skuQcResult) ?? num(it.qcResult),
      }))
      return { ok: true as const, rows, total: num(envelope.result?.total) ?? rows.length }
    } catch (err) {
      return { ok: false as const, error: await toWorkbenchError(store.id, err) }
    }
  })
}

export interface TemuQcFlaw {
  name: string | null
  desc: string | null
  /** 严重程度码 */
  degree: number | null
  /** 严重程度文案（实测返回如「中等」） */
  degreeDesc: string | null
  images: string[]
  remark: string | null
  productSkuIds: string[]
}

export interface TemuQcSize {
  location: string | null
  sizeName: string | null
  minQcSize: string | null
  maxQcSize: string | null
  expectMinSize: string | null
  expectMaxSize: string | null
}

export interface TemuQcSkuRow {
  productSkuId: string | null
  sizeName: string | null
  expectQcQuantity: number | null
  defectiveQcQuantity: number | null
  totalQuantity: number | null
}

/** 质检历史条目：真实报文（2026-10-22 探针实证）为 historyVOS[]{...单据头, qcDetail{全部明细}}——
 *  qcDetail 仅随不合格/更正类历史项返回（疵点/尺码/SKU 行随单据走）；合格单
 *  历史项只有单据头、无 qcDetail（官方文档画在顶层，实际也不是） */
export interface TemuQcHistoryEntry {
  /** 1-质检单 2-稽查单 3-更正单（历史项层） */
  qcType: number | null
  qcBillNo: string | null
  startTime: string | null
  finishTime: string | null
  // 以下来自内嵌 qcDetail（缺失时为 null）
  detailQcType: number | null
  qcResult: number | null
  expectQcQuantity: number | null
  defectiveQcQuantity: number | null
  totalQuantity: number | null
  qcOperatorName: string | null
  qcStartTime: number | null
  qcEndTime: number | null
  auditName: string | null
  auditTime: number | null
  receiptNo: string | null
  qcGroupName: string | null
  deliveryQcTime: number | null
  skus: TemuQcSkuRow[]
  flaws: TemuQcFlaw[]
  sizes: TemuQcSize[]
}

export interface TemuQcDetail {
  histories: TemuQcHistoryEntry[]
}

/** 质检详情入参（qcBillId 畸形值在进官方接口前先收口为友好错误） */
const temuQcDetailQuerySchema = z.object({
  store: z.string().uuid(),
  qcBillId: z.coerce.number().int().positive(),
})

/** 质检结果详情（qcBillId 来自列表行；真实结构=historyVOS 每条可内嵌 qcDetail） */
export async function getTemuQualityInspectionDetailAction(input: {
  store: string
  qcBillId: number
}): Promise<{ ok: true; detail: TemuQcDetail } | { ok: false; error: string }> {
  const parsed = temuQcDetailQuerySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, null)
  if (!guard.ok) return guard
  const built = await getTemuCallContext(guard.store)
  if ("error" in built) return { ok: false, error: built.error }
  try {
    const envelope = await callTemuApi<Record<string, unknown>>(
      "bg.goods.qualityinspectiondetail.get",
      { qcBillId: parsed.data.qcBillId },
      built,
    )
    const r = envelope.result ?? {}
    const mapFlaws = (d: Record<string, unknown>): TemuQcFlaw[] =>
      asList(d.flawDTOList).map((f) => ({
        name: str(f.flawNameDesc ?? f.flawName, 200),
        desc: str(f.flawDesc, 200),
        degree: num(f.flawDegree),
        degreeDesc: str(f.flawDegreeDesc, 60),
        images: (Array.isArray(f.attachments) ? f.attachments : [])
          .map((x) =>
            typeof x === "string" ? str(x, 1000) : isRecord(x) ? str(x.url, 1000) : null,
          )
          .filter((x): x is string => !!x),
        remark: str(f.remark, 300),
        productSkuIds: (Array.isArray(f.productSkuId) ? f.productSkuId : [])
          .map((x) => idStr(x, 32))
          .filter((x): x is string => !!x),
      }))
    const mapSizes = (d: Record<string, unknown>): TemuQcSize[] =>
      asList(d.sizeDTOList).map((s) => ({
        location: str(s.locationTypeName, 60),
        sizeName: str(s.sizeName, 60),
        minQcSize: str(s.minQcSize, 32),
        maxQcSize: str(s.maxQcSize, 32),
        expectMinSize: str(s.expectMinSize, 32),
        expectMaxSize: str(s.expectMaxSize, 32),
      }))
    const mapSkus = (d: Record<string, unknown>): TemuQcSkuRow[] =>
      asList(d.skuDTOList).map((s) => ({
        productSkuId: idStr(s.productSkuId, 32),
        sizeName: str(s.sizeName, 60),
        expectQcQuantity: num(s.expectQcQuantity),
        defectiveQcQuantity: num(s.defectiveQcQuantity),
        totalQuantity: num(s.totalQuantity),
      }))
    // 实测口径：qcDetail 仅随不合格/更正历史项内嵌，合格单历史项无此键（d 为空对象兜底）
    const histories: TemuQcHistoryEntry[] = asList(r.historyVOS).map((h) => {
      const d = isRecord(h.qcDetail) ? h.qcDetail : {}
      return {
        qcType: num(h.qcType),
        qcBillNo: str(h.qcBillNo, 64) ?? str(d.qcBillNo, 64),
        startTime: str(h.startTime, 40),
        finishTime: str(h.finishTime, 40),
        detailQcType: num(d.qcType),
        qcResult: num(d.qcResult) ?? num(h.qcResult),
        expectQcQuantity: num(d.expectQcQuantity),
        defectiveQcQuantity: num(d.defectiveQcQuantity),
        totalQuantity: num(d.totalQuantity),
        qcOperatorName: str(d.qcOperatorName, 120),
        qcStartTime: num(d.qcStartTime),
        qcEndTime: num(d.qcEndTime),
        auditName: str(d.auditName, 120),
        auditTime: num(d.auditTime),
        receiptNo: str(d.receiptNo, 64),
        qcGroupName: str(d.qcGroupName, 120),
        deliveryQcTime: num(d.deliveryQcTime),
        skus: mapSkus(d),
        flaws: mapFlaws(d),
        sizes: mapSizes(d),
      }
    })
    // 防御：若官方某天把 qcDetail 放回顶层（文档口径），无历史时兜底一条
    if (histories.length === 0 && isRecord(r.qcDetail)) {
      const d = r.qcDetail
      histories.push({
        qcType: num(d.qcType),
        qcBillNo: str(d.qcBillNo, 64),
        startTime: null,
        finishTime: null,
        detailQcType: num(d.qcType),
        qcResult: num(d.qcResult),
        expectQcQuantity: num(d.expectQcQuantity),
        defectiveQcQuantity: num(d.defectiveQcQuantity),
        totalQuantity: num(d.totalQuantity),
        qcOperatorName: str(d.qcOperatorName, 120),
        qcStartTime: num(d.qcStartTime),
        qcEndTime: num(d.qcEndTime),
        auditName: str(d.auditName, 120),
        auditTime: num(d.auditTime),
        receiptNo: str(d.receiptNo, 64),
        qcGroupName: str(d.qcGroupName, 120),
        deliveryQcTime: num(d.deliveryQcTime),
        skus: mapSkus(d),
        flaws: mapFlaws(d),
        sizes: mapSizes(d),
      })
    }
    const detail: TemuQcDetail = { histories }
    return { ok: true, detail }
  } catch (err) {
    return { ok: false, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/* ─── 自动备货（apply 大数值钓官方上限 → SKU 级判断按最大量备满；
     上限查询无专用接口，官方错误文案返回上限——错误格式未实测，UI 先试跑确认） ─── */

const AUTO_STOCK_SLEEP_MS = 350
const autoSleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface TemuAutoStockSkuLimit {
  skuId: string
  /** 解析出的最大可申请量；null=未能解析 */
  maxQuantity: number | null
}

export interface TemuAutoStockResult {
  dryRun: boolean
  /** 探测的官方原始错误（试跑展示/排障） */
  rawError: string | null
  skuLimits: TemuAutoStockSkuLimit[]
  /** 达标并已按最大量申报的 SKU */
  applied: Array<{ skuId: string; quantity: number }>
  /** 全部低于最低量时的回填建议（各 SKU 最大量的最小值，统一量安全值） */
  backfillQuantity?: number
  /** 探测被官方意外接受后已按单回滚 */
  rolledBack?: boolean
  rollbackNote?: string
}

/** 从探测错误的官方原始文案解析上限数字（0=不可申报也是有效上限）：先剔除 skuId 自身数字
 *  与错误码（本次 errorCode / 3002 / 3000 定制品码），再按数量对齐；单数字=各 SKU 同值 */
function parseLimitsFromError(
  officialMsg: string,
  skuIds: string[],
  errCode?: number,
): Array<number | null> {
  let msg = officialMsg
  for (const id of skuIds) msg = msg.split(id).join(" ")
  const nums = (msg.match(/\d+/g) ?? [])
    .map(Number)
    .filter((n) => n >= 0 && n <= 100_000 && n !== 3002 && n !== 3000 && n !== errCode)
  if (nums.length === 0) return skuIds.map(() => null)
  if (nums.length === 1) return skuIds.map(() => nums[0]!)
  if (nums.length === skuIds.length) return nums
  return skuIds.map(() => null)
}

/** 单链接自动备货：探测（大数值）→ 解析上限 → 达标 SKU 按最大量申报；客户端逐链接调用 */
export async function autoStockingLinkAction(
  input: unknown,
): Promise<{ ok: true; result: TemuAutoStockResult } | { ok: false; error: string }> {
  const q = temuAutoStockSchema.parse(input)
  const guard = await requireTemuStore(q.store, "temu_purchase")
  if (!guard.ok) return guard
  const built = await getTemuCallContext(guard.store)
  if ("error" in built) return { ok: false, error: built.error }

  // 1) 探测：全 SKU 报大数值，期望官方以错误文案返回各自上限
  let rawError: string | null = null
  let officialMsg: string | null = null
  let errCode: number | undefined
  let probeAccepted = false
  let probeRaw = ""
  try {
    const env = await callTemuApi<Record<string, unknown>>(
      "bg.purchaseorder.apply",
      {
        productSkcId: q.productSkcId,
        purchaseDetailList: q.skuIds.map((id) => ({
          productSkuId: Number(id),
          productSkuPurchaseQuantity: q.probeQuantity,
        })),
      },
      built,
    )
    probeAccepted = true
    probeRaw = JSON.stringify(env.result ?? env)
  } catch (err) {
    rawError = await toWorkbenchError(guard.store.id, err)
    // 解析只认官方原始文案——格式化文案带「返回失败（1006）：」会污染数字
    if (err instanceof TemuApiError) {
      officialMsg = err.errorMsg ?? null
      errCode = err.errorCode
    }
  }
  if (probeAccepted) {
    // 探测被官方接受（无上限拦截）：尽力回滚，绝不停留在大数值申报
    const raw = probeRaw
    const sns = [
      ...new Set(
        [...raw.matchAll(/"(?:subPurchaseOrderSn|purchaseOrderSn)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!),
      ),
    ]
    let rolledBack = false
    let rollbackNote: string
    if (sns.length > 0) {
      await autoSleep(AUTO_STOCK_SLEEP_MS)
      try {
        await callTemuApi("bg.purchaseorder.cancel", { subPurchaseOrderSnList: sns }, built)
        rolledBack = true
        rollbackNote = `探测申报意外被官方接受，已自动取消回滚（${sns.length} 单）——该链接上限未知，建议人工处理`
      } catch {
        rollbackNote = `探测申报意外被官方接受且自动取消失败（${sns.join("、")}）——请立即到「备货单」页手动取消！`
      }
    } else {
      rollbackNote = "探测申报被官方接受且响应未含单号——请立即到「备货单」页核查并手动取消！"
    }
    // 探测已真实产生/取消过备货单，失效面板缓存让备货单列表立即反映回滚结果
    invalidateTemuCache(guard.store.enterpriseId)
    return {
      ok: true,
      result: {
        dryRun: q.dryRun,
        rawError: null,
        skuLimits: q.skuIds.map((id) => ({ skuId: id, maxQuantity: q.probeQuantity })),
        applied: [],
        rolledBack,
        rollbackNote,
      },
    }
  }

  // 2) 解析上限（数量对齐 skuIds；单数字=各 SKU 同值；对不齐=解析失败交试跑人工确认）
  const limits = parseLimitsFromError(officialMsg ?? rawError ?? "", q.skuIds, errCode)
  const skuLimits: TemuAutoStockSkuLimit[] = q.skuIds.map((id, i) => ({
    skuId: id,
    maxQuantity: limits[i] ?? null,
  }))
  if (q.dryRun) {
    return { ok: true, result: { dryRun: true, rawError, skuLimits, applied: [] } }
  }

  // 3) SKU 级判断：达标按最大量备满申报；全部低于→不申报，返回回填建议
  const qualified = skuLimits.filter((x) => x.maxQuantity != null && x.maxQuantity >= q.minQuantity)
  if (qualified.length === 0) {
    const valid = skuLimits.map((x) => x.maxQuantity).filter((x): x is number => x != null)
    const backfill = valid.length > 0 ? Math.min(...valid) : null
    return {
      ok: true,
      result: {
        dryRun: false,
        rawError,
        skuLimits,
        applied: [],
        // 上限 0=当前不可申报，回填无意义；仅正数上限回填
        ...(backfill != null && backfill > 0 ? { backfillQuantity: backfill } : {}),
      },
    }
  }
  await autoSleep(AUTO_STOCK_SLEEP_MS)
  try {
    await callTemuApi(
      "bg.purchaseorder.apply",
      {
        productSkcId: q.productSkcId,
        purchaseDetailList: qualified.map((x) => ({
          productSkuId: Number(x.skuId),
          productSkuPurchaseQuantity: x.maxQuantity,
        })),
      },
      built,
    )
  } catch (err) {
    return { ok: false, error: `按上限申报失败：${await toWorkbenchError(guard.store.id, err)}` }
  }
  // 申报成功后失效面板缓存：备货单待办/可申报池立即刷新
  invalidateTemuCache(guard.store.enterpriseId)
  return { ok: true, result: { dryRun: false, rawError, skuLimits, applied: qualified.map((x) => ({ skuId: x.skuId, quantity: x.maxQuantity! })) } }
}
