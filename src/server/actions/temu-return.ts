"use server"

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"
import { db } from "@/db/client"
import { temuProducts, temuShipOrders, temuSkuMaps, temuStores } from "@/db/schema"
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
import { temuCached } from "@/server/services/temu-cache"
import {
  temuReturnListQuerySchema,
  temuReturnDetailQuerySchema,
  temuReturnSkuQuerySchema,
} from "@/server/schemas/temu"

/**
 * Temu 退货工作台 Server Actions（退供三件套，发货至仓库被退数据，保库存准确）
 *
 * 与质检工作台同模式：实时拉取不落库（退货时效强、状态推进快），读走
 * temu-cache 30s 短缓存。接口口径 docs §8.17（参数表 2026-10-21 官方文档站实证）：
 * - 必填 supplierId（商家 id）来自本地 temu_ship_order 行级字段（shiporderv2
 *   同步落库，2026-10-23 真实店实证）；无发货数据的新店无法确定，友好报错
 * - 无界查询报 100000001（结果超 5 万条），入参一律带出库时间窗（默认 90 天）
 * - CN 网关直调（与质检同路径，无需 PA 注册）
 */

/* ─── 公共（与 temu-fulfillment 同款守卫，"use server" 文件仅能导出 async 函数故内联） ─── */

type StoreRow = typeof temuStores.$inferSelect

async function requireTemuStore(
  storeId: string,
  requireModule: ModuleName | null,
): Promise<{ ok: true; store: StoreRow } | { ok: false; error: string }> {
  let ctx
  try {
    ctx = await requireEnterpriseContext()
  } catch (err) {
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
  if (err instanceof TemuApiError && err.errorCode === 100000001) {
    return "查询结果超过 5 万条，请缩小出库时间窗后重试"
  }
  // SKU 明细窗口上限 31 天（真实店实测 100000004）
  if (err instanceof TemuApiError && err.errorCode === 100000004) {
    return "出库时间窗超限：SKU 明细最大 31 天，请缩短时间窗后重试"
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

/** 官方 Desc 文案字段实测偶发 JSON 数组串（如 '["长时间未上架"]'）或真数组：
 *  解析拼接为「、」分隔，普通字符串原样返回。
 *  注意不能命名为 desc——会遮蔽 drizzle-orm 的排序 desc()（esbuild 静默改名不报错） */
function descText(v: unknown, max: number): string | null {
  if (Array.isArray(v)) {
    const joined = v
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => x.trim())
      .join("、")
    return joined ? joined.slice(0, max) : null
  }
  const s = str(v, max)
  if (s == null) return null
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(s)
      if (Array.isArray(parsed)) {
        const joined = parsed
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .map((x) => x.trim())
          .join("、")
        if (joined) return joined.slice(0, max)
      }
    } catch {
      // 非 JSON 数组串，原样返回
    }
  }
  return s
}

function asList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]).filter(isRecord) : []
}

/** 逗号/空白分隔多值 → 官方数组入参（单值亦可）；空输入返回 undefined 不占参数位 */
function splitIds(v: string | undefined): string[] | undefined {
  if (!v) return undefined
  const list = v
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
  return list.length ? list : undefined
}

/** supplierId 解析：本地发货单最近一条非空值（shiporderv2 行级，docs 坑 41） */
async function getStoreSupplierId(
  store: StoreRow,
): Promise<{ ok: true; supplierId: number } | { ok: false; error: string }> {
  const [row] = await db
    .select({ supplierId: temuShipOrders.supplierId })
    .from(temuShipOrders)
    .where(and(eq(temuShipOrders.storeId, store.id), isNotNull(temuShipOrders.supplierId)))
    .orderBy(desc(temuShipOrders.capturedAt))
    .limit(1)
  if (!row?.supplierId) {
    return {
      ok: false,
      error: "该店铺暂无发货单数据，无法确定 supplierId（退供接口必填）；发货数据同步后即可使用",
    }
  }
  return { ok: true, supplierId: row.supplierId }
}

/** 出库时间窗（epoch ms）：滚动 now-天数 ~ now */
function outboundWindow(days: number): { start: number; end: number } {
  const end = Date.now()
  return { start: end - days * 86_400_000, end }
}

/** SKC 级本地反查（货号/品名）：退供接口只回 ID，对账要按货号看 */
async function loadSkcMeta(
  storeId: string,
  skcIds: Array<string | null | undefined>,
): Promise<Map<string, { productSn: string | null; productName: string | null }>> {
  const map = new Map<string, { productSn: string | null; productName: string | null }>()
  const ids = [...new Set(skcIds.filter((x): x is string => !!x))].slice(0, 200)
  if (!ids.length) return map
  const rows = await db
    .select({
      productSkcId: temuProducts.productSkcId,
      productSn: temuProducts.productSn,
      productName: temuProducts.productName,
    })
    .from(temuProducts)
    .where(and(eq(temuProducts.storeId, storeId), inArray(temuProducts.productSkcId, ids)))
  for (const r of rows) map.set(r.productSkcId, { productSn: r.productSn, productName: r.productName })
  return map
}

/* ─── 退供包裹列表 ─── */

export interface TemuReturnPackageRow {
  returnSupplierPackageNo: string | null
  purchaseSubOrderSn: string | null
  expressDeliverySn: string | null
  returnSupplierQuantity: number | null
  /** 出库时间（epoch ms） */
  outboundTime: number | null
  /** 官方状态文案（如 待提货/已出库） */
  packageStatusDesc: string | null
  returnSupplierReasonDesc: string | null
  logisticsTypeDesc: string | null
  payMethodDesc: string | null
  returnHandOverTypeDesc: string | null
  reason: string | null
}

export async function getTemuReturnPackagesAction(input: {
  store: string
  status?: "1" | "2"
  window?: "30" | "90" | "365"
  expressDeliverySn?: string
  purchaseSubOrderSn?: string
  returnSupplierPackageNo?: string
  pageNo?: number
}): Promise<{ ok: true; rows: TemuReturnPackageRow[]; total: number } | { ok: false; error: string }> {
  const parsed = temuReturnListQuerySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  const d = parsed.data
  const expressList = splitIds(d.expressDeliverySn)
  const subList = splitIds(d.purchaseSubOrderSn)
  const pkgList = splitIds(d.returnSupplierPackageNo)
  return temuCached(
    `${store.enterpriseId}:return-list:${store.id}:${d.status ?? "all"}:${d.window}:${d.expressDeliverySn ?? "-"}:${d.purchaseSubOrderSn ?? "-"}:${d.returnSupplierPackageNo ?? "-"}:${d.pageNo}`,
    async () => {
      const supplier = await getStoreSupplierId(store)
      if (!supplier.ok) return { ok: false as const, error: supplier.error }
      const built = await getTemuCallContext(store)
      if ("error" in built) return { ok: false as const, error: built.error }
      const { start, end } = outboundWindow(Number(d.window))
      try {
        const envelope = await callTemuApi<{ total?: unknown; openReturnPackageDTOS?: unknown }>(
          "bg.refund.returnpackage.get",
          {
            supplierId: supplier.supplierId,
            pageNo: d.pageNo,
            pageSize: 20,
            outboundTimeStart: start,
            outboundTimeEnd: end,
            ...(d.status ? { status: Number(d.status) } : {}),
            ...(expressList ? { expressDeLiverySns: expressList } : {}),
            ...(subList ? { purchaseSubOrderSns: subList } : {}),
            ...(pkgList ? { returnSupplierPackageNos: pkgList } : {}),
          },
          built,
        )
        const rows: TemuReturnPackageRow[] = asList(envelope.result?.openReturnPackageDTOS).map(
          (it) => ({
            returnSupplierPackageNo: str(it.returnSupplierPackageNo, 64),
            purchaseSubOrderSn: str(it.purchaseSubOrderSn, 64),
            expressDeliverySn: str(it.expressDeLiverySn, 64),
            returnSupplierQuantity: num(it.returnSupplierQuantity),
            outboundTime: num(it.outboundTime),
            packageStatusDesc: descText(it.packageStatusDesc, 60),
            returnSupplierReasonDesc: descText(it.returnSupplierReasonDesc, 200),
            logisticsTypeDesc: descText(it.logisticsTypeDesc, 60),
            payMethodDesc: descText(it.payMethodDesc, 60),
            returnHandOverTypeDesc: descText(it.returnHandOverTypeDesc, 60),
            reason: descText(it.reason, 300),
          }),
        )
        return { ok: true as const, rows, total: num(envelope.result?.total) ?? rows.length }
      } catch (err) {
        return { ok: false as const, error: await toWorkbenchError(store.id, err) }
      }
    },
  )
}

/* ─── 退供包裹详情（SKC 明细） ─── */

export interface TemuReturnDetailRow {
  productSkcId: string | null
  thumbUrl: string | null
  mainSaleSpec: string | null
  secondarySaleSpec: string | null
  returnSupplierQuantity: number | null
  /** 本地 temu_product 反查（货号/品名，按 store+skc） */
  productSn: string | null
  productName: string | null
}

export async function getTemuReturnPackageDetailAction(input: {
  store: string
  returnSupplierPackageNo: string
}): Promise<{ ok: true; rows: TemuReturnDetailRow[] } | { ok: false; error: string }> {
  const parsed = temuReturnDetailQuerySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  const supplier = await getStoreSupplierId(store)
  if (!supplier.ok) return { ok: false as const, error: supplier.error }
  const built = await getTemuCallContext(store)
  if ("error" in built) return { ok: false as const, error: built.error }
  try {
    const envelope = await callTemuApi<{ returnPackageInfos?: unknown }>(
      "bg.refund.returnpackagedetail.get",
      {
        supplierId: supplier.supplierId,
        returnSupplierPackageNo: parsed.data.returnSupplierPackageNo,
      },
      built,
    )
    const raw = asList(envelope.result?.returnPackageInfos)
    const skcIds = raw.map((it) => idStr(it.productSkcId, 32))
    const meta = await loadSkcMeta(store.id, skcIds)
    const rows: TemuReturnDetailRow[] = raw.map((it) => {
      const skcId = idStr(it.productSkcId, 32)
      const m = skcId ? meta.get(skcId) : undefined
      return {
        productSkcId: skcId,
        thumbUrl: str(it.thumbUrl, 1000),
        mainSaleSpec: str(it.mainSaleSpec, 120),
        secondarySaleSpec: str(it.secondarySaleSpec, 120),
        returnSupplierQuantity: num(it.returnSupplierQuantity),
        productSn: m?.productSn ?? null,
        productName: m?.productName ?? null,
      }
    })
    return { ok: true as const, rows }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(store.id, err) }
  }
}

/* ─── 退供包裹 SKU 明细列表 ─── */

export interface TemuReturnSkuRow {
  productSkuId: string | null
  productSpuId: string | null
  packageSn: string | null
  quantity: number | null
  /** 出库时间（epoch ms） */
  outboundTime: number | null
  mainSaleSpec: string | null
  /** 本地反查：sku_map(skuId→skcId) → temu_product 货号/品名 */
  productSn: string | null
  productName: string | null
}

export async function getTemuReturnSkuDetailAction(input: {
  store: string
  window?: "7" | "30" | "31"
  returnSupplierPackageNo?: string
  purchaseSubOrderSn?: string
  pageNo?: number
}): Promise<{ ok: true; rows: TemuReturnSkuRow[]; total: number } | { ok: false; error: string }> {
  const parsed = temuReturnSkuQuerySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const guard = await requireTemuStore(parsed.data.store, null)
  if (!guard.ok) return guard
  const { store } = guard
  const d = parsed.data
  const pkgList = splitIds(d.returnSupplierPackageNo)
  const subList = splitIds(d.purchaseSubOrderSn)
  return temuCached(
    `${store.enterpriseId}:return-sku:${store.id}:${d.window}:${d.returnSupplierPackageNo ?? "-"}:${d.purchaseSubOrderSn ?? "-"}:${d.pageNo}`,
    async () => {
      const supplier = await getStoreSupplierId(store)
      if (!supplier.ok) return { ok: false as const, error: supplier.error }
      const built = await getTemuCallContext(store)
      if ("error" in built) return { ok: false as const, error: built.error }
      const { start, end } = outboundWindow(Number(d.window))
      try {
        const envelope = await callTemuApi<{ total?: unknown; packageDetailDTOList?: unknown }>(
          "bg.refund.returnpackagelist.get",
          {
            supplierId: supplier.supplierId,
            pageNo: d.pageNo,
            pageSize: 20,
            outboundTimeStart: start,
            outboundTimeEnd: end,
            ...(pkgList ? { returnSupplierPackageNos: pkgList } : {}),
            ...(subList ? { purchaseSubOrderSns: subList } : {}),
          },
          built,
        )
        const raw = asList(envelope.result?.packageDetailDTOList)
        const skuIds = raw.map((it) => idStr(it.productSkuId, 32))
        const ids = [...new Set(skuIds.filter((x): x is string => !!x))].slice(0, 200)
        const skuToSkc = new Map<string, string>()
        if (ids.length) {
          const skuRows = await db
            .select({ skuId: temuSkuMaps.skuId, skcId: temuSkuMaps.skcId })
            .from(temuSkuMaps)
            .where(and(eq(temuSkuMaps.storeId, store.id), inArray(temuSkuMaps.skuId, ids)))
          for (const r of skuRows) skuToSkc.set(r.skuId, r.skcId)
        }
        const meta = await loadSkcMeta(store.id, [...skuToSkc.values()])
        const rows: TemuReturnSkuRow[] = raw.map((it) => {
          const skuId = idStr(it.productSkuId, 32)
          const skcId = skuId ? skuToSkc.get(skuId) : undefined
          const m = skcId ? meta.get(skcId) : undefined
          return {
            productSkuId: skuId,
            productSpuId: idStr(it.productSpuId, 32),
            packageSn: str(it.packageSn, 64),
            quantity: num(it.quantity),
            outboundTime: num(it.outboundTime),
            mainSaleSpec: str(it.mainSaleSpec, 120),
            productSn: m?.productSn ?? null,
            productName: m?.productName ?? null,
          }
        })
        return { ok: true as const, rows, total: num(envelope.result?.total) ?? rows.length }
      } catch (err) {
        return { ok: false as const, error: await toWorkbenchError(store.id, err) }
      }
    },
  )
}
