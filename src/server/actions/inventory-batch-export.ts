"use server"

import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import ExcelJS from "exceljs"
import { db } from "@/db/client"
import {
  inventoryFactories,
  inventoryMovements,
  inventoryProducts,
  inventoryProductionOrders,
} from "@/db/schema"
import {
  applyMovements,
  getMainWarehouseId,
  InsufficientStockError,
  requireInventory,
} from "@/server/services/inventory-core"
import { getInventoryOverviewAction } from "@/server/actions/inventory"
import {
  PRODUCTION_STATE_LABELS,
  SHIP_STATE_LABELS,
  STOCK_STATUS_LABELS,
} from "@/components/inventory/labels"

/**
 * 批量操作与 Excel 导出（批次6）：
 * 批量出入库（单仓制固定主仓，单事务全成全败）；xlsx 导出（总览/生产单）。
 */

const batchMovementSchema = z
  .object({
    mode: z.enum(["in", "out"]),
    /** 入库流水类型（「退货入库」走 return_in）；仅 mode=in 可传 */
    type: z.enum(["manual_in", "return_in"]).optional(),
    reason: z.string().trim().min(1, "原因必填").max(255),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          qty: z.number().int().positive("数量须为正整数"),
          boxQty: z.number().int().positive().optional().nullable(),
        }),
      )
      .min(1, "请勾选货号并填写数量")
      .max(100),
  })
  .refine((v) => v.mode !== "out" || v.type === undefined, {
    message: "出库不得指定入库类型",
  })

/** 批量出入库：同类型同原因，数量逐行填，单事务原子提交 */
export async function batchMovementAction(input: unknown) {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const q = batchMovementSchema.safeParse(input)
  if (!q.success) return { ok: false as const, error: q.error.issues[0]?.message ?? "参数错误" }

  const ids = [...new Set(q.data.items.map((i) => i.productId))]
  const products = await db
    .select({ id: inventoryProducts.id, code: inventoryProducts.productCode })
    .from(inventoryProducts)
    .where(and(eq(inventoryProducts.enterpriseId, g.enterpriseId), inArray(inventoryProducts.id, ids)))
  if (products.length !== ids.length) return { ok: false as const, error: "存在无效货号" }
  const codeMap = new Map(products.map((p) => [p.id, p.code]))
  // 单仓制：仓库固定主仓
  const mainWhId = await getMainWarehouseId(g.enterpriseId)
  if (!mainWhId) return { ok: false as const, error: "库存未初始化，请先访问库存总览" }

  try {
    await db.transaction(async (tx) => {
      for (const item of q.data.items) {
        await applyMovements(tx, [
          {
            enterpriseId: g.enterpriseId,
            productId: item.productId,
            warehouseId: mainWhId,
            type: q.data.mode === "out" ? "manual_out" : (q.data.type ?? "manual_in"),
            qtyChange: q.data.mode === "out" ? -item.qty : item.qty,
            boxQty: item.boxQty ?? null,
            refType: "manual",
            reason: `批量：${q.data.reason}`,
            createdBy: g.ctx.user.id,
          },
        ])
      }
    })
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      const code = codeMap.get(err.productId) ?? ""
      return {
        ok: false as const,
        error: `库存不足（${code}，库存 ${err.available} 件需 ${err.needed} 件），整批已回滚`,
      }
    }
    throw err
  }
  return { ok: true as const, count: q.data.items.length }
}

/* ─── Excel 导出（exceljs，返回 base64 xlsx，前端 Blob 下载） ─── */

function sheetBase(wb: ExcelJS.Workbook, name: string) {
  const ws = wb.addWorksheet(name)
  ws.views = [{ state: "frozen", ySplit: 1 }]
  return ws
}

function autoWidth(ws: ExcelJS.Worksheet) {
  ws.columns.forEach((col) => {
    let max = 8
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      max = Math.max(max, String(cell.value ?? "").length + 2)
    })
    col.width = Math.min(42, max)
  })
}

/** 导出库存总览（口径与页面一致：六态状态/TEMU净库存/可售天数随总览 action 算出） */
export async function exportInventoryOverviewExcelAction() {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const overview = await getInventoryOverviewAction({})
  if (!overview.ok) return { ok: false as const, error: overview.error }

  const wb = new ExcelJS.Workbook()
  const ws = sheetBase(wb, "库存总览")
  ws.addRow([
    "货号", "款名", "库存", "TEMU库存", "可售天数(天)", "状态",
    "库存上限", "MOQ", "装箱数", "生产周期(天)", "条码", "发货状态", "生产状态", "备注",
  ])
  for (const p of overview.rows) {
    ws.addRow([
      p.productCode,
      p.name,
      p.totalQty,
      p.temuStock,
      p.availableDays ?? "",
      STOCK_STATUS_LABELS[p.status] ?? p.status,
      p.stockUpper ?? "",
      p.moq ?? "",
      p.cartonQty ?? "",
      p.leadTimeDays ?? "",
      p.barcodePrePasted ? "无需打印" : "需要打印",
      SHIP_STATE_LABELS[p.shipState] ?? p.shipState,
      PRODUCTION_STATE_LABELS[p.productionState] ?? p.productionState,
      p.note ?? "",
    ])
  }
  autoWidth(ws)
  const buf = await wb.xlsx.writeBuffer()
  return { ok: true as const, base64: Buffer.from(buf).toString("base64"), filename: `库存总览_${new Date().toISOString().slice(0, 10)}.xlsx` }
}

/** 导出生产单列表（全部状态） */
export async function exportProductionExcelAction() {
  const g = await requireInventory()
  if (!g.ok) return { ok: false as const, error: g.error }
  const rows = await db
    .select({
      order: inventoryProductionOrders,
      productCode: inventoryProducts.productCode,
      productName: inventoryProducts.name,
      factoryCode: inventoryFactories.code,
    })
    .from(inventoryProductionOrders)
    .innerJoin(inventoryProducts, eq(inventoryProductionOrders.productId, inventoryProducts.id))
    .innerJoin(inventoryFactories, eq(inventoryProductionOrders.factoryId, inventoryFactories.id))
    .where(eq(inventoryProductionOrders.enterpriseId, g.enterpriseId))
    .orderBy(inventoryProductionOrders.productionDate)

  const STATUS: Record<string, string> = {
    materials_pending: "待出材料", producing: "生产中", factory_shipped: "工厂已发",
    received: "已入库", finished: "已结束",
  }
  // 已入库/已结束单耗时定格（与 listProductionOrdersAction 同口径：最后一条生产入库流水）
  const doneIds = rows
    .filter((r) => r.order.status === "received" || r.order.status === "finished")
    .map((r) => r.order.id)
  const doneAtMap = new Map<string, Date>()
  if (doneIds.length > 0) {
    const doneRows = await db
      .select({
        refId: inventoryMovements.refId,
        last: sql<string>`max(${inventoryMovements.createdAt})`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.enterpriseId, g.enterpriseId),
          eq(inventoryMovements.type, "production_in"),
          eq(inventoryMovements.refType, "production_order"),
          inArray(inventoryMovements.refId, doneIds),
        ),
      )
      .groupBy(inventoryMovements.refId)
    for (const d of doneRows) {
      if (d.refId && d.last) doneAtMap.set(d.refId, new Date(d.last))
    }
  }
  const wb = new ExcelJS.Workbook()
  const ws = sheetBase(wb, "生产单")
  ws.addRow(["生产日期", "货号", "款名", "工厂", "数量", "直发", "已入库", "余量", "状态", "预计交期", "耗时(天)", "工厂箱数", "是否包装", "辅料", "备注"])
  for (const r of rows) {
    const o = r.order
    ws.addRow([
      o.productionDate,
      r.productCode,
      r.productName,
      r.factoryCode,
      o.quantity,
      o.directQty,
      o.shippedQty,
      o.quantity - o.directQty - o.shippedQty,
      STATUS[o.status] ?? o.status,
      o.expectedDate ?? "",
      Math.max(0, Math.floor(((doneAtMap.get(o.id) ?? Date.now()).valueOf() - new Date(`${o.productionDate}T00:00:00Z`).getTime()) / 86400000)),
      o.factoryBoxQty ?? "",
      o.packaged ? "已包装" : "未包装",
      [o.auxBarcode && "条码", o.auxManual && "说明书", o.auxBubble && "气泡袋", o.auxWarn && "警告标"].filter(Boolean).join("/") || "—",
      o.note ?? "",
    ])
  }
  autoWidth(ws)
  const buf = await wb.xlsx.writeBuffer()
  return { ok: true as const, base64: Buffer.from(buf).toString("base64"), filename: `生产单_${new Date().toISOString().slice(0, 10)}.xlsx` }
}
