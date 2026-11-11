"use server"

import { createHash } from "node:crypto"
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  temuStores,
  temuShipOrders,
  temuShipPackages,
  temuProducts,
  temuSalesOverviews,
  temuLogisticsConfig,
  inventoryProducts,
  inventoryStocks,
  inventoryMovements,
  type TemuShipReceiveAddress,
} from "@/db/schema"
import type { ModuleName } from "@/db/schema/_shared"
import { getCurrentEnterpriseScope, requireEnterpriseContext, requireUserContext } from "@/lib/auth/session"
import { MODULE_LABELS } from "@/lib/modules"
import {
  callTemuApi,
  isTemuPermissionError,
  isTemuTokenExpired,
  TemuApiError,
  type TemuCallContext,
} from "@/lib/temu-api/client"
import { getTemuCallContext, upsertShipOrderRows } from "@/server/services/temu-sync"
import { SHIP_ORDER_STATUS } from "@/lib/temu-api/workbench-labels"
import { invalidateTemuCache, temuCached } from "@/server/services/temu-cache"
import {
  assertShipmentStock,
  assertShipmentStockAggregated,
  deductShipmentInventory,
  getMainWarehouseId,
  loadProductMapBySnKey,
  normalizeSn,
  requireInventory,
} from "@/server/services/inventory-core"
import { temuDayStr, temuStartOfToday, temuStartOfWeek } from "@/server/services/temu-time"
import {
  refineShipPackageSum,
  temuShipCancelSchema,
  temuShipCreateOrderSchema,
  temuShipExpressNoValidateSchema,
  temuShipListQuerySchema,
  temuShipLogisticsChangeSchema,
  temuShipLogisticsMatchSchema,
  temuShipMallAddressCreateSchema,
  temuShipPackageEditSchema,
  temuShipPackingMatchSchema,
  temuShipPredictVolumeQuerySchema,
  temuShipReceiveAddressQuerySchema,
  temuShipSendActionSchema,
  temuShipWarehouseOptionsSchema,
  temuShipStagingAddSchema,
  temuShipStagingQuerySchema,
  temuShipBoxMarkPrintSchema,
  temuShipBarcodePrintSchema,
  temuShipExpressNoteQuerySchema,
} from "@/server/schemas/temu"

/**
 * Temu 发货工作台 Server Actions（M5-B/C/D 履约：发货台→收货地址→创建发货单→装箱发货→跟踪）
 *
 * 双模式：发货单列表读本地落库（temu_ship_order，同步源 api-ship-orders 15 分钟增量）；
 * 发货台/地址/物流推荐等时效强的读走官方实时（temuCached 30s）；写操作成功后按单号
 * 回查 shiporderv2 刷新本地库。写操作校验发货 tab 模块权限（temu_ship，页面可见即可用）。
 * 接口口径 docs §8.16：staging.add deliveryAddressType=4（1-内地已废弃）、
 * logisticsmatch 六必填、packing.send 三方式（官方枚举 1 自送/2 平台推荐/3 三方）。
 */

type StoreRow = typeof temuStores.$inferSelect

/** 校验店铺归属当前企业并返回店铺行（与 temu-fulfillment 同款守卫，
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

/** 卖家发货地址 id → 标签映射（bg.mall.address.get，按店 30s 缓存；
 *  官方不可达/token 失效返回空表，调用方降级显示） */
async function loadMallAddressLabels(store: StoreRow): Promise<Map<number, string>> {
  try {
    const addrRows = await temuCached(
      `${store.enterpriseId}:mall-address:${store.id}`,
      async (): Promise<Array<{ id: number; label: string }>> => {
        const built = await getTemuCallContext(store)
        if ("error" in built) return []
        const r = await callTemuApi<unknown[]>("bg.mall.address.get", {}, built)
        return asList(r.result).flatMap((a) => {
          const id = num(a.id)
          return id != null ? [{ id, label: str(a.addressLabel, 60) ?? `地址 ${id}` }] : []
        })
      },
    )
    return new Map(addrRows.map((a) => [a.id, a.label]))
  } catch {
    return new Map()
  }
}

/** shiporderv2 按单号回查 → 本地落库（写操作成功后即时刷新 / 列表 fresh 实时核对；
 *  sns ≤20——官方单次名单上限，超出报 3000000）。返回官方实际返回的单号集合——
 *  缺席的单=官方侧已移除/删除。 */
async function upsertFromOfficial(
  storeId: string,
  ctx: TemuCallContext,
  sns: string[],
): Promise<{ fetched: number; presentSns: string[] }> {
  if (sns.length === 0) return { fetched: 0, presentSns: [] }
  const r = await callTemuApi<{ list?: unknown }>("bg.shiporderv2.get", {
    pageNo: 1,
    pageSize: 50,
    deliveryOrderSnList: sns,
  }, ctx)
  const rows = asList((r.result as { list?: unknown } | null)?.list)
  if (rows.length > 0) await upsertShipOrderRows(storeId, new Date(), rows)
  return {
    fetched: rows.length,
    presentSns: rows.map((row) => str(row.deliveryOrderSn, 64)).filter((s): s is string => Boolean(s)),
  }
}

/** shiporderv2 裸查最新一页（sortType:0 按创建时间倒序）→ 落库。deliverTime 增量窗口
 *  结构性漏掉待装箱（status=0）等新单——裸查是它们进入本地库的兜底通道（口径同
 *  worker 补捞段，见 temu-sync.ts syncShipOrders）；fresh 进页即拉，新建单无须等
 *  15 分钟同步。节流（4000000）由调用方按「跳过」处理。 */
async function upsertLatestPage(
  storeId: string,
  ctx: TemuCallContext,
): Promise<{ fetched: number }> {
  const r = await callTemuApi<{ list?: unknown }>("bg.shiporderv2.get", {
    pageNo: 1,
    pageSize: 50,
    sortType: 0,
  }, ctx)
  const rows = asList((r.result as { list?: unknown } | null)?.list)
  if (rows.length > 0) await upsertShipOrderRows(storeId, new Date(), rows)
  return { fetched: rows.length }
}

/** fresh 实时拉取单店（发货页列表 / 库存「TEMU发货单同步」共用）：
 *  ① 裸查最新一页落库（新建单/待装箱单由此进入本地库；本地无行也执行，空表才拉得到新单）
 *  ② 按传入单号回查官方回写；官方已不存在的单（超时移除等）本地置为已取消，收敛「死单」。
 *  rowMetaBySn 供缺席收敛判定（官方索引延迟保护：创建未满 30 分钟不判死，下一轮同步/刷新
 *  收敛真状态；只有待装箱(0)/待收货(1)可能被官方超时移除，已收货(2)/已入库(3)等历史单
 *  缺席多因超出官方保留期，缺席≠已取消不得改写）。裸查被节流（4000000）时跳过不阻断
 *  核对；其余错误上抛由调用方降级为本地数据。 */
async function freshPullStore(
  storeId: string,
  ctx: TemuCallContext,
  sns: string[],
  rowMetaBySn: Map<string, { status: number; born: Date }>,
): Promise<{ fetched: number; missing: number }> {
  let fetched = 0
  // ① 最新一页（shiporderv2 翻页节流 4000000 实测多发）
  try {
    fetched += (await upsertLatestPage(storeId, ctx)).fetched
  } catch (err) {
    if (!(err instanceof TemuApiError && err.errorCode === 4000000)) throw err
  }
  // ② 单号核对（sns 为空=本地空表，只裸查不核对；官方单次名单上限 20——超出报
  // 3000000「发货单号数量范围需要在1~20之间」（2026-11-10 库存侧实测），分批回查）
  if (sns.length === 0) return { fetched, missing: 0 }
  const present = new Set<string>()
  for (let i = 0; i < sns.length; i += 20) {
    const verified = await upsertFromOfficial(storeId, ctx, sns.slice(i, i + 20))
    fetched += verified.fetched
    for (const sn of verified.presentSns) present.add(sn)
  }
  const missing = sns.filter((sn) => !present.has(sn))
  const nowMs = Date.now()
  const killable = missing.filter((sn) => {
    const meta = rowMetaBySn.get(sn)
    if (meta?.status !== 0 && meta?.status !== 1) return false
    return nowMs - meta.born.getTime() > 30 * 60_000
  })
  if (killable.length > 0) {
    await db
      .update(temuShipOrders)
      .set({ status: 5 })
      .where(
        and(
          eq(temuShipOrders.storeId, storeId),
          inArray(temuShipOrders.deliveryOrderSn, killable),
          inArray(temuShipOrders.status, [0, 1]),
        ),
      )
  }
  return { fetched, missing: killable.length }
}

/** 装箱发货成功后的库存扣减（批次4 实装）：
 *  工厂直发单跳过扣减（仅回写标记）；常规单按发货仓逐单扣减+「发货扣减」流水。
 *  skipInventory（自动预约发货「库存联动」开关关闭）：跳过校验与扣减但不标工厂直发
 *  （账实差异人工处理）。扣减失败降级 warning（官方已发货不可回滚，流水缺记人工冲正兜底）。 */
async function shipmentShippedHook(input: {
  storeId: string
  enterpriseId: string
  userId: string | null
  deliveryOrderSns: string[]
  warehouseId: string | null
  factoryDirect: boolean
  skipInventory?: boolean
}): Promise<void> {
  const { storeId, enterpriseId, userId, deliveryOrderSns, warehouseId, factoryDirect } = input
  await db
    .update(temuShipOrders)
    .set({
      factoryDirect,
      sourceWarehouseId: factoryDirect ? null : warehouseId,
    })
    .where(
      and(eq(temuShipOrders.storeId, storeId), inArray(temuShipOrders.deliveryOrderSn, deliveryOrderSns)),
    )
  if (factoryDirect || input.skipInventory || !warehouseId) return
  const r = await deductShipmentInventory(enterpriseId, storeId, deliveryOrderSns, warehouseId, userId)
  if (r.error) throw new Error(r.error)
}

/** 状态预设 → statusList（shiporderv2 状态机 0-6；6 部分收货单列） */
const STATUS_PRESET: Record<string, number[] | undefined> = {
  pending: [0],
  shipping: [1],
  done: [2, 3],
  partial: [6],
  closed: [4, 5],
  all: undefined,
}

export interface TemuShipOrderRow {
  deliveryOrderSn: string
  subPurchaseOrderSn: string | null
  productSkcId: number | null
  skcExtCode: string | null
  /** 本单 SKU 明细 id（官方行 raw.packageDetailList；商品条码打印按 SKU 维度提交） */
  productSkuIds: number[]
  /** 商品名（left join temu_products） */
  productName: string | null
  /** 主图（官方 BasicVO 外链优先，商品表转存图兜底） */
  productImageUrl: string | null
  subWarehouseId: number | null
  subWarehouseName: string | null
  status: number
  urgencyType: number | null
  isCustomProduct: boolean | null
  purchaseStockType: number | null
  fragileTag: boolean | null
  deliveryMethod: number | null
  expressBatchSn: string | null
  expressCompany: string | null
  /** 快递公司 id（运单标签 express.note.get 入参；名称列之外的 id 列） */
  expressCompanyId: number | null
  expressDeliverySn: string | null
  deliveryAddressId: number | null
  /** 卖家发货地址标签（mall.address 映射；官方不可达时 null 降级） */
  deliveryAddressLabel: string | null
  deliverPackageNum: number | null
  deliverSkcNum: number | null
  skcPurchaseNum: number | null
  isPrintBoxMark: boolean | null
  driverName: string | null
  plateNumber: string | null
  /** 物流单拒收状态（0 无 / 1 待物流商处理 / 2 已处理；官方无轨迹状态，仅异常类） */
  expressRejectStatus: number | null
  /** 运单计费重量异常状态（1/2/4 为未决异常；文案 EXPRESS_WEIGHT_FEEDBACK_STATUS） */
  expressWeightFeedbackStatus: number | null
  /** 包裹号列表（本地包表按单号联查；打箱唛前可能为空） */
  packageSns: string[]
  deliveryOrderCreateTime: string | null
  deliverTime: string | null
  receiveTime: string | null
  purchaseTime: string | null
  expectPickUpGoodsTime: string | null
  expectLatestPickTime: string | null
  /** 自动取消截止（落库时官方剩余毫秒换算的绝对时间；仅官方返回时有值） */
  cancelDeadline: string | null
  /** 收货地址（装箱发货比价 logisticsmatch 入参用） */
  receiveAddress: TemuShipReceiveAddress | null
}

/** 发货单列表（本地库分页；企业隔离 = 店铺归属校验） */

/** 官方行 raw.packageDetailList → 本单 SKU id 去重列表（商品条码打印按 SKU 维度提交） */
function shipOrderSkuIds(raw: Record<string, unknown> | null): number[] {
  if (!raw || !Array.isArray(raw.packageDetailList)) return []
  return [
    ...new Set(
      raw.packageDetailList
        .map((d) => num(isRecord(d) ? d.productSkuId : null))
        .filter((v): v is number => v != null && v > 0),
    ),
  ]
}

export async function getTemuShipOrdersAction(input: unknown) {
  let q: typeof temuShipListQuerySchema._output
  try {
    q = temuShipListQuerySchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }

  const conditions = [eq(temuShipOrders.storeId, guard.store.id)]
  const statusList = STATUS_PRESET[q.statusPreset]
  if (statusList) conditions.push(inArray(temuShipOrders.status, statusList))
  if (q.skcExtCode) conditions.push(eq(temuShipOrders.skcExtCode, q.skcExtCode.trim()))
  if (q.subPurchaseOrderSn)
    conditions.push(eq(temuShipOrders.subPurchaseOrderSn, q.subPurchaseOrderSn.trim()))
  if (q.deliveryOrderSn)
    conditions.push(eq(temuShipOrders.deliveryOrderSn, q.deliveryOrderSn.trim()))
  if (q.warehouseId != null)
    conditions.push(eq(temuShipOrders.deliveryAddressId, q.warehouseId))
  const where = and(...conditions)

  const fetchPage = async () => {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(temuShipOrders)
      .where(where)
    // 官方块状列需要商品名/主图：left join 商品表（productSkcId 类型 varchar vs bigint 用 cast 对齐）
    const rows = await db
      .select({
        order: temuShipOrders,
        productName: temuProducts.productName,
        mainImageCosUrl: temuProducts.mainImageCosUrl,
        mainImageUrl: temuProducts.mainImageUrl,
      })
      .from(temuShipOrders)
      .leftJoin(
        temuProducts,
        and(
          eq(temuProducts.storeId, temuShipOrders.storeId),
          sql`cast(${temuShipOrders.productSkcId} as varchar) = ${temuProducts.productSkcId}`,
        ),
      )
      .where(where)
      // 待装箱（deliverTime 空）按创建时间排前，其余按发货时间新→旧
      .orderBy(
        sql`coalesce(${temuShipOrders.deliverTime}, ${temuShipOrders.deliveryOrderCreateTime}) desc nulls last`,
        desc(temuShipOrders.deliveryOrderSn),
      )
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)

    // 包裹号列表（本地包表）与卖家发货地址标签（mall.address 映射，60s 缓存）
    const sns = rows.map((r) => r.order.deliveryOrderSn)
    const pkgMap = new Map<string, string[]>()
    if (sns.length > 0) {
      const pkgs = await db
        .select({ sn: temuShipPackages.deliveryOrderSn, packageSn: temuShipPackages.packageSn })
        .from(temuShipPackages)
        .where(
          and(eq(temuShipPackages.storeId, guard.store.id), inArray(temuShipPackages.deliveryOrderSn, sns)),
        )
      for (const p of pkgs) {
        const list = pkgMap.get(p.sn) ?? []
        list.push(p.packageSn)
        pkgMap.set(p.sn, list)
      }
    }
    const addrIds = [
      ...new Set(rows.map((r) => r.order.deliveryAddressId).filter((v): v is number => v != null)),
    ]
    // 地址标签拿不到不阻断列表（降级显示 —）
    const addrLabels =
      addrIds.length > 0 ? await loadMallAddressLabels(guard.store) : new Map<number, string>()
    return { total, rows, pkgMap, addrLabels }
  }

  // fresh 实时拉取（进入列表/手动刷新即拉实时单，不再等 15 分钟同步）：
  // 最新一页落库 + 当前页单号核对收敛官方已移除单（freshPullStore 与库存发货单同步
  // 共用）；官方调用失败降级返回本地数据。
  let freshStats: { fetched: number; missing: number } | undefined
  let freshWarning: string | undefined
  if (q.fresh) {
    const first = await fetchPage()
    try {
      const built = await getTemuCallContext(guard.store)
      if ("error" in built) {
        freshWarning = `实时拉取已跳过（${built.error}），当前为本地同步数据`
      } else {
        freshStats = await freshPullStore(
          guard.store.id,
          built,
          first.rows.map((r) => r.order.deliveryOrderSn),
          new Map(
            first.rows.map((x) => [
              x.order.deliveryOrderSn,
              { status: x.order.status, born: x.order.deliveryOrderCreateTime ?? x.order.capturedAt },
            ] as const),
          ),
        )
      }
    } catch (err) {
      freshWarning = `实时拉取失败（${await toWorkbenchError(guard.store.id, err)}），已返回本地数据`
    }
  }

  const { total, rows, pkgMap, addrLabels } = await fetchPage()

  return {
    ok: true as const,
    total,
    page: q.page,
    pageSize: q.pageSize,
    ...(freshStats ? { freshStats } : {}),
    ...(freshWarning ? { freshWarning } : {}),
    rows: rows.map<TemuShipOrderRow>(({ order: r, productName, mainImageCosUrl, mainImageUrl }) => ({
      deliveryOrderSn: r.deliveryOrderSn,
      subPurchaseOrderSn: r.subPurchaseOrderSn,
      productSkcId: r.productSkcId,
      skcExtCode: r.skcExtCode,
      /** 本单 SKU 明细（raw.packageDetailList 提取；商品条码按 SKU 维度打印，见 getShipBarcodePrintUrlAction） */
      productSkuIds: shipOrderSkuIds(r.raw),
      productName,
      productImageUrl: r.productSkcPicture ?? mainImageCosUrl ?? mainImageUrl,
      subWarehouseId: r.subWarehouseId,
      subWarehouseName: r.subWarehouseName,
      status: r.status,
      urgencyType: r.urgencyType,
      isCustomProduct: r.isCustomProduct,
      purchaseStockType: r.purchaseStockType,
      fragileTag: r.fragileTag,
      deliveryMethod: r.deliveryMethod,
      expressBatchSn: r.expressBatchSn,
      expressCompany: r.expressCompany,
      expressCompanyId: r.expressCompanyId,
      expressDeliverySn: r.expressDeliverySn,
      deliveryAddressId: r.deliveryAddressId,
      deliveryAddressLabel: r.deliveryAddressId != null ? (addrLabels.get(r.deliveryAddressId) ?? null) : null,
      deliverPackageNum: r.deliverPackageNum,
      deliverSkcNum: r.deliverSkcNum,
      skcPurchaseNum: r.skcPurchaseNum,
      isPrintBoxMark: r.isPrintBoxMark,
      driverName: r.driverName,
      plateNumber: r.plateNumber,
      expressRejectStatus: r.expressRejectStatus,
      expressWeightFeedbackStatus: r.expressWeightFeedbackStatus,
      packageSns: (pkgMap.get(r.deliveryOrderSn) ?? []).slice(0, 10),
      deliveryOrderCreateTime: r.deliveryOrderCreateTime?.toISOString() ?? null,
      deliverTime: r.deliverTime?.toISOString() ?? null,
      receiveTime: r.receiveTime?.toISOString() ?? null,
      purchaseTime: r.purchaseTime?.toISOString() ?? null,
      expectPickUpGoodsTime: r.expectPickUpGoodsTime?.toISOString() ?? null,
      expectLatestPickTime: r.expectLatestPickTime?.toISOString() ?? null,
      cancelDeadline: r.cancelDeadline?.toISOString() ?? null,
      receiveAddress: r.receiveAddressInfo ?? null,
    })),
  }
}

/** 发货单列表「发货仓库」筛选选项：本店全部状态发货单出现过的卖家发货地址（addrId 去重）。
 *  标签复用 mall.address 映射（loadMallAddressLabels 30s 缓存），查不到的降级「地址 {id}」；
 *  与概览统计的仓库选项不同：不限「近两周已发货」，待装箱/已取消单用过的地址也要可选。 */
export async function getShipWarehouseOptionsAction(input: unknown) {
  let q: { store: string }
  try {
    q = temuShipWarehouseOptionsSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }

  const addrRows = await db
    .selectDistinct({ addrId: temuShipOrders.deliveryAddressId })
    .from(temuShipOrders)
    .where(and(eq(temuShipOrders.storeId, guard.store.id), isNotNull(temuShipOrders.deliveryAddressId)))

  const labelMap = await loadMallAddressLabels(guard.store)
  const rows = addrRows
    .map((r) => r.addrId)
    .filter((v): v is number => v != null)
    .map((addrId) => ({ id: addrId, label: labelMap.get(addrId) ?? `地址 ${addrId}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
  return { ok: true as const, rows }
}

/* ─── 发货统计（概览页底部三卡） ─── */


export interface TemuShipStatsProductRow {
  /** 货号（无货号的行聚合为「无货号」组） */
  name: string
  /** 今日发货件数 */
  num: number
  /** 同货号链接中今日销量最高商品的主图（COS 优先于原始 URL） */
  imageUrl: string | null
  imageCosUrl: string | null
}

export interface TemuShipStats {
  /** 今日按货号粒度发货件数，降序（饼图用，≥1% 合并「其他」由前端处理） */
  today: TemuShipStatsProductRow[]
  /** 本周（北京周一零点起，按发货时间统计） */
  week: { packageNum: number; skcNum: number }
  /** 上周（环比基数） */
  lastWeek: { packageNum: number; skcNum: number }
  /** 本周（北京周一~周日）逐日发货量，固定 7 项、无数据日补 0；未来天 future=true 且
   *  带出已预约量（今日装箱预约明日取货的单记取货日）（KPI 卡 7 节点趋势线；受仓库筛选影响） */
  weekDaily: Array<{ day: string; packageNum: number; skcNum: number; future: boolean }>
  /** 发货仓库（卖家发货地址）选项：key = 地址 id（同主体全局 id，跨店共享同一
   *  物理地址——委托发货/共用发货仓，按 addrId 去重） */
  warehouses: Array<{ key: string; label: string }>
}

/** 发货统计（概览页）：本地 temu_ship_order 归日/归周聚合。
 *  口径（2026-10-28 定，同日修订时间轴）：时间轴=预约取货时间优先、无预约（自送）
 *  回落装箱发货时间——今日装箱预约明日取货的单记取货日（实证 20% 单错位 +1 天）；
 *  status NOT IN (0,5)——待装箱未发货、已取消不计，已收货/已入库/部分收货照计，
 *  数字不随仓库收货衰减。数据随 api-ship-orders 15 分钟增量同步最多滞后一轮；
 *  半托店铺无发货单数据为 0。支持概览「全部店铺」跨店聚合。 */
export async function getTemuShipStatsAction(
  storeId?: string | null,
  warehouse?: string | null,
): Promise<TemuShipStats> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return temuCached(`${enterpriseId}:${storeId ?? "all"}:ship-stats:${warehouse ?? "all"}`, () =>
    loadTemuShipStats(enterpriseId, storeId ?? undefined, warehouse ?? undefined),
  )
}

async function loadTemuShipStats(
  enterpriseId: string,
  storeId?: string,
  warehouse?: string,
): Promise<TemuShipStats> {
  const storeConds = [eq(temuStores.enterpriseId, enterpriseId)]
  if (storeId) storeConds.push(eq(temuStores.id, storeId))
  const stores = await db.select().from(temuStores).where(and(...storeConds))
  const storeIds = stores.map((s) => s.id)
  const empty: TemuShipStats = {
    today: [],
    week: { packageNum: 0, skcNum: 0 },
    lastWeek: { packageNum: 0, skcNum: 0 },
    weekDaily: [],
    warehouses: [],
  }
  if (storeIds.length === 0) return empty

  // 发货仓库筛选：addrId 为同主体全局地址 id（跨店共享同一物理地址——委托发货/
  // 共用发货仓），直接按地址 id 在当前店铺范围内过滤；非法值静默忽略
  const baseConds = [
    inArray(temuShipOrders.storeId, storeIds),
    sql`${temuShipOrders.status} not in (0, 5)`,
  ]
  // 跨店去重（全部店铺模式）：官方 shiporderv2 同主体跨店可见，同一物理发货单会在
  // 多家店各落一行（本地唯一键=店+单号）——聚合只计一次，保留 captured_at 最新的一行
  // （最新鲜的同步快照：预约取货时间/状态最全，归日最准；同刻平手取 store_id 最小，
  // 限定本次店铺范围防跨企业单号碰撞）。单店模式不加：唯一键已保证无重复，
  // 且去重条件会把「单在别店也有」的行误删出本店视角
  if (storeIds.length > 1) {
    baseConds.push(sql`not exists (
      select 1 from temu_ship_order x
      where x.delivery_order_sn = ${temuShipOrders.deliveryOrderSn}
        and ${inArray(sql`x.store_id`, storeIds)}
        and (
          x.captured_at > ${temuShipOrders.capturedAt}
          or (x.captured_at = ${temuShipOrders.capturedAt} and x.store_id < ${temuShipOrders.storeId})
        )
    )`)
  }
  if (warehouse) {
    const addrId = num(warehouse)
    if (addrId != null) baseConds.push(eq(temuShipOrders.deliveryAddressId, addrId))
  }

  const weekStart = temuStartOfWeek()
  const lastWeekStart = new Date(weekStart.getTime() - 7 * 86_400_000)
  const todayStart = temuStartOfToday()
  // 今日窗口须带上界：预约取货轴下「明日已预约」是正常数据，仅按下界会把它们算进今日
  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000)
  const sumCols = {
    pkg: sql<string>`coalesce(sum(${temuShipOrders.deliverPackageNum}), 0)`,
    skc: sql<string>`coalesce(sum(${temuShipOrders.deliverSkcNum}), 0)`,
  }
  // 统计时间轴：预约取货时间优先（今日装箱预约明日取货记取货日），无预约（自送）回落装箱时间
  const axisExpr = sql`coalesce(${temuShipOrders.expectPickUpGoodsTime}, ${temuShipOrders.deliverTime})`
  // 逐日分桶表达式（北京时区）：轴时间落库为 timestamptz，at time zone 转墙钟后取日期
  const dayExpr = sql`(${axisExpr} at time zone 'Asia/Shanghai')::date`
  // drizzle 对裸 SQL 左值不做 Date → 驱动参数映射，边界一律传 ISO 串（PG 按上下文解析为 timestamptz）
  const axisGte = (d: Date) => gte(axisExpr, d.toISOString())
  const axisLt = (d: Date) => lt(axisExpr, d.toISOString())

  const [weekRows, lastWeekRows, todayRows, weekDailyRows, whRows] = await Promise.all([
    db
      .select(sumCols)
      .from(temuShipOrders)
      .where(and(...baseConds, axisGte(weekStart))),
    db
      .select(sumCols)
      .from(temuShipOrders)
      .where(
        and(
          ...baseConds,
          axisGte(lastWeekStart),
          axisLt(weekStart),
        ),
      ),
    db
      .select({
        sn: temuShipOrders.skcExtCode,
        num: sql<string>`coalesce(sum(${temuShipOrders.deliverSkcNum}), 0)`,
      })
      .from(temuShipOrders)
      .where(and(...baseConds, axisGte(todayStart), axisLt(tomorrowStart)))
      .groupBy(temuShipOrders.skcExtCode)
      .orderBy(desc(sql`coalesce(sum(${temuShipOrders.deliverSkcNum}), 0)`)),
    // 本周逐日趋势（KPI 卡 7 节点 sparkline；无数据日自然缺行，返回前按周一~周日补 0 + future 标记）
    db
      .select({
        day: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`,
        pkg: sumCols.pkg,
        skc: sumCols.skc,
      })
      .from(temuShipOrders)
      .where(and(...baseConds, axisGte(weekStart)))
      .groupBy(dayExpr)
      .orderBy(dayExpr),
    // 仓库选项：近两周（环比窗口）有过发货记录的卖家发货地址（跨店同 id 去重——同一物理地址）
    db
      .selectDistinct({ addrId: temuShipOrders.deliveryAddressId })
      .from(temuShipOrders)
      .where(
        and(
          inArray(temuShipOrders.storeId, storeIds),
          sql`${temuShipOrders.status} not in (0, 5)`,
          sql`${temuShipOrders.deliveryAddressId} is not null`,
          axisGte(lastWeekStart),
        ),
      ),
  ])

  // 地址标签：逐店 mall.address 映射（30s 缓存，官方不可达降级「地址 ID」）；
  // 地址 id 同主体全局，任一店列表拿到标签即用（本店查不到的委托/历史地址常在他店列表）
  const latestSalesSq = db
    .selectDistinctOn([temuSalesOverviews.storeId, temuSalesOverviews.skcId], {
      storeId: temuSalesOverviews.storeId,
      skcId: temuSalesOverviews.skcId,
      productSn: temuSalesOverviews.productSn,
      capturedAt: temuSalesOverviews.capturedAt,
      todaySalesVolume: temuSalesOverviews.todaySalesVolume,
    })
    .from(temuSalesOverviews)
    .where(inArray(temuSalesOverviews.storeId, storeIds))
    .orderBy(
      temuSalesOverviews.storeId,
      temuSalesOverviews.skcId,
      desc(temuSalesOverviews.capturedAt),
      desc(temuSalesOverviews.id),
    )
    .as("latest_ship_stats_skc")
  const imageRows = await db
    .select({
      sn: sql<string>`coalesce(nullif(trim(${latestSalesSq.productSn}), ''), nullif(trim(${temuProducts.productSn}), ''))`,
      today: sql<number>`case when ${latestSalesSq.capturedAt} >= ${todayStart.toISOString()} then coalesce(${latestSalesSq.todaySalesVolume}, 0) else 0 end`,
      imageUrl: temuProducts.mainImageUrl,
      imageCosUrl: temuProducts.mainImageCosUrl,
    })
    .from(latestSalesSq)
    .leftJoin(
      temuProducts,
      and(
        eq(temuProducts.storeId, latestSalesSq.storeId),
        eq(temuProducts.productSkcId, latestSalesSq.skcId),
      ),
    )

  const bestImageBySn = new Map<string, { today: number; imageUrl: string | null; imageCosUrl: string | null }>()
  for (const row of imageRows) {
    const sn = row.sn?.trim()
    if (!sn || (!row.imageUrl && !row.imageCosUrl)) continue
    const today = Number(row.today ?? 0)
    if (today > (bestImageBySn.get(sn)?.today ?? -1)) {
      bestImageBySn.set(sn, { today, imageUrl: row.imageUrl, imageCosUrl: row.imageCosUrl })
    }
  }

  const addrIds = [
    ...new Set(whRows.map((w) => w.addrId).filter((v): v is number => v != null)),
  ]
  const labelMaps = new Map<string, Map<number, string>>()
  for (const s of stores) labelMaps.set(s.id, await loadMallAddressLabels(s))
  const warehouses = addrIds
    .map((addrId) => {
      let label: string | null = null
      for (const m of labelMaps.values()) {
        const hit = m.get(addrId)
        if (hit) {
          label = hit
          break
        }
      }
      return { key: String(addrId), label: label ?? `地址 ${addrId}` }
    })
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))

  // 本周（周一~周日）固定 7 桶：查询缺行（无数据日）补 0；北京日 > 今日标 future=true
  // （未来天带出已预约量，前端折线止于今天、未来画空心点）；
  // weekStart 起逐日 +8h 整点步进，Asia/Shanghai 无夏令时，日串不会漂移
  const weekMap = new Map(weekDailyRows.map((r) => [r.day, r]))
  const todayStr = temuDayStr()
  const weekDaily = Array.from({ length: 7 }, (_, i) => {
    const day = temuDayStr(new Date(weekStart.getTime() + i * 86_400_000))
    return {
      day,
      packageNum: Number(weekMap.get(day)?.pkg ?? 0),
      skcNum: Number(weekMap.get(day)?.skc ?? 0),
      future: day > todayStr,
    }
  })

  return {
    today: todayRows.map((r) => {
      const name = r.sn?.trim() || "无货号"
      const image = bestImageBySn.get(name)
      return {
        name,
        num: Number(r.num ?? 0),
        imageUrl: image?.imageUrl ?? null,
        imageCosUrl: image?.imageCosUrl ?? null,
      }
    }),
    week: {
      packageNum: Number(weekRows[0]?.pkg ?? 0),
      skcNum: Number(weekRows[0]?.skc ?? 0),
    },
    lastWeek: {
      packageNum: Number(lastWeekRows[0]?.pkg ?? 0),
      skcNum: Number(lastWeekRows[0]?.skc ?? 0),
    },
    weekDaily,
    warehouses,
  }
}

/* ─── 步骤 1：发货台 ─── */

export interface TemuShipStagingSkuRow {
  productSkuId: number
  /** 单 SKU 可发上限 */
  skuDeliveryQuantityMaxLimit: number | null
  productSkuPurchaseQuantity: number | null
  imgUrl: string | null
}

export interface TemuShipStagingRow {
  subPurchaseOrderSn: string
  /** 商品名 */
  productName: string | null
  /** 主图 */
  productSkcPicture: string | null
  productSkcId: number | null
  /** 货号 */
  skcExtCode: string | null
  /** 收货仓库（子仓名） */
  subWarehouseName: string | null
  /** 收货地址简要（省市区+详址，tooltip 用） */
  receiveAddressText: string | null
  /** 待发货数（basic.purchaseQuantity 下单数量） */
  purchaseQuantity: number | null
  /** 实际发货数（本地发货单按子单号汇总 deliverSkcNum，status≠5；无则 0） */
  actualDeliveredNum: number
  /** 创建时间（basic.purchaseTime 毫秒） */
  purchaseTime: number | null
  urgencyType: number | null
  purchaseStockType: number | null
  isCustomProduct: boolean
  expectLatestDeliverTime: number | null
  expectLatestArrivalTime: number | null
  /** 发货倒计时毫秒（官方 deliverDisplayCountdownMillis，加载时快照；到期≈将被自动移出发货台） */
  deliverDisplayCountdownMillis: number | null
  /** 自动移出发货台时间（官方 autoRemoveFromDeliveryPlatformTime） */
  autoRemoveFromDeliveryPlatformTime: number | null
  skus: TemuShipStagingSkuRow[]
}

/** 发货台列表（staging.get 实时 + 30s 缓存；实际发货数 = 本地发货单联查汇总） */
export async function getShipStagingAction(input: unknown) {
  let q: typeof temuShipStagingQuerySchema._output
  try {
    q = temuShipStagingQuerySchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  const store = guard.store

  try {
    // 缓存 key 带筛选条件（筛选视图与全量视图互不污染）；fresh 跳过缓存（创建前预检要实时）
    const snFilter = q.subPurchaseOrderSn?.trim() ?? ""
    const key = `${store.enterpriseId}:ship-staging:${store.id}:${snFilter}|${q.skcExtCode ?? ""}|${q.skcId ?? ""}`
    const snList = snFilter
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      // 与 schema 2048 配套（约容百单）：截断会让预检漏查的单被误判「已不在发货台」
      .slice(0, 100)
    const load = async () => {
      const built = await getTemuCallContext(store)
      if ("error" in built) return { error: built.error as string, rows: [] as TemuShipStagingRow[] }
      const rows: TemuShipStagingRow[] = []
      for (let pageNo = 1; pageNo <= 4; pageNo++) {
        const params: Record<string, unknown> = { pageNo, pageSize: 50 }
        if (snList.length > 0) params.subPurchaseOrderSnList = snList
        if (q.skcExtCode) params.skcExtCode = [q.skcExtCode.trim()]
        if (q.skcId) {
          const skcId = Number(q.skcId.trim())
          if (Number.isInteger(skcId) && skcId > 0) params.productSkcIdList = [skcId]
        }
        const r = await callTemuApi<{ list?: unknown }>("bg.shiporder.staging.get", params, built)
        const list = asList((r.result as { list?: unknown } | null)?.list)
        for (const item of list) {
          const basic = isRecord(item.subPurchaseOrderBasicVO) ? item.subPurchaseOrderBasicVO : {}
          const skus = asList(item.orderDetailVOList).map((s) => ({
            productSkuId: num(s.productSkuId) ?? 0,
            skuDeliveryQuantityMaxLimit: num(s.skuDeliveryQuantityMaxLimit),
            productSkuPurchaseQuantity: num(s.productSkuPurchaseQuantity),
            imgUrl: str((asList(s.productSkuImgUrlList)[0] as unknown), 300),
          }))
          const sn = str(basic.subPurchaseOrderSn, 64)
          if (!sn) continue
          const addr = isRecord(basic.receiveAddressInfo) ? basic.receiveAddressInfo : {}
          const addrText = [
            str(addr.provinceName, 30),
            str(addr.cityName, 30),
            str(addr.districtName, 30),
            str(addr.detailAddress, 120),
          ]
            .filter(Boolean)
            .join(" ")
          rows.push({
            subPurchaseOrderSn: sn,
            productName: str(basic.productName, 500),
            productSkcPicture: str(basic.productSkcPicture, 300),
            productSkcId: num(basic.productSkcId),
            skcExtCode: str(basic.skcExtCode, 64),
            subWarehouseName: str(basic.subWarehouseName, 120),
            receiveAddressText: addrText || null,
            purchaseQuantity: num(basic.purchaseQuantity),
            actualDeliveredNum: 0,
            purchaseTime: num(basic.purchaseTime),
            urgencyType: num(basic.urgencyType),
            purchaseStockType: num(basic.purchaseStockType),
            isCustomProduct: basic.isCustomProduct === true,
            deliverDisplayCountdownMillis: num(basic.deliverDisplayCountdownMillis),
            autoRemoveFromDeliveryPlatformTime: num(basic.autoRemoveFromDeliveryPlatformTime),
            expectLatestDeliverTime: num(
              basic.expectLatestDeliverTime ?? basic.expectLatestDeliverTimeOrDefault,
            ),
            expectLatestArrivalTime: num(
              basic.expectLatestArrivalTime ?? basic.expectLatestArrivalTimeOrDefault,
            ),
            skus,
          })
        }
        if (list.length < 50) break
      }
      // 实际发货数：本地发货单按子单号汇总（status≠5 已取消）
      if (rows.length > 0) {
        try {
          const shipRows = await db
            .select({
              subSn: temuShipOrders.subPurchaseOrderSn,
              deliverNum: temuShipOrders.deliverSkcNum,
            })
            .from(temuShipOrders)
            .where(
              and(
                eq(temuShipOrders.storeId, store.id),
                // 已取消（status=5，含 fresh 实时核对误杀置 5 的行）不计入实际发货数
                ne(temuShipOrders.status, 5),
                inArray(
                  temuShipOrders.subPurchaseOrderSn,
                  rows.map((r) => r.subPurchaseOrderSn),
                ),
              ),
            )
          const sumBySn = new Map<string, number>()
          for (const s of shipRows) {
            if (!s.subSn) continue
            sumBySn.set(s.subSn, (sumBySn.get(s.subSn) ?? 0) + (s.deliverNum ?? 0))
          }
          for (const r of rows) r.actualDeliveredNum = sumBySn.get(r.subPurchaseOrderSn) ?? 0
        } catch {
          // 联查失败保留 0
        }
      }
      return { error: null as string | null, rows }
    }
    const data = q.fresh ? await load() : await temuCached(key, load)
    if (data.error) return { ok: false as const, error: data.error }
    return { ok: true as const, rows: data.rows }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(store.id, err) }
  }
}

/** 加入发货台（staging.add；deliveryAddressType=4 内地非保税区，1-内地已废弃）。
 *  入口在备货 tab 备货单列表「创建」按钮，守卫挂 temu_purchase（可看备货页即可用）。 */
export async function addShipStagingAction(input: unknown) {
  let q: typeof temuShipStagingAddSchema._output
  try {
    q = temuShipStagingAddSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, "temu_purchase")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  const store = guard.store

  try {
    const built = await getTemuCallContext(store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<{ joinErrorList?: unknown }>(
      "bg.shiporder.staging.add",
      {
        joinInfoList: q.subPurchaseOrderSns.map((sn) => ({
          subPurchaseOrderSn: sn,
          deliveryAddressType: 4,
        })),
      },
      built,
    )
    const errorList = asList((r.result as { joinErrorList?: unknown } | null)?.joinErrorList).map(
      (e) => ({
        sn: str(e.joinErrorSubPurchaseOrderSn, 64) ?? "未知单号",
        reason: str(e.errorMsg, 300) ?? `错误码 ${num(e.errorCode) ?? "?"}`,
      }),
    )
    invalidateTemuCache(store.enterpriseId)
    const failedSns = new Set(errorList.map((e) => e.sn))
    return {
      ok: true as const,
      joined: q.subPurchaseOrderSns.filter((sn) => !failedSns.has(sn)),
      errors: errorList,
    }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(store.id, err) }
  }
}

/* ─── 步骤 2：大仓收货地址 ─── */

export interface TemuShipReceiveAddressGroup {
  subWarehouseId: number
  receiveAddress: TemuShipReceiveAddress
  subPurchaseOrderSns: string[]
}

/** 大仓收货地址分组（receiveaddressv2.get；须已加入发货台） */
export async function getReceiveAddressesAction(input: unknown) {
  let q: typeof temuShipReceiveAddressQuerySchema._output
  try {
    q = temuShipReceiveAddressQuerySchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  const store = guard.store

  try {
    const built = await getTemuCallContext(store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<{ subPurchaseReceiveAddressGroups?: unknown }>(
      "bg.shiporder.receiveaddressv2.get",
      { subPurchaseOrderSnList: q.subPurchaseOrderSns },
      built,
    )
    const groups = asList(
      (r.result as { subPurchaseReceiveAddressGroups?: unknown } | null)
        ?.subPurchaseReceiveAddressGroups,
    ).map<TemuShipReceiveAddressGroup | null>((g) => {
      const wid = num(g.subWarehouseId)
      if (wid == null) return null
      const a = isRecord(g.receiveAddressInfo) ? g.receiveAddressInfo : {}
      return {
        subWarehouseId: wid,
        receiveAddress: {
          receiverName: str(a.receiverName, 120),
          phone: str(a.phone, 32),
          provinceName: str(a.provinceName, 60),
          provinceCode: num(a.provinceCode),
          cityName: str(a.cityName, 60),
          cityCode: num(a.cityCode),
          districtName: str(a.districtName, 60),
          districtCode: num(a.districtCode),
          detailAddress: str(a.detailAddress, 300),
        },
        subPurchaseOrderSns: Array.isArray(g.subPurchaseOrderSnList)
          ? g.subPurchaseOrderSnList.filter((s): s is string => typeof s === "string")
          : [],
      }
    })
    return { ok: true as const, groups: groups.filter((g): g is TemuShipReceiveAddressGroup => g !== null) }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(store.id, err) }
  }
}

/* ─── 卖家发货地址（mall.address） ─── */
export interface TemuShipMallAddress {
  id: number
  label: string
  isDefault: boolean
  fullText: string
}

export async function getMallAddressesAction(input: string) {
  const guard = await requireTemuStore(input, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<unknown[]>("bg.mall.address.get", {}, built)
    const list = asList(r.result)
    const rows: TemuShipMallAddress[] = []
    for (const a of list) {
      const id = num(a.id)
      if (id == null) continue
      rows.push({
        id,
        label: str(a.addressLabel, 60) ?? `地址 ${id}`,
        isDefault: a.isDefault === true,
        fullText: [
          str(a.provinceName, 30),
          str(a.cityName, 30),
          str(a.districtName, 30),
          str(a.addressDetail, 120),
        ]
          .filter(Boolean)
          .join(" "),
      })
    }
    return { ok: true as const, rows }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

export async function createMallAddressAction(input: unknown) {
  let q: typeof temuShipMallAddressCreateSchema._output
  try {
    q = temuShipMallAddressCreateSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, "temu_ship")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const { store: _store, ...fields } = q
    void _store
    const r = await callTemuApi<{ addressId?: unknown }>("bg.mall.address.add", fields, built)
    invalidateTemuCache(guard.store.enterpriseId)
    const addressId = num((r.result as { addressId?: unknown } | null)?.addressId)
    return { ok: true as const, addressId: addressId ?? null }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/* ─── 步骤 3：创建发货单 ─── */

/** 防御式提取创建结果里的发货单号（字符串数组 / 对象数组两种形态都兼容，业务级未实证） */
function extractOrderSns(result: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v)
    else if (isRecord(v)) {
      const sn = str(v.deliveryOrderSn, 64) ?? str(v.orderSn, 64)
      if (sn) out.push(sn)
    }
  }
  if (Array.isArray(result)) result.forEach(push)
  else if (isRecord(result)) {
    const orders = result.deliveryOrders ?? result.deliveryOrderSnList
    if (Array.isArray(orders)) orders.forEach(push)
    else push(result)
  }
  return [...new Set(out)]
}

/** 创建失败文案追加常见根因提示：备货单超时被自动移出发货台（标签类 2000000 等官方报错） */
function withShipCreateHint(message: string): string {
  if (/2000000|标签|移除|超时|发货台|不存在|已取消/.test(message)) {
    return `${message}；常见原因：备货单已超时被自动移出发货台，请返回第 1 步刷新发货台后重选`
  }
  return message
}

/** 官方索引延迟（回查 0 行）时用 create 入参直接播种本地行：待装箱列表立即可见、
 *  发货台「实际发货数」立即正确；下一轮同步/回查 upsert 会用官方全量字段覆盖补全。
 *  单号数与订单数一致时按序对应，否则退化为仅单号的极简行（宁缺毋错）。 */
async function seedCreatedOrders(
  storeId: string,
  sns: string[],
  presentSns: string[],
  groups: Array<{
    subWarehouseId: number
    receiveAddressInfo: TemuShipReceiveAddress
    deliveryAddressId: number
    orders: Array<{
      subPurchaseOrderSn: string
      deliverOrderDetailInfos: Array<{ productSkuId: number; deliverSkuNum: number }>
      packageInfos: unknown[]
    }>
  }>,
  capturedAt: Date,
): Promise<void> {
  const present = new Set(presentSns)
  const missing = sns.filter((sn) => !present.has(sn))
  if (missing.length === 0) return
  const aligned = missing.length === groups.reduce((acc, g) => acc + g.orders.length, 0)
  const flat = aligned
    ? groups.flatMap((g) =>
        g.orders.map((o) => ({
          subWarehouseId: g.subWarehouseId,
          receiveAddressInfo: g.receiveAddressInfo,
          deliveryAddressId: g.deliveryAddressId,
          subPurchaseOrderSn: o.subPurchaseOrderSn,
          deliverSkcNum: o.deliverOrderDetailInfos.reduce((acc, d) => acc + d.deliverSkuNum, 0),
          deliverPackageNum: o.packageInfos.length,
        })),
      )
    : []
  for (const [i, sn] of missing.entries()) {
    const src = flat[i]
    await db
      .insert(temuShipOrders)
      .values({
        storeId,
        deliveryOrderSn: sn,
        status: 0,
        ...(src
          ? {
              subPurchaseOrderSn: src.subPurchaseOrderSn,
              subWarehouseId: src.subWarehouseId,
              receiveAddressInfo: src.receiveAddressInfo,
              deliveryAddressId: src.deliveryAddressId,
              deliverSkcNum: src.deliverSkcNum,
              deliverPackageNum: src.deliverPackageNum,
            }
          : {}),
        deliveryOrderCreateTime: capturedAt,
        contentHash: createHash("sha1").update(`${sn}:${capturedAt.getTime()}`).digest("hex").slice(0, 40),
        capturedAt,
      })
      .onConflictDoNothing()
  }
}

export async function createShipOrderAction(input: unknown) {
  let q: typeof temuShipCreateOrderSchema._output
  try {
    q = temuShipCreateOrderSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  // 每单每 SKU：分箱合计 = 发货数（未过校验不发请求）
  for (const g of q.groups) {
    for (const o of g.orders) {
      const err = refineShipPackageSum(o)
      if (err) {
        return { ok: false as const, error: `备货单 ${o.subPurchaseOrderSn}：${err}` }
      }
    }
  }
  const guard = await requireTemuStore(q.store, "temu_ship")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  const store = guard.store

  try {
    const built = await getTemuCallContext(store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<Record<string, unknown>>(
      "bg.shiporderv3.create",
      {
        deliveryOrderCreateGroupList: q.groups.map((g) => ({
          subWarehouseId: g.subWarehouseId,
          receiveAddressInfo: g.receiveAddressInfo,
          deliveryOrderCreateInfos: g.orders.map((o) => ({
            subPurchaseOrderSn: o.subPurchaseOrderSn,
            deliveryAddressId: g.deliveryAddressId,
            deliverOrderDetailInfos: o.deliverOrderDetailInfos,
            packageInfos: o.packageInfos,
          })),
        })),
      },
      built,
    )
    const sns = extractOrderSns(r.result)
    if (sns.length === 0) {
      invalidateTemuCache(store.enterpriseId)
      return {
        ok: false as const,
        error:
          "官方接口已受理但返回中未解析到发货单号；请到「发货单跟踪」确认是否已创建，确认前请勿重试以免重复创建",
      }
    }
    let followUpWarning: string | undefined
    try {
      const { presentSns } = await upsertFromOfficial(store.id, built, sns)
      // 官方索引延迟导致回查落空的单：用入参播种本地行（幂等，冲突跳过）
      await seedCreatedOrders(store.id, sns, presentSns, q.groups, new Date())
      invalidateTemuCache(store.enterpriseId)
    } catch (err) {
      // 官方已建单，本地回查失败若报「创建失败」会诱导重试→重复创建，降级为 warning
      followUpWarning = `官方已创建 ${sns.length} 张发货单；本地回查落库失败（${await toWorkbenchError(store.id, err)}），列表稍后自动同步，请勿重复创建`
    }
    return {
      ok: true as const,
      deliveryOrderSns: sns,
      isUrgencyType: (r.result as { isUrgencyType?: unknown } | null)?.isUrgencyType === true,
      raw: r.result as Record<string, unknown>,
      warning: followUpWarning,
    }
  } catch (err) {
    return { ok: false as const, error: withShipCreateHint(await toWorkbenchError(store.id, err)) }
  }
}

/* ─── 步骤 4：装箱发货 ─── */

export interface TemuShipPackingMatchResult {
  /** 官方建议勾选的同发货地址发货单（合并发货） */
  shouldAdd: Array<{ deliveryOrderSn: string; supplierId: number | null }>
  deliveryOrderSnNotPrintBox: string[]
  /** SKU 总重量（克，向上取整千克预填用） */
  skuSumWeight: number | null
  ableUsePlatformExpress: boolean | null
  targetReceiveAddress: Record<string, unknown> | null
  targetDeliveryAddress: Record<string, unknown> | null
}

/** 装箱发货前置校验（packing.match） */
export async function packingMatchAction(input: unknown) {
  let q: typeof temuShipPackingMatchSchema._output
  try {
    q = temuShipPackingMatchSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<Record<string, unknown>>(
      "bg.shiporder.packing.match",
      { deliveryOrderSnList: q.deliveryOrderSns },
      built,
    )
    const res = (r.result ?? {}) as Record<string, unknown>
    const out: TemuShipPackingMatchResult = {
      shouldAdd: asList(res.shouldAddDeliveryOrderInfoList).map((s) => ({
        deliveryOrderSn: str(s.deliveryOrderSn, 64) ?? "",
        supplierId: num(s.supplierId),
      })).filter((s) => s.deliveryOrderSn),
      deliveryOrderSnNotPrintBox: (Array.isArray(res.deliveryOrderSnNotPrintBox)
        ? res.deliveryOrderSnNotPrintBox
        : []
      ).filter((s): s is string => typeof s === "string"),
      skuSumWeight: num(res.skuSumWeight),
      ableUsePlatformExpress:
        res.ableUsePlatformExpress == null ? null : res.ableUsePlatformExpress === true,
      targetReceiveAddress: isRecord(res.targetReceiveAddress) ? res.targetReceiveAddress : null,
      targetDeliveryAddress: isRecord(res.targetDeliveryAddress) ? res.targetDeliveryAddress : null,
    }
    return { ok: true as const, ...out }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 打包标签（箱唛）打印直出：boxmarkinfo.get + return_data_key=true → result 即 dataKey
 *  → 拼 https://openapi.kuajingmaihuo.com/tool/print?dataKey= 浏览器直开官方渲染打印页。
 *  链接 10min 内单次有效、请求过立即失效——UI 须点击时现取现跳，禁止缓存/预生成。
 *  装箱发货（packing.match/packing.send）要求先打印打包标签；打印后包裹数与件数锁定。 */
export async function getShipBoxMarkPrintUrlAction(input: unknown) {
  let q: typeof temuShipBoxMarkPrintSchema._output
  try {
    q = temuShipBoxMarkPrintSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<unknown>(
      "bg.logistics.boxmarkinfo.get",
      { deliveryOrderSnList: q.deliveryOrderSns, return_data_key: "true" },
      built,
    )
    // return_data_key 模式下 result 直接是 dataKey 字符串（非对象）
    const dataKey = typeof r.result === "string" ? r.result.trim() : ""
    if (!dataKey || dataKey.length > 1000) return { ok: false as const, error: "官方未返回打印 dataKey" }
    return { ok: true as const, url: `https://openapi.kuajingmaihuo.com/tool/print?dataKey=${dataKey}` }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/* ─── 运单标签（express.note.get，无 dataKey：URL 须四请求头签名 GET，服务端代理回传内容） ─── */

export interface TemuExpressNoteItem {
  /** 物流子单号 */
  childWaybillSn: string
  contentType: string
  dataBase64: string
}

export interface TemuExpressNoteResult {
  expressDeliverySn: string
  ok: boolean
  /** 部分子单拉取失败时的提示（ok=true 时也可能带） */
  error?: string
  items: TemuExpressNoteItem[]
}

/** 运单标签内容拉取的签名四头（官方运单标签打印说明·三：app-key/access-token/timestamp
 *  三键按 ASCII 升序 key+value 依次拼接，前后拼 app_secret，MD5 32 位大写） */
function buildExpressNoteHeaders(ctx: TemuCallContext): Record<string, string> {
  const timestamp = String(Date.now())
  const pairs: Array<[string, string]> = [
    ["access-token", ctx.accessToken],
    ["app-key", ctx.appKey],
    ["timestamp", timestamp],
  ] satisfies Array<[string, string]>
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const joined = pairs.map(([k, v]) => `${k}${v}`).join("")
  const sign = createHash("md5")
    .update(`${ctx.appSecret}${joined}${ctx.appSecret}`)
    .digest("hex")
    .toUpperCase()
  return { "app-key": ctx.appKey, "access-token": ctx.accessToken, timestamp, sign }
}

/**
 * 运单标签获取（按快递单号查子单标签 URL → 服务端签名 GET 代理内容）。
 * 官方无批量接口、无 dataKey 机制：逐单号调 express.note.get，再对每个
 * childWaybillNote URL 带四头拉取内容回传（浏览器加不了头只能代理）。
 * 业务级未实证（参数表+打印指南取证），内容格式首跑验证。
 */
export async function getShipExpressNoteAction(
  input: unknown,
): Promise<{ ok: true; results: TemuExpressNoteResult[] } | { ok: false; error: string }> {
  let q: typeof temuShipExpressNoteQuerySchema._output
  try {
    q = temuShipExpressNoteQuerySchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const headers = buildExpressNoteHeaders(built)
    const results: TemuExpressNoteResult[] = []
    for (const note of q.notes) {
      try {
        const r = await callTemuApi<{ tmsChildWaybillSnNoteDetails?: unknown }>(
          "bg.shiporder.express.note.get",
          { expressCompanyId: note.expressCompanyId, expressDeliverySn: note.expressDeliverySn },
          built,
        )
        const details = asList(
          (r.result as { tmsChildWaybillSnNoteDetails?: unknown } | null)?.tmsChildWaybillSnNoteDetails,
        )
        const items: TemuExpressNoteItem[] = []
        let lastError: string | null = null
        for (const d of details) {
          const childSn = str(d.childWaybillSn, 64) ?? ""
          const url = str(d.childWaybillNote, 500) ?? ""
          if (!url) continue
          try {
            const resp = await fetch(url, { headers, cache: "no-store" })
            if (!resp.ok) {
              lastError = `标签内容拉取失败（HTTP ${resp.status}）`
              continue
            }
            const contentType = resp.headers.get("content-type") ?? "application/octet-stream"
            const buf = Buffer.from(await resp.arrayBuffer())
            if (buf.byteLength === 0 || buf.byteLength > 15 * 1024 * 1024) {
              lastError = `标签内容异常（${buf.byteLength} 字节）`
              continue
            }
            items.push({ childWaybillSn: childSn, contentType, dataBase64: buf.toString("base64") })
          } catch (err) {
            lastError = `标签内容拉取失败：${err instanceof Error ? err.message : String(err)}`
          }
        }
        results.push({
          expressDeliverySn: note.expressDeliverySn,
          ok: items.length > 0,
          ...(items.length === 0 || lastError ? { error: lastError ?? "官方未返回运单标签" } : {}),
          items,
        })
      } catch (err) {
        results.push({
          expressDeliverySn: note.expressDeliverySn,
          ok: false,
          error: await toWorkbenchError(guard.store.id, err),
          items: [],
        })
      }
    }
    return { ok: true as const, results }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 商品条码打印直出（labelv2.get，条码API组）→ dataKey → 官方打印页
 *  （同 boxmark 的 10min 单次有效口径，点击时现取现开）。
 *  以发货单 SKU 维度提交（productSkuIdList）：labelv2 按 access_token 的供应商主体隔离，
 *  货号跨主体同名会打出别家条码（2026-11-04 真实店实证），SKU id 是主体内精确键。
 *  同一店铺的发货单常跨多个主体（shiporderv2 跨主体可见）——**自动路由同企业已授权
 *  店铺的 token**：逐 token 裸查认领 SKU，各 token 各取一页 dataKey（跨主体批量会开
 *  多个打印页）；全部 token 都查无的 SKU → 整批失败透出（防漏贴码不打半套）。
 *  旧载荷 productSkcIds → SKC 直查旧路径（兼容旧前端包，行为同历史版本）。 */
export async function getShipBarcodePrintUrlAction(input: unknown) {
  let q: typeof temuShipBarcodePrintSchema._output
  try {
    q = temuShipBarcodePrintSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }

    const extractDataKey = (result: unknown) => {
      const dataKey = typeof result === "string" ? result.trim() : ""
      return dataKey && dataKey.length <= 1000 ? dataKey : ""
    }
    // 条码打印页是 PA 域名（官方《条码打印说明》实证；CN 域名会报「异常访问」）；箱唛才是 CN 域名
    const printUrl = (dataKey: string) =>
      `https://openapi-b-partner.temu.com/tool/print?dataKey=${dataKey}`

    // 旧载荷：SKC id 直查（历史路径）
    if ("productSkcIds" in q) {
      const r = await callTemuApi<unknown>(
        "bg.glo.goods.labelv2.get",
        { productSkcIdList: [...new Set(q.productSkcIds)], return_data_key: "true" },
        built,
      )
      const dataKey = extractDataKey(r.result)
      if (!dataKey) return { ok: false as const, error: "官方未返回打印 dataKey" }
      return { ok: true as const, urls: [printUrl(dataKey)] }
    }

    // 同企业已启用且已授权店铺（当前店优先）：跨主体发货单路由到对应主体 token
    // （enabled 过滤与 requireTemuStore 的「店铺已停用」拒绝口径一致）
    const siblings = await db
      .select({
        id: temuStores.id,
        name: temuStores.name,
        enterpriseId: temuStores.enterpriseId,
        accessTokenEncrypted: temuStores.accessTokenEncrypted,
      })
      .from(temuStores)
      .where(
        and(
          eq(temuStores.enterpriseId, guard.store.enterpriseId),
          eq(temuStores.enabled, true),
          isNotNull(temuStores.accessTokenEncrypted),
        ),
      )
    const tokenStores = [guard.store, ...siblings.filter((s) => s.id !== guard.store.id)]

    const remaining = new Set(q.productSkuIds)
    const urls: string[] = []
    for (const st of tokenStores) {
      if (remaining.size === 0) break
      const ctx = st.id === guard.store.id ? built : await getTemuCallContext(st)
      if ("error" in ctx) continue
      try {
        // 裸查：该 token 能认领哪些 SKU（主体隔离，SKU 只会出现在属主 token 的结果里）
        const check = await callTemuApi<{ labelCodePageResult?: { data?: unknown[] } }>(
          "bg.glo.goods.labelv2.get",
          { productSkuIdList: [...remaining], page: 1, pageSize: 200 },
          ctx,
        )
        const page = isRecord(check.result) && isRecord(check.result.labelCodePageResult)
          ? check.result.labelCodePageResult
          : null
        const found = [
          ...new Set(
            (page && Array.isArray(page.data) ? page.data : [])
              .map((d) => num(isRecord(d) && isRecord(d.productSkuDTO) ? d.productSkuDTO.productSkuId : null))
              .filter((v): v is number => v != null && v > 0),
          ),
        ]
        if (found.length === 0) continue
        for (const id of found) remaining.delete(id)
        const r = await callTemuApi<unknown>(
          "bg.glo.goods.labelv2.get",
          { productSkuIdList: found, return_data_key: "true" },
          ctx,
        )
        const dataKey = extractDataKey(r.result)
        if (!dataKey) return { ok: false as const, error: "官方未返回打印 dataKey" }
        urls.push(printUrl(dataKey))
      } catch (err) {
        // 兄弟店铺 token 探测/取码失败（token 过期、未授权接口组等）仅跳过该店，不炸整批；
        // 当前店铺失败保持向外层 catch 透出（toWorkbenchError 逻辑不变）
        if (st.id === guard.store.id) throw err
        continue
      }
    }
    if (remaining.size > 0) {
      return {
        ok: false as const,
        error: `SKU ${[...remaining].join("、")} 在企业全部已授权店铺的条码系统均查无数据（对应供应商主体未授权，或该代条码已下架）；本批未打印，请到官方卖家后台打印`,
      }
    }
    if (urls.length === 0) return { ok: false as const, error: "官方未返回打印 dataKey" }
    return { ok: true as const, urls }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 发货总体积官方预估（predict.volume.get）：出参 predictVolume 字符串（立方米），
 *  供比价（logisticsmatch.predictVolume，缺省会报 2000000 请填写发货总体积）与
 *  packing.send 的 predictPackageVolume 自动回填；官方未返回时 predictVolume 为 null。 */
export async function getShipPredictVolumeAction(input: unknown) {
  let q: typeof temuShipPredictVolumeQuerySchema._output
  try {
    q = temuShipPredictVolumeQuerySchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<{ predictVolume?: unknown }>(
      "bg.predict.volume.get",
      { deliveryOrderSnList: q.deliveryOrderSns },
      built,
    )
    // 真实店实证（2026-10-27 探针）：predictVolume 回参是数字（如 0.1407），兼容字符串
    const raw = (r.result as { predictVolume?: unknown } | null)?.predictVolume
    const v =
      typeof raw === "number" && Number.isFinite(raw)
        ? String(raw)
        : str(raw, 32)
    return { ok: true as const, predictVolume: v }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

export interface TemuShipLogisticsOption {
  expressCompanyId: number | null
  expressCompanyName: string | null
  /** 预估商家承担运费区间（元） */
  minSupplierChargeAmount: string | null
  maxSupplierChargeAmount: string | null
  /** 1 次日达 / 2 隔日达 / 99 其它 */
  courierTimeType: number | null
  promisedDeliveryHourTime: string | null
  /** 可预约揽收时段（原值透传给 packing.send 的 expectPickUpGoodsTime） */
  channelScheduleTimeList: unknown[]
  pickupMethod: number | null
  predictId: number | null
  advantageDescList: string[]
  carrierAttention: string | null
  hasUsedThisLogistics: boolean
  raw: Record<string, unknown>
}

export interface TemuShipLogisticsMatchResult {
  list: TemuShipLogisticsOption[]
  mostUsed: {
    expressCompanyId: number | null
    expressCompanyName: string | null
    canSaveChargeAmount: string | null
  } | null
  usePricePrivileges: boolean
}

/** 平台推荐物流比价（logisticsmatch 官方六必填） */
export async function getLogisticsMatchAction(input: unknown) {
  let q: typeof temuShipLogisticsMatchSchema._output
  try {
    q = temuShipLogisticsMatchSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<Record<string, unknown>>(
      "bg.shiporderv3.logisticsmatch.get",
      {
        deliveryOrderSns: q.deliveryOrderSns,
        receiveAddressInfo: q.receiveAddressInfo,
        deliveryAddressId: q.deliveryAddressId,
        predictTotalPackageWeight: q.predictTotalPackageWeight,
        subWarehouseId: q.subWarehouseId,
        totalPackageNum: q.totalPackageNum,
        ...(q.predictVolume ? { predictVolume: q.predictVolume } : {}),
      },
      built,
    )
    const res = (r.result ?? {}) as Record<string, unknown>
    // 金额官方实测返回数字（2026-10-27 探针：4.55/4.78），也兼容字符串
    const amount = (v: unknown): string | null => {
      if (typeof v === "number" && Number.isFinite(v)) return String(v)
      return str(v, 32)
    }
    const list: TemuShipLogisticsOption[] = asList(res.list)
      .map((it) => ({
        expressCompanyId: num(it.expressCompanyId),
        expressCompanyName: str(it.expressCompanyName, 120),
        minSupplierChargeAmount: amount(it.minSupplierChargeAmount),
        maxSupplierChargeAmount: amount(it.maxSupplierChargeAmount),
        courierTimeType: num(it.courierTimeType),
        promisedDeliveryHourTime: str(it.promisedDeliveryHourTime, 60),
        channelScheduleTimeList: Array.isArray(it.channelScheduleTimeList)
          ? it.channelScheduleTimeList
          : [],
        pickupMethod: num(it.pickupMethod),
        predictId: num(it.predictId),
        advantageDescList: Array.isArray(it.advantageDescList)
          ? it.advantageDescList.filter((s): s is string => typeof s === "string")
          : [],
        carrierAttention: str(it.carrierAttention, 200),
        hasUsedThisLogistics: it.hasUsedThisLogistics === true,
        raw: it,
      }))
      .filter((it) => it.expressCompanyId != null)
    const most = isRecord(res.mostUsedExpressCompany) ? res.mostUsedExpressCompany : null
    const out: TemuShipLogisticsMatchResult = {
      list,
      mostUsed: most
        ? {
            expressCompanyId: num(most.expressCompanyId),
            expressCompanyName: str(most.expressCompanyName, 120),
            canSaveChargeAmount: amount(most.canSaveChargeAmount),
          }
        : null,
      usePricePrivileges: res.usePricePrivileges === true,
    }
    return { ok: true as const, ...out }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 自行委托第三方时的可用物流名单（logistics.get，≠ logistics.company.get 字典） */
export async function getThirdPartyLogisticsAction(input: string) {
  const guard = await requireTemuStore(input, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<unknown[]>("bg.shiporder.logistics.get", {}, built)
    const rows = asList(r.result)
      .map((it) => ({
        expressCompanyId: num(it.expressCompanyId),
        expressCompanyName: str(it.expressCompanyName, 120) ?? "未知物流",
      }))
      .filter((it): it is { expressCompanyId: number; expressCompanyName: string } =>
        it.expressCompanyId != null,
      )
    return { ok: true as const, rows }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 三方物流单号校验（logisticsorder.match；checkResultMsg 空 = 通过） */
export async function validateShipExpressNoAction(input: unknown) {
  let q: typeof temuShipExpressNoValidateSchema._output
  try {
    q = temuShipExpressNoValidateSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<{ checkResultMsg?: unknown }>(
      "bg.shiporder.logisticsorder.match",
      { shippingId: q.shippingId, expressNo: q.expressNo },
      built,
    )
    const msg = str((r.result as { checkResultMsg?: unknown } | null)?.checkResultMsg, 300)
    return { ok: true as const, valid: !msg, message: msg }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 装箱发货（packing.send 三方式）；发货前库存硬阻断（批次4），成功后扣库存+回查落库 */
export async function sendPackingAction(input: unknown) {
  const parsed = temuShipSendActionSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false as const, error: `参数错误：${parsed.error.issues[0]?.message ?? "入参不合法"}` }
  const q = parsed.data
  const guard = await requireTemuStore(q.store, "temu_ship")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  const store = guard.store
  const factoryDirect = q.factoryDirect === true
  const skipInventory = q.skipInventory === true
  const userCtx = await requireUserContext()
  const userCtxId = userCtx.user.id

  // 库存硬阻断（工厂直发/关闭库存联动时跳过）：单仓制固定主仓；未初始化库存的企业不联动
  const warehouseId: string | null = await getMainWarehouseId(store.enterpriseId)
  if (!factoryDirect && !skipInventory && warehouseId) {
    const check = await db.transaction((tx) =>
      assertShipmentStock(tx, store.enterpriseId, store.id, q.deliveryOrderSns, warehouseId!),
    )
    if (!check.ok) {
      const detail = check.shortages
        .map((s) => `${s.productCode}（需 ${s.needed}，库存仅 ${s.available}，缺 ${s.needed - s.available}）`)
        .join("；")
      return {
        ok: false as const,
        error: `库存不足，已阻断发货：${detail}。请先入库/盘点修正，或确认本单为工厂直发时勾选「工厂直发」`,
      }
    }
  }

  try {
    const built = await getTemuCallContext(store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const p = q.payload
    const body: Record<string, unknown> = {
      deliveryOrderSnList: q.deliveryOrderSns,
      deliveryAddressId: q.deliveryAddressId,
      deliverMethod: p.deliverMethod,
    }
    if (q.predictPackageVolume) body.predictPackageVolume = q.predictPackageVolume
    if (p.deliverMethod === 1) {
      body.selfDeliveryInfo = {
        driverName: p.driverName,
        plateNumber: p.plateNumber,
        expressPackageNum: p.expressPackageNum,
      }
    } else if (p.deliverMethod === 2) {
      const info: Record<string, unknown> = {
        expressCompanyId: p.expressCompanyId,
        expressCompanyName: p.expressCompanyName,
        predictTotalPackageWeight: p.predictTotalPackageWeight,
        expressPackageNum: p.expressPackageNum,
      }
      if (p.expectPickUpGoodsTime != null) info.expectPickUpGoodsTime = p.expectPickUpGoodsTime
      if (p.pickupMethod != null) info.pickupMethod = p.pickupMethod
      if (p.predictId != null) info.predictId = p.predictId
      if (p.selfDeliverSitePhone) info.selfDeliverSitePhone = p.selfDeliverSitePhone
      if (p.selfDeliverSiteAddress) info.selfDeliverSiteAddress = p.selfDeliverSiteAddress
      if (p.selfDeliverSiteUserCode) info.selfDeliverSiteUserCode = p.selfDeliverSiteUserCode
      if (p.selfDeliverSiteCompanyCode)
        info.selfDeliverSiteCompanyCode = p.selfDeliverSiteCompanyCode
      body.thirdPartyDeliveryInfo = info
    } else {
      body.thirdPartyExpressDeliveryInfoVO = {
        expressCompanyId: p.expressCompanyId,
        expressCompanyName: p.expressCompanyName,
        expressDeliverySn: p.expressDeliverySn,
        expressPackageNum: p.expressPackageNum,
      }
    }
    const r = await callTemuApi<{ expressBatchSn?: unknown }>(
      "bg.shiporder.packing.send",
      body,
      built,
    )
    const expressBatchSn =
      str((r.result as { expressBatchSn?: unknown } | null)?.expressBatchSn, 64) ?? null
    let followUpWarning: string | undefined
    try {
      // 库存扣减（直发单跳过扣减仅回写标记；skipInventory 跳过扣减不标直发；常规单扣减+流水）
      await shipmentShippedHook({
        storeId: store.id,
        enterpriseId: store.enterpriseId,
        userId: userCtxId,
        deliveryOrderSns: q.deliveryOrderSns,
        warehouseId,
        factoryDirect,
        skipInventory,
      })
      await upsertFromOfficial(store.id, built, q.deliveryOrderSns)
      invalidateTemuCache(store.enterpriseId)
    } catch (err) {
      // 官方已发货不可回滚，本地善后失败降级为 warning，避免误导「发货失败」引发重发
      followUpWarning = `官方已发货成功；本地回查/库存钩子失败（${await toWorkbenchError(store.id, err)}），状态稍后自动同步`
    }
    return { ok: true as const, expressBatchSn, warning: followUpWarning }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(store.id, err) }
  }
}

/* ─── 发货单跟踪写操作 ─── */

/** 取消发货单（仅装箱前有效，官方 cancel 传单号字符串） */
export async function cancelShipOrderAction(input: unknown) {
  let q: typeof temuShipCancelSchema._output
  try {
    q = temuShipCancelSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const guard = await requireTemuStore(q.store, "temu_ship")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    await callTemuApi("bg.shiporder.cancel", { deliveryOrderSn: q.deliveryOrderSn }, built)
    let followUpWarning: string | undefined
    try {
      await upsertFromOfficial(guard.store.id, built, [q.deliveryOrderSn])
      invalidateTemuCache(guard.store.enterpriseId)
    } catch (err) {
      followUpWarning = `官方已取消；本地回查失败（${await toWorkbenchError(guard.store.id, err)}），状态稍后自动同步`
    }
    return { ok: true as const, warning: followUpWarning }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

export interface TemuShipPackageInfo {
  packageSn: string
  skcNum: number | null
  packageDetails: Array<{ productSkuId: number | null; skuNum: number | null }>
}

/** 发货单包裹查询（package.get，调整包裹弹窗回显） */
export async function getShipPackagesAction(input: { store: string; deliveryOrderSn: string }) {
  const guard = await requireTemuStore(input.store, null)
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const r = await callTemuApi<{ packageInfo?: unknown }>(
      "bg.shiporder.package.get",
      { deliveryOrderSn: input.deliveryOrderSn },
      built,
    )
    const rows: TemuShipPackageInfo[] = asList(
      (r.result as { packageInfo?: unknown } | null)?.packageInfo,
    ).map((p) => ({
      packageSn: str(p.packageSn, 64) ?? "",
      skcNum: num(p.skcNum),
      packageDetails: asList(p.packageDetails).map((d) => ({
        productSkuId: num(d.productSkuId),
        skuNum: num(d.skuNum),
      })),
    }))
    return { ok: true as const, rows: rows.filter((p) => p.packageSn) }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/** 调整发货单包裹（package.edit；同款分箱合计校验） */
export async function editShipPackagesAction(input: unknown) {
  let q: typeof temuShipPackageEditSchema._output
  try {
    q = temuShipPackageEditSchema.parse(input)
  } catch {
    return { ok: false as const, error: "参数错误" }
  }
  const err = refineShipPackageSum(q)
  if (err) return { ok: false as const, error: err }
  const guard = await requireTemuStore(q.store, "temu_ship")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const { store: _s, ...body } = q
    void _s
    await callTemuApi("bg.shiporder.package.edit", body, built)
    let followUpWarning: string | undefined
    try {
      await upsertFromOfficial(guard.store.id, built, [q.deliveryOrderSn])
      invalidateTemuCache(guard.store.enterpriseId)
    } catch (err) {
      followUpWarning = `官方已调整包裹；本地回查失败（${await toWorkbenchError(guard.store.id, err)}），状态稍后自动同步`
    }
    return { ok: true as const, warning: followUpWarning }
  } catch (err2) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err2) }
  }
}

/** 修改发货物流（logistics.change by expressBatchSn；payload 同 packing.send 三选一） */
export async function changeShipLogisticsAction(input: unknown) {
  const parsed = temuShipLogisticsChangeSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false as const, error: `参数错误：${parsed.error.issues[0]?.message ?? "入参不合法"}` }
  const q = parsed.data
  const guard = await requireTemuStore(q.store, "temu_ship")
  if (!guard.ok) return { ok: false as const, error: guard.error }
  try {
    const built = await getTemuCallContext(guard.store)
    if ("error" in built) return { ok: false as const, error: built.error }
    const p = q.payload
    const body: Record<string, unknown> = {
      expressBatchSn: q.expressBatchSn,
      deliveryAddressId: q.deliveryAddressId,
      deliverMethod: p.deliverMethod,
    }
    if (p.deliverMethod === 1) {
      body.selfDeliveryInfo = {
        driverName: p.driverName,
        plateNumber: p.plateNumber,
        expressPackageNum: p.expressPackageNum,
      }
    } else if (p.deliverMethod === 2) {
      const info: Record<string, unknown> = {
        expressCompanyId: p.expressCompanyId,
        expressCompanyName: p.expressCompanyName,
        predictTotalPackageWeight: p.predictTotalPackageWeight,
        expressPackageNum: p.expressPackageNum,
      }
      if (p.expectPickUpGoodsTime != null) info.expectPickUpGoodsTime = p.expectPickUpGoodsTime
      if (p.pickupMethod != null) info.pickupMethod = p.pickupMethod
      if (p.predictId != null) info.predictId = p.predictId
      if (p.selfDeliverSitePhone) info.selfDeliverSitePhone = p.selfDeliverSitePhone
      if (p.selfDeliverSiteAddress) info.selfDeliverSiteAddress = p.selfDeliverSiteAddress
      if (p.selfDeliverSiteUserCode) info.selfDeliverSiteUserCode = p.selfDeliverSiteUserCode
      if (p.selfDeliverSiteCompanyCode)
        info.selfDeliverSiteCompanyCode = p.selfDeliverSiteCompanyCode
      body.thirdPartyDeliveryInfo = info
    } else {
      body.thirdPartyExpressDeliveryInfoVO = {
        expressCompanyId: p.expressCompanyId,
        expressCompanyName: p.expressCompanyName,
        expressDeliverySn: p.expressDeliverySn,
        expressPackageNum: p.expressPackageNum,
      }
    }
    await callTemuApi("bg.shiporder.logistics.change", body, built)
    invalidateTemuCache(guard.store.enterpriseId)
    return { ok: true as const }
  } catch (err) {
    return { ok: false as const, error: await toWorkbenchError(guard.store.id, err) }
  }
}

/* ─── 库存联动参考查询（发货台/备货列表展示用，批次4） ─── */

/** 按货号批量查库存参考（发货台行内/备货列表）：库存合计 + 已创建未装箱(status=0)。
 *  codes = 发货台 skcExtCode / 备货 productSn；企业级聚合（全部店铺视图同样适用）；
 *  归一化货号匹配（B049≡B49）。shipState：发货状态 auto/manual（无档案=null）。 */
export async function getShipInventoryRefAction(input: {
  store?: string
  codes: string[]
}) {
  const codes = (input.codes ?? []).filter((c) => typeof c === "string" && c.trim()).slice(0, 200)
  if (codes.length === 0)
    return {
      ok: true as const,
      rows: {} as Record<
        string,
        {
          totalQty: number
          pendingUnpacked: number
          shipState: "auto" | "manual" | null
          /** 档案装箱数（每箱件数；自动创建发货拆包裹默认值，无档案=null） */
          cartonQty: number | null
        }
      >,
    }
  let enterpriseId: string
  try {
    const ctx = await requireEnterpriseContext()
    if (!ctx.canAccess("temu")) {
      return { ok: false as const, error: "当前账号没有 TEMU 模块权限" }
    }
    enterpriseId = ctx.user.enterpriseId!
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "登录状态失效" }
  }

  // 档案（发货状态）与库存合计：按归一化货号匹配（撞码取字典序首条，同 loadProductMapBySnKey）
  const [products, stockRows] = await Promise.all([
    db
      .select({
        id: inventoryProducts.id,
        code: inventoryProducts.productCode,
        shipState: inventoryProducts.shipState,
        cartonQty: inventoryProducts.cartonQty,
      })
      .from(inventoryProducts)
      .where(eq(inventoryProducts.enterpriseId, enterpriseId))
      .orderBy(asc(inventoryProducts.productCode)),
    db
      .select({
        productId: inventoryStocks.productId,
        qty: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int`,
      })
      .from(inventoryStocks)
      .where(eq(inventoryStocks.enterpriseId, enterpriseId))
      .groupBy(inventoryStocks.productId),
  ])
  const productByKey = new Map<
    string,
    { id: string; code: string; shipState: "auto" | "manual"; cartonQty: number | null }
  >()
  for (const p of products) {
    const key = normalizeSn(p.code)
    if (!productByKey.has(key)) productByKey.set(key, p)
  }
  const stockByProduct = new Map(stockRows.map((r) => [r.productId, r.qty]))

  // 已创建未装箱：本地发货单 status=0 按 skcExtCode 汇总 deliverSkcNum（可带店铺过滤），
  // 结果按归一化货号聚合
  const storeIds = input.store
    ? (
        await db
          .select({ id: temuStores.id })
          .from(temuStores)
          .where(and(eq(temuStores.id, input.store), eq(temuStores.enterpriseId, enterpriseId)))
      ).map((s) => s.id)
    : (
        await db
          .select({ id: temuStores.id })
          .from(temuStores)
          .where(eq(temuStores.enterpriseId, enterpriseId))
      ).map((s) => s.id)
  const pendingByKey = new Map<string, number>()
  if (storeIds.length) {
    // 查询仅按店铺+待装箱拉行（待装箱单量有限），不带货号精确过滤：变体写法（B049≡B49）
    // 的在库单会被 inArray 漏计，归一匹配在 JS 完成以与聚合口径一致
    const wanted = new Set(codes.map(normalizeSn))
    const pending = await db
      .select({
        code: temuShipOrders.skcExtCode,
        qty: sql<number>`coalesce(sum(${temuShipOrders.deliverSkcNum}), 0)::int`,
      })
      .from(temuShipOrders)
      .where(and(inArray(temuShipOrders.storeId, storeIds), eq(temuShipOrders.status, 0)))
      .groupBy(temuShipOrders.skcExtCode)
    for (const p of pending) {
      if (!p.code) continue
      const key = normalizeSn(p.code)
      if (!wanted.has(key)) continue
      pendingByKey.set(key, (pendingByKey.get(key) ?? 0) + p.qty)
    }
  }

  const rows: Record<
    string,
    {
      totalQty: number
      pendingUnpacked: number
      shipState: "auto" | "manual" | null
      cartonQty: number | null
    }
  > = {}
  for (const c of codes) {
    const key = normalizeSn(c)
    const product = productByKey.get(key)
    rows[c] = {
      totalQty: product ? (stockByProduct.get(product.id) ?? 0) : 0,
      pendingUnpacked: pendingByKey.get(key) ?? 0,
      shipState: product?.shipState ?? null,
      cartonQty: product?.cartonQty ?? null,
    }
  }
  return { ok: true as const, rows }
}

/** 待装箱发货单「需要打印条码」标记（发货单列表行内徽标）：
 *  发货单行 skcExtCode 对应库存档案且未预贴条码（barcode_pre_pasted=false）→ 该单标记。
 *  未建档货号不标记（无法判断，沿用发货台「打印条码」按钮人工判断）。 */
export async function getShipOrdersNeedingBarcodeAction(input: { sns: string[] }) {
  const sns = (input?.sns ?? [])
    .filter((s) => typeof s === "string" && s.trim())
    .slice(0, 100)
  if (sns.length === 0) return { ok: true as const, sns: [] as string[] }
  let enterpriseId: string
  try {
    const ctx = await requireEnterpriseContext()
    if (!ctx.canAccess("temu")) {
      return { ok: false as const, error: "当前账号没有 TEMU 模块权限" }
    }
    enterpriseId = ctx.user.enterpriseId!
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "登录状态失效" }
  }

  const storeIds = (
    await db
      .select({ id: temuStores.id })
      .from(temuStores)
      .where(eq(temuStores.enterpriseId, enterpriseId))
  ).map((s) => s.id)
  if (storeIds.length === 0) return { ok: true as const, sns: [] as string[] }

  // 归一化货号匹配（B049≡B49）：发货单行 skcExtCode 与档案 product_code 各自归一后比对
  const [orderRows, productRows] = await Promise.all([
    db
      .selectDistinct({ sn: temuShipOrders.deliveryOrderSn, extCode: temuShipOrders.skcExtCode })
      .from(temuShipOrders)
      .where(
        and(
          inArray(temuShipOrders.storeId, storeIds),
          inArray(temuShipOrders.deliveryOrderSn, sns),
          eq(temuShipOrders.status, 0),
        ),
      ),
    db
      .select({ code: inventoryProducts.productCode })
      .from(inventoryProducts)
      .where(
        and(
          eq(inventoryProducts.enterpriseId, enterpriseId),
          sql`coalesce(${inventoryProducts.barcodePrePasted}, false) = false`,
        ),
      ),
  ])
  const needKeys = new Set(productRows.map((p) => normalizeSn(p.code)))
  const result = new Set<string>()
  for (const r of orderRows) {
    if (r.extCode && needKeys.has(normalizeSn(r.extCode))) result.add(r.sn)
  }
  return { ok: true as const, sns: [...result] }
}

/* ─── 物流公司偏好配置（自动预约发货；企业级，迁移 0093） ─── */

export type TemuLogisticsPrefItem = { expressCompanyId: number; expressCompanyName: string }

/** 校验并规范化偏好数组（≤50 项、id 整数、名称 1-120、按 id 去重保序） */
function parsePrefList(raw: unknown, label: string): TemuLogisticsPrefItem[] {
  if (!Array.isArray(raw)) throw new Error(`${label}须为数组`)
  const out: TemuLogisticsPrefItem[] = []
  const seen = new Set<number>()
  for (const it of raw.slice(0, 50)) {
    const id = Number((it as { expressCompanyId?: unknown })?.expressCompanyId)
    const name = (it as { expressCompanyName?: unknown })?.expressCompanyName
    if (!Number.isInteger(id) || typeof name !== "string" || !name.trim() || name.length > 120) {
      throw new Error(`${label}项须含物流公司 id 与名称`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ expressCompanyId: id, expressCompanyName: name.trim() })
  }
  return out
}

/** 读物流公司偏好（优先顺序+黑名单；无行回落空数组） */
export async function getLogisticsConfigAction() {
  let enterpriseId: string
  try {
    const ctx = await requireEnterpriseContext()
    if (!ctx.canAccess("temu")) {
      return { ok: false as const, error: "当前账号没有 TEMU 模块权限" }
    }
    enterpriseId = ctx.user.enterpriseId!
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "登录状态失效" }
  }
  const [row] = await db
    .select({ priority: temuLogisticsConfig.priority, blacklist: temuLogisticsConfig.blacklist })
    .from(temuLogisticsConfig)
    .where(eq(temuLogisticsConfig.enterpriseId, enterpriseId))
    .limit(1)
  return {
    ok: true as const,
    priority: (row?.priority ?? []) as TemuLogisticsPrefItem[],
    blacklist: (row?.blacklist ?? []) as TemuLogisticsPrefItem[],
  }
}

/** 保存物流公司偏好（upsert 每企业一行；两数组可只传其一=保持现值，
 *  同时出现在黑名单的优先项自动从优先顺序剔除） */
export async function updateLogisticsConfigAction(input: {
  priority?: unknown
  blacklist?: unknown
}) {
  let enterpriseId: string
  let userId: string
  try {
    const ctx = await requireEnterpriseContext()
    if (!ctx.canAccess("temu_ship")) {
      return { ok: false as const, error: "当前账号没有 TEMU 发货模块权限" }
    }
    enterpriseId = ctx.user.enterpriseId!
    userId = ctx.user.id
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "登录状态失效" }
  }
  try {
    const [current] = await db
      .select({ priority: temuLogisticsConfig.priority, blacklist: temuLogisticsConfig.blacklist })
      .from(temuLogisticsConfig)
      .where(eq(temuLogisticsConfig.enterpriseId, enterpriseId))
      .limit(1)
    const priority =
      input.priority === undefined
        ? ((current?.priority ?? []) as TemuLogisticsPrefItem[])
        : parsePrefList(input.priority, "优先顺序")
    const blacklist =
      input.blacklist === undefined
        ? ((current?.blacklist ?? []) as TemuLogisticsPrefItem[])
        : parsePrefList(input.blacklist, "黑名单")
    const blackIds = new Set(blacklist.map((b) => b.expressCompanyId))
    const finalPriority = priority.filter((p) => !blackIds.has(p.expressCompanyId))
    await db
      .insert(temuLogisticsConfig)
      .values({ enterpriseId, priority: finalPriority, blacklist, updatedBy: userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: temuLogisticsConfig.enterpriseId,
        set: { priority: finalPriority, blacklist, updatedBy: userId, updatedAt: new Date() },
      })
    return { ok: true as const, priority: finalPriority, blacklist }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "保存失败" }
  }
}

/* ─── TEMU 发货单同步（库存出入 tab；官方后台发的单不走本系统 packing.send，
       无 ship_deduct 流水——此入口供人工核对后一键补扣，2026-11-09） ─── */

export interface TemuSyncShipOrderRow {
  deliveryOrderSn: string
  storeId: string
  /** 归属店铺名（跨店同单号去重后留存的店） */
  storeName: string | null
  subPurchaseOrderSn: string | null
  productSkcId: number | null
  skcExtCode: string | null
  /** 商品名（确认弹窗汇总展示用） */
  productName: string | null
  /** 主图（发货单快照 kwcdn 优先，temu_product 转存/主图兜底） */
  mainImageUrl: string | null
  mainImageCosUrl: string | null
  /** 发货数量（SKC 件） */
  deliverSkcNum: number | null
  /** 收货仓库 */
  subWarehouseName: string | null
  /** 发货仓库（卖家发货地址 id；官方后台直发存量单可能为空） */
  deliveryAddressId: number | null
  /** 发货仓库标签（mall.address 按店映射；查不到降级「地址 {id}」） */
  deliveryAddressLabel: string | null
  /** 物流公司 / 运单号 */
  expressCompany: string | null
  expressDeliverySn: string | null
  /** 货号当前库存合计（归一化匹配档案；未建档 0） */
  totalQty: number
  status: number
  statusLabel: string
  deliverTime: string | null
  receiveTime: string | null
  /** 工厂直发单不参与库存扣减（货从工厂直发 TEMU），列表恒排除 */
  factoryDirect: boolean
  /** 已有 ship_deduct 流水（幂等键 refId=单号） */
  synced: boolean
}

/** 本企业已扣减（ship_deduct）的发货单号集合 */
async function loadDeductedSnSet(enterpriseId: string): Promise<Set<string>> {
  const rows = await db
    .select({ refId: inventoryMovements.refId })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.enterpriseId, enterpriseId),
        eq(inventoryMovements.type, "ship_deduct"),
        eq(inventoryMovements.refType, "ship_order"),
      ),
    )
  return new Set(rows.map((r) => r.refId).filter((v): v is string => !!v))
}

/**
 * TEMU 发货单同步列表（库存出入 tab 子视图）：本企业各店本地发货单快照，
 * 已发货（deliverTime 非空）、非工厂直发，按发货日期（北京日界，fromDay/toDay
 * 为 yyyy-MM-dd 含两端）筛选，标注是否已扣减并附带货号当前库存合计（扣减后
 * 预览=totalQty−数量）。行附店铺名与发货仓库标签（mall.address 按店 30s 缓存，
 * 查不到降级「地址 {id}」）；返回 warehouses=当前筛选结果中出现过的发货地址选项。
 * fresh=true（进入子视图/点刷新）时各店实时拉取官方最新单（freshPullStore，
 * 与发货页列表共用：最新一页落库 + 基准单号核对收敛官方已移除单），失败降级本地数据。
 */
export async function getTemuSyncShipOrdersAction(input: {
  fromDay?: string
  toDay?: string
  /** 发货出库筛选：pending=待出库（待仓库收货 [1]，默认）/ done=已出库已收货（[2,3,6]）/
   *  all=全部已发货（[1,2,3,6]，排除 0 未发货/4 退货/5 取消——无扣减意义） */
  statusGroup?: "pending" | "done" | "all"
  onlyUnsynced?: boolean
  /** 发货仓库筛选（卖家发货地址 id；空=全部仓库） */
  warehouseId?: number
  /** 实时拉取官方最新单（进入子视图/手动刷新；筛选变化不带） */
  fresh?: boolean
}): Promise<
  | {
      ok: true
      rows: TemuSyncShipOrderRow[]
      total: number
      /** 发货仓库下拉选项（当前筛选结果中出现过的地址，label zh-CN 排序） */
      warehouses: Array<{ id: number; label: string }>
      /** fresh 实时拉取统计（两次官方调用返回行数合计 / 收敛为已取消的单数） */
      freshStats?: { fetched: number; missing: number }
      /** fresh 部分店铺失败/跳过提示（全店成功无此字段） */
      freshWarning?: string
    }
  | { ok: false; error: string }
> {
  const g = await requireInventory()
  if (!g.ok) return { ok: false, error: g.error }
  const { enterpriseId } = g

  // 整行取回（StoreRow）：storeName 直接 select、发货仓库标签加载需要店铺上下文
  const storeRows = await db
    .select()
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, enterpriseId))
  if (storeRows.length === 0) return { ok: true, rows: [], total: 0, warehouses: [] }
  const ids = storeRows.map((s) => s.id)

  const statusList =
    input.statusGroup === "done"
      ? [2, 3, 6]
      : input.statusGroup === "all"
        ? [1, 2, 3, 6]
        : [1] // 默认待出库（待仓库收货）：已发出、仓库未确认——正是库存该扣未扣的窗口
  const conds = [
    inArray(temuShipOrders.storeId, ids),
    inArray(temuShipOrders.status, statusList),
    isNotNull(temuShipOrders.deliverTime),
    // 工厂直发不参与库存体系（官方同步进来的存量单 factoryDirect 为 null，视同常规单）
    or(isNull(temuShipOrders.factoryDirect), eq(temuShipOrders.factoryDirect, false)),
  ]
  if (input.fromDay && /^\d{4}-\d{2}-\d{2}$/.test(input.fromDay)) {
    conds.push(gte(temuShipOrders.deliverTime, new Date(`${input.fromDay}T00:00:00+08:00`)))
  }
  if (input.toDay && /^\d{4}-\d{2}-\d{2}$/.test(input.toDay)) {
    const end = new Date(new Date(`${input.toDay}T00:00:00+08:00`).getTime() + 86400_000)
    conds.push(lt(temuShipOrders.deliverTime, end))
  }
  // 跨店去重（同 loadTemuShipStats 口径）：官方 shiporderv2 同主体跨店可见，同一物理
  // 发货单会在多店各落一行（本地唯一键=店+单号）——保留 captured_at 最新一行
  // （最新鲜快照；同刻平手取 store_id 最小），子查询限定本次店铺集合防跨企业单号碰撞；
  // 单店唯一键天然无重复，不加
  if (ids.length > 1) {
    conds.push(
      sql`not exists (
        select 1 from temu_ship_order x
        where x.delivery_order_sn = ${temuShipOrders.deliveryOrderSn}
          and ${inArray(sql`x.store_id`, ids)}
          and (
            x.captured_at > ${temuShipOrders.capturedAt}
            or (x.captured_at = ${temuShipOrders.capturedAt} and x.store_id < ${temuShipOrders.storeId})
          )
      )`,
    )
  }

  const fetchRows = () =>
    db
      .select({
        order: temuShipOrders,
        storeName: temuStores.name,
        productName: temuProducts.productName,
        mainImageCosUrl: temuProducts.mainImageCosUrl,
        mainImageUrl: temuProducts.mainImageUrl,
      })
      .from(temuShipOrders)
      .leftJoin(temuStores, eq(temuStores.id, temuShipOrders.storeId))
      .leftJoin(
        temuProducts,
        and(
          eq(temuProducts.storeId, temuShipOrders.storeId),
          sql`cast(${temuShipOrders.productSkcId} as varchar) = ${temuProducts.productSkcId}`,
        ),
      )
      .where(and(...conds))
      .orderBy(desc(temuShipOrders.deliverTime))
      .limit(500)

  // fresh 实时拉取（口径同发货页列表）：各店并行 ①裸查最新一页落库 ②基准单号核对
  // 收敛官方已移除单（freshPullStore 共用；各店独立 3qps 限速桶，并行不互挤）。
  // 未录入 token 的店静默跳过（本就无官方数据可拉）；其余失败进 freshWarning 降级本地。
  let freshStats: { fetched: number; missing: number } | undefined
  let freshWarning: string | undefined
  if (input.fresh) {
    const baseline = await fetchRows()
    // 按店分组基准单号（跨店去重后归属行；deliverTime 最新 ≤50——官方单次回查上限）
    const snsByStore = new Map<string, string[]>()
    const rowMetaBySn = new Map<string, { status: number; born: Date }>()
    for (const r of baseline) {
      const list = snsByStore.get(r.order.storeId) ?? []
      if (list.length < 50) list.push(r.order.deliveryOrderSn)
      snsByStore.set(r.order.storeId, list)
      rowMetaBySn.set(r.order.deliveryOrderSn, {
        status: r.order.status,
        born: r.order.deliveryOrderCreateTime ?? r.order.capturedAt,
      })
    }
    const pullable = storeRows.filter((s) => !!s.accessTokenEncrypted)
    const problems: string[] = []
    let fetched = 0
    let missing = 0
    await Promise.all(
      pullable.map(async (store) => {
        try {
          const built = await getTemuCallContext(store)
          if ("error" in built) {
            problems.push(`${store.name}（${built.error}）`)
            return
          }
          const r = await freshPullStore(store.id, built, snsByStore.get(store.id) ?? [], rowMetaBySn)
          fetched += r.fetched
          missing += r.missing
        } catch (err) {
          problems.push(`${store.name}（${await toWorkbenchError(store.id, err)}）`)
        }
      }),
    )
    freshStats = { fetched, missing }
    if (problems.length > 0) {
      freshWarning =
        problems.length === pullable.length
          ? `实时拉取失败/跳过：${problems.join("、")}，已返回本地数据`
          : `实时拉取部分失败：${problems.join("、")}（其余店铺已实时核对）`
    }
  }

  const rows = await fetchRows()

  // 货号当前库存合计（同 getShipInventoryRefAction 口径：归一化匹配档案 + 全仓 sum）
  const [productMap, stockRows] = await Promise.all([
    loadProductMapBySnKey(enterpriseId),
    db
      .select({
        productId: inventoryStocks.productId,
        qty: sql<number>`coalesce(sum(${inventoryStocks.qty}), 0)::int`,
      })
      .from(inventoryStocks)
      .where(eq(inventoryStocks.enterpriseId, enterpriseId))
      .groupBy(inventoryStocks.productId),
  ])
  const stockByProduct = new Map(stockRows.map((r) => [r.productId, r.qty]))
  const totalQtyOf = (extCode: string | null): number => {
    if (!extCode) return 0
    const product = productMap.get(normalizeSn(extCode))
    return product ? (stockByProduct.get(product.id) ?? 0) : 0
  }

  const deducted = await loadDeductedSnSet(enterpriseId)
  // 发货仓库标签：按结果中出现的店铺拉 mall.address 映射（30s 缓存、失败空表降级），
  // 再跨店合并全局映射——同主体地址 id 全局唯一，一店标签缺失时另一店可补
  const storeById = new Map(storeRows.map((s) => [s.id, s]))
  const labelMaps = new Map(
    await Promise.all(
      [...new Set(rows.map((r) => r.order.storeId))].map(async (sid) => {
        const store = storeById.get(sid)
        return [
          sid,
          store ? await loadMallAddressLabels(store) : new Map<number, string>(),
        ] as const
      }),
    ),
  )
  const mergedLabels = new Map<number, string>()
  for (const m of labelMaps.values()) {
    for (const [id, label] of m) if (!mergedLabels.has(id)) mergedLabels.set(id, label)
  }
  let mapped: TemuSyncShipOrderRow[] = rows.map((r) => ({
    deliveryOrderSn: r.order.deliveryOrderSn,
    storeId: r.order.storeId,
    storeName: r.storeName,
    subPurchaseOrderSn: r.order.subPurchaseOrderSn,
    productSkcId: r.order.productSkcId ?? null,
    skcExtCode: r.order.skcExtCode,
    productName: r.productName,
    mainImageUrl: r.order.productSkcPicture ?? r.mainImageUrl ?? null,
    mainImageCosUrl: r.mainImageCosUrl ?? null,
    deliverSkcNum: r.order.deliverSkcNum,
    subWarehouseName: r.order.subWarehouseName ?? null,
    deliveryAddressId: r.order.deliveryAddressId ?? null,
    deliveryAddressLabel:
      r.order.deliveryAddressId != null
        ? (labelMaps.get(r.order.storeId)?.get(r.order.deliveryAddressId) ??
          mergedLabels.get(r.order.deliveryAddressId) ??
          `地址 ${r.order.deliveryAddressId}`)
        : null,
    expressCompany: r.order.expressCompany ?? null,
    expressDeliverySn: r.order.expressDeliverySn ?? null,
    totalQty: totalQtyOf(r.order.skcExtCode),
    status: r.order.status,
    statusLabel: SHIP_ORDER_STATUS[r.order.status] ?? `状态 ${r.order.status}`,
    deliverTime: r.order.deliverTime?.toISOString() ?? null,
    receiveTime: r.order.receiveTime?.toISOString() ?? null,
    factoryDirect: r.order.factoryDirect ?? false,
    synced: deducted.has(r.order.deliveryOrderSn),
  }))
  if (input.onlyUnsynced) mapped = mapped.filter((r) => !r.synced)
  // 发货仓库筛选选项：当前筛选结果（日期/状态/仅未同步）中出现过的地址，先于仓库
  // 过滤计算——选项不随已选仓库收缩；标签优先取跨店合并映射，全 miss 降级「地址 {id}」
  const addrIds = new Set<number>()
  for (const r of mapped) {
    if (r.deliveryAddressId != null) addrIds.add(r.deliveryAddressId)
  }
  const warehouses = [...addrIds]
    .map((id) => ({ id, label: mergedLabels.get(id) ?? `地址 ${id}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
  if (input.warehouseId != null) {
    mapped = mapped.filter((r) => r.deliveryAddressId === input.warehouseId)
  }
  const total = mapped.length
  return {
    ok: true,
    rows: mapped,
    total,
    warehouses,
    ...(freshStats ? { freshStats } : {}),
    ...(freshWarning ? { freshWarning } : {}),
  }
}

/** 同步扣减（人工核对后触发）：全店待扣单货号需求按归一化码合并成总量预检缺口
 *  （跨店同货号合计缺口也拦截；全过才扣，避免部分成功）→
 *  deductShipmentInventory（幂等 per 单号：事务内查重+单号咨询锁串行化，
 *  流水 reason=后台发货人工核对） */
export async function syncTemuShipDeductAction(input: {
  orders: Array<{ storeId: string; sn: string }>
}): Promise<
  | { ok: true; deducted: number }
  | { ok: false; error: string; shortages?: Array<{ productCode: string; needed: number; available: number }> }
> {
  const g = await requireInventory()
  if (!g.ok) return { ok: false, error: g.error }
  const { enterpriseId, ctx } = g

  const orders = (input.orders ?? []).filter((o) => o?.storeId && o?.sn).slice(0, 100)
  if (orders.length === 0) return { ok: false, error: "未选择要同步的发货单" }

  // 店铺归属校验（防跨企业越权）
  const ownStores = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(eq(temuStores.enterpriseId, enterpriseId))
  const ownIds = new Set(ownStores.map((s) => s.id))
  // 按单号去重：同一物理发货单可能被多店同步各落一行（前端列表已跨店去重，此处
  // 防御性兜底）——重复计入会把同单数量算两份，预检误报库存不足
  const seenSn = new Set<string>()
  const byStore = new Map<string, string[]>()
  for (const o of orders) {
    if (!ownIds.has(o.storeId)) return { ok: false, error: "存在无权操作的店铺发货单" }
    if (seenSn.has(o.sn)) continue
    seenSn.add(o.sn)
    const list = byStore.get(o.storeId) ?? []
    list.push(o.sn)
    byStore.set(o.storeId, list)
  }

  const warehouseId = await getMainWarehouseId(enterpriseId)
  if (!warehouseId) return { ok: false, error: "库存未初始化（无主仓），无法扣减" }

  // 已扣单剔除（幂等；预检与扣减都只对未扣单）
  const deducted = await loadDeductedSnSet(enterpriseId)

  // 全店合计预检：各店待扣单的货号需求按归一化码合并成总量后与主仓统一比较
  // （库存档案与库存行是企业级，两店发同一货号映射同一 stock 行——逐店独立预检
  //  各自通过与同一库存比较会漏掉跨店合计缺口，扣减阶段才失败产生部分扣减）；
  //  任一货号不足即整体不动，返回缺口明细
  const toDeduct: Array<{ storeId: string; sns: string[] }> = []
  for (const [storeId, sns0] of byStore) {
    const sns = [...new Set(sns0)].filter((sn) => !deducted.has(sn))
    if (sns.length === 0) continue
    toDeduct.push({ storeId, sns })
  }
  const allShortages: Array<{ productCode: string; needed: number; available: number }> = []
  if (toDeduct.length > 0) {
    const check = await db.transaction((tx) =>
      assertShipmentStockAggregated(tx, enterpriseId, toDeduct, warehouseId),
    )
    if (!check.ok) allShortages.push(...check.shortages)
  }
  if (allShortages.length > 0) {
    const detail = allShortages
      .slice(0, 5)
      .map((s) => `${s.productCode}（需 ${s.needed}，库存 ${s.available}）`)
      .join("、")
    return {
      ok: false,
      error: `库存不足，未执行扣减：${detail}${allShortages.length > 5 ? ` 等 ${allShortages.length} 项` : ""}。可先补录入库或改为手动出库调整。`,
      shortages: allShortages,
    }
  }
  if (toDeduct.length === 0) return { ok: true, deducted: 0 }

  let deductedCount = 0
  const errors: string[] = []
  for (const { storeId, sns } of toDeduct) {
    const r = await deductShipmentInventory(
      enterpriseId,
      storeId,
      sns,
      warehouseId,
      ctx.user.id,
      "TEMU 后台发货人工核对扣减",
    )
    if (r.error) errors.push(r.error)
    deductedCount += r.deducted
  }
  if (errors.length > 0) {
    return { ok: false, error: `部分失败（已扣 ${deductedCount} 张）：${errors.join("；")}` }
  }
  return { ok: true, deducted: deductedCount }
}
