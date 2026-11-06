import { z } from "zod"

/**
 * 库存管理域入参 schema（zod；action 层统一 parse）
 */

export const inventoryProductCreateSchema = z.object({
  productCode: z
    .string()
    .trim()
    .min(1, "货号必填")
    .max(32, "货号最长 32 字符")
    .regex(/^[A-Za-z0-9_-]+$/, "货号仅限字母/数字/下划线/中划线"),
  name: z.string().trim().min(1, "款名必填").max(128),
  imageUrl: z.string().url().max(2048).optional().nullable(),
  cartonQty: z.number().int().positive("装箱数须为正整数").optional().nullable(),
  leadTimeDays: z.number().int().positive("生产周期须为正整数").optional().nullable(),
  stockUpper: z.number().int().positive("库存上限须为正整数").optional().nullable(),
  moq: z.number().int().positive("最小生产量须为正整数").optional().nullable(),
  /** 条码预贴标记（true=出厂已贴无需打印；false=未预贴，发货时一并打印） */
  barcodePrePasted: z.boolean().default(false),
  productionState: z.enum(["active", "stopped"]).default("active"),
  shipState: z.enum(["auto", "manual"]).default("auto"),
  note: z.string().trim().max(2000).optional().nullable(),
})
export type InventoryProductCreateInput = z.infer<typeof inventoryProductCreateSchema>

/** 货号创建后不可改（TEMU skcExtCode 匹配键）——更新 schema 不含 productCode；
 *  继承自 create 的三个带默认字段覆盖为无默认 optional（部分更新不静默重置档案字段） */
export const inventoryProductUpdateSchema = inventoryProductCreateSchema
  .omit({
    productCode: true,
  })
  .extend({
    barcodePrePasted: z.boolean().optional(),
    productionState: z.enum(["active", "stopped"]).optional(),
    shipState: z.enum(["auto", "manual"]).optional(),
  })
export type InventoryProductUpdateInput = z.infer<typeof inventoryProductUpdateSchema>

/** 手动出入库：入库=manual_in/return_in，出库=manual_out；原因必填；单仓制固定主仓 */
export const inventoryManualMovementSchema = z
  .object({
    productId: z.string().uuid(),
    type: z.enum(["manual_in", "return_in", "manual_out"]),
    qty: z.number().int().positive("数量须为正整数"),
    boxQty: z.number().int().positive("箱数须为正整数").optional().nullable(),
    reason: z.string().trim().min(1, "原因必填").max(255),
  })
  .refine((v) => v.type !== "manual_out" || v.reason.length > 0, {
    message: "出库原因必填",
    path: ["reason"],
  })
export type InventoryManualMovementInput = z.infer<typeof inventoryManualMovementSchema>

/** 库存总览查询（q 搜货号/款名；status=六态筛选 chips） */
export const inventoryOverviewQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  /** 六态：正常/补货/缺货/滞销/停产/清仓；缺省=全部 */
  status: z
    .enum(["normal", "restock", "out_of_stock", "stagnant", "discontinued", "clearance"])
    .optional(),
  productionState: z.enum(["active", "stopped"]).optional(),
})
export type InventoryOverviewQueryInput = z.infer<typeof inventoryOverviewQuerySchema>

/** 货号搜索（Command 选择器） */
export const inventoryProductSearchSchema = z.object({
  q: z.string().trim().max(64).default(""),
  limit: z.number().int().min(1).max(50).default(20),
})

/** 按日期范围查有变动的商品（「库存出入」视图聚合；from/to=北京时间 YYYY-MM-DD，from≤to 且跨度≤366 天） */
export const inventoryMovementsQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD"),
  })
  .refine((v) => v.from <= v.to, { message: "起始日期不能晚于结束日期", path: ["from"] })
  .refine(
    (v) => new Date(`${v.to}T00:00:00+08:00`).getTime() - new Date(`${v.from}T00:00:00+08:00`).getTime() <= 366 * 86_400_000,
    { message: "日期范围最长 366 天", path: ["to"] },
  )
export type InventoryMovementsQueryInput = z.infer<typeof inventoryMovementsQuerySchema>

// ---------- 生产单 ----------

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式 YYYY-MM-DD")

export const productionOrderCreateSchema = z.object({
  productId: z.string().uuid(),
  factoryId: z.string().uuid(),
  quantity: z.number().int().positive("生产数量须为正整数"),
  productionDate: dateStr,
  packaged: z.boolean().default(true),
  auxBarcode: z.boolean().default(false),
  auxManual: z.boolean().default(false),
  auxBubble: z.boolean().default(false),
  auxWarn: z.boolean().default(false),
  note: z.string().trim().max(2000).optional().nullable(),
})
export type ProductionOrderCreateInput = z.infer<typeof productionOrderCreateSchema>

/** 编辑（仅未完结前可用：数量/日期/工厂/辅料/包装/备注） */
export const productionOrderUpdateSchema = productionOrderCreateSchema
export type ProductionOrderUpdateInput = z.infer<typeof productionOrderUpdateSchema>

/** 发材料（待出材料 → 生产中，可顺带改辅料勾选） */
export const productionSendMaterialsSchema = z.object({
  orderId: z.string().uuid(),
  auxBarcode: z.boolean().optional(),
  auxManual: z.boolean().optional(),
  auxBubble: z.boolean().optional(),
  auxWarn: z.boolean().optional(),
})

/** 登记工厂发货（生产中 → 工厂已发；重复登记覆盖箱数/日期） */
export const productionFactoryShipSchema = z.object({
  orderId: z.string().uuid(),
  boxQty: z.number().int().positive("箱数须为正整数").optional().nullable(),
  shipDate: dateStr,
})

/** 直发登记（一单多次；箱+件双输入件数为准） */
export const productionDirectShipSchema = z.object({
  orderId: z.string().uuid(),
  shipDate: dateStr,
  qty: z.number().int().positive("件数须为正整数"),
  boxQty: z.number().int().positive("箱数须为正整数").optional().nullable(),
  destType: z.enum(["temu", "warehouse"]),
  temuRef: z.string().trim().max(128).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
})
export type ProductionDirectShipInput = z.infer<typeof productionDirectShipSchema>

/** 分批入库（箱+件；累计 Σ直发+Σ入库 ≥ 数量自动转已入库；单仓制固定主仓） */
export const productionReceiptSchema = z.object({
  orderId: z.string().uuid(),
  qty: z.number().int().positive("件数须为正整数"),
  boxQty: z.number().int().positive("箱数须为正整数").optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
})

/** 删除生产单（有记录自动冲正；原因必填） */
export const productionDeleteSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(1, "删除原因必填").max(255),
})

export const productionListQuerySchema = z.object({
  /** open=进行中（前三态） archive=已入库+已结束 */
  group: z.enum(["open", "archive"]).default("open"),
  q: z.string().trim().max(64).optional(),
  factoryId: z.string().uuid().optional(),
})

// ---------- 工厂档案 ----------

export const inventoryFactorySchema = z.object({
  code: z.string().trim().min(1, "代号必填").max(32),
  name: z.string().trim().min(1, "名称必填").max(64),
  note: z.string().trim().max(500).optional().nullable(),
  enabled: z.boolean().default(true),
})
export type InventoryFactoryInput = z.infer<typeof inventoryFactorySchema>

/** 工厂更新：enabled 无默认 optional——缺省不写入（防把已停用工厂静默重启用） */
export const inventoryFactoryUpdateSchema = inventoryFactorySchema.extend({
  enabled: z.boolean().optional(),
})
export type InventoryFactoryUpdateInput = z.infer<typeof inventoryFactoryUpdateSchema>
