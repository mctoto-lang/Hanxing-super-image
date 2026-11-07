import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"

/**
 * 库存管理域（2026-10-29 v1.2 方案：与飞书多维表格完全独立的全渠道一套库存）
 *
 * 结构：仓库（主仓/义乌仓，混计不分包装态）/ 工厂档案 / 商品档案（货号企业内唯一）/
 * 库存明细（货号×仓）/ 变动流水（不可删改，错账冲正）/ 生产单（五态+工厂直发扣量）/
 * 直发记录（多次，TEMU 直发不动库存、直发自有仓入仓）/
 * 库存日快照（worker 每日落量，趋势/库存分析底座）/ 档案变更日志。
 *
 * 口径要点：
 * - 可发库存 = 所选仓库存总数（发货仓装箱时选，默认主仓）；
 * - 生产单数学：待入库 = 数量 − Σ直发 − Σ入库，Σ直发+Σ入库 ≥ 数量自动转已入库；
 * - 装箱硬阻断：packing.send 前按发货单行 skcExtCode×数量校验所选仓，不足阻断；
 *   勾「工厂直发」的发货单跳过校验且不扣库存；
 * - 六态状态（正常/补货/缺货/滞销/停产/清仓）：可售天数 = (仓库库存+TEMU净库存+在产)
 *   ÷日销，日销=0.7×近7天均+0.3×近30天均；TEMU净库存=仓内−待发货（备货单噪声）；
 *   货号匹配归一化 B049≡B49（首个数字串去前导零）；补货阈值企业级配置（inventory_settings）。
 */

/** 变动流水类型（调拨两行成对：transfer_out/transfer_in 同 refId=调拨组 id） */
export const inventoryMovementTypeEnum = pgEnum("inventory_movement_type", [
  "initial", // 期初建账
  "production_in", // 生产入库
  "factory_direct", // 工厂直发入自有仓（义乌）
  "ship_deduct", // TEMU 装箱发货扣减
  "manual_in", // 手动入库（其他入库）
  "manual_out", // 手动出库（渠道出库/报损/样品领用/直发其他，原因记 reason）
  "return_in", // 退货入库
  "transfer_out", // 调拨出
  "transfer_in", // 调拨入
  "stocktake", // 盘点过账
  "reversal", // 冲正（删除生产单自动反向等）
])

/** 生产单状态（五态；错单直接删不设作废态） */
export const productionOrderStatusEnum = pgEnum("inventory_production_order_status", [
  "materials_pending", // 待出材料
  "producing", // 生产中（材料已出）
  "factory_shipped", // 工厂已发（待入库）
  "received", // 已入库
  "finished", // 已结束
])

/** 直发目的地 */
export const directShipDestEnum = pgEnum("inventory_direct_ship_dest", [
  "temu", // TEMU 备货直发（不经自有仓，不动库存）
  "warehouse", // 直发自有仓（义乌）
])

/** 商品档案生产状态 */
export const inventoryProductionStateEnum = pgEnum("inventory_production_state", [
  "active", // 持续生产：断货后规划补货、工厂继续生产
  "stopped", // 停止生产：库存售罄后停产不再生产
])

/** 商品档案发货状态（0081 语义替换：自动/手动，均装箱自动扣库存，差异在自动化范围） */
export const inventoryShipStateEnum = pgEnum("inventory_ship_state", [
  "auto", // 自动发货：库存联动自动扣减；后续「一键自动备货发货」只处理该状态
  "manual", // 手动发货：装箱发货照常自动扣库存，自动化功能不对该货号执行
])

/** 仓库（期初「主仓」「义乌仓」，混计：未包装/已包装合计一个数） */
export const inventoryWarehouses = pgTable(
  "inventory_warehouse",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    sort: integer("sort").default(0).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("inv_wh_ent_code").on(t.enterpriseId, t.code)],
)

/** 工厂档案（生产方代号 JS/JYC/RP/XG/XHY/HZ…，页面内维护） */
export const inventoryFactories = pgTable(
  "inventory_factory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    note: text("note"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("inv_factory_ent_code").on(t.enterpriseId, t.code)],
)

/** 商品档案（货号 = TEMU skcExtCode 匹配键，建后禁改；纯手动建档） */
export const inventoryProducts = pgTable(
  "inventory_product",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    /** 货号（企业内唯一；创建后不可修改） */
    productCode: varchar("product_code", { length: 32 }).notNull(),
    /** 款名 */
    name: varchar("name", { length: 128 }).notNull(),
    imageUrl: text("image_url"),
    /** 装箱数（每箱件数，仅参考——不同工厂装箱数可能不同） */
    cartonQty: integer("carton_qty"),
    /** 生产周期（天，交期=生产日期+此值） */
    leadTimeDays: integer("lead_time_days"),
    /** 库存上限（补货建议卡上限，可空=不限） */
    stockUpper: integer("stock_upper"),
    /** 最小生产量 MOQ（建议量不足时抬到 MOQ 再按装箱数取整） */
    moq: integer("moq"),
    /** 条码预贴标记（true=出厂已贴无需打印；false=未预贴，发货时一并打印） */
    barcodePrePasted: boolean("barcode_pre_pasted").default(false).notNull(),
    /** 生产状态：active=持续生产（断货后规划补货） stopped=停止生产（售罄即停产） */
    productionState: inventoryProductionStateEnum("production_state").default("active").notNull(),
    /** 发货状态：auto=自动发货 manual=手动发货（装箱均自动扣库存，自动化只跑 auto） */
    shipState: inventoryShipStateEnum("ship_state").default("auto").notNull(),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("inv_product_ent_code").on(t.enterpriseId, t.productCode),
    index("inv_product_ent").on(t.enterpriseId),
  ],
)

/** 库存明细（货号×仓 = 数量；变动统一走 applyMovements 事务入口） */
export const inventoryStocks = pgTable(
  "inventory_stock",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => inventoryWarehouses.id, { onDelete: "cascade" }),
    qty: integer("qty").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("inv_stock_product_wh").on(t.productId, t.warehouseId),
    index("inv_stock_ent").on(t.enterpriseId),
  ],
)

/** 变动流水（不可删改；记变动前/后值；冲正用反向流水） */
export const inventoryMovements = pgTable(
  "inventory_movement",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => inventoryWarehouses.id, { onDelete: "cascade" }),
    type: inventoryMovementTypeEnum("type").notNull(),
    /** 变动数量（正=入 负=出） */
    qtyChange: integer("qty_change").notNull(),
    qtyBefore: integer("qty_before").notNull(),
    qtyAfter: integer("qty_after").notNull(),
    /** 箱数记录（箱+件双输入口径，件数为准） */
    boxQty: integer("box_qty"),
    /** 关联单据类型：production_order / direct_ship / ship_order / stocktake / transfer / manual */
    refType: varchar("ref_type", { length: 32 }),
    /** 关联单据 id（调拨两行同 refId=调拨组 id） */
    refId: varchar("ref_id", { length: 64 }),
    /** 原因/备注（手动出入库必填） */
    reason: varchar("reason", { length: 255 }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("inv_mv_ent_time").on(t.enterpriseId, t.createdAt),
    index("inv_mv_product").on(t.productId, t.createdAt),
    index("inv_mv_ref").on(t.refType, t.refId),
  ],
)

/** 生产单（五态；直发先行扣量：待入库 = 数量 − Σ直发 − Σ入库） */
export const inventoryProductionOrders = pgTable(
  "inventory_production_order",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "cascade" }),
    factoryId: uuid("factory_id")
      .notNull()
      .references(() => inventoryFactories.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    productionDate: date("production_date").notNull(),
    /** 工厂交货是否已包装（仅批次属性；仓内不分包装态混计） */
    packaged: boolean("packaged").default(true).notNull(),
    /** 辅料四勾（随材料发工厂的清单） */
    auxBarcode: boolean("aux_barcode").default(false).notNull(),
    auxManual: boolean("aux_manual").default(false).notNull(),
    auxBubble: boolean("aux_bubble").default(false).notNull(),
    auxWarn: boolean("aux_warn").default(false).notNull(),
    /** 预计交期（建单自动 = 生产日期 + 商品生产周期；超期标红） */
    expectedDate: date("expected_date"),
    status: productionOrderStatusEnum("status").default("materials_pending").notNull(),
    /** 已入库累计（冗余，分批入库累加） */
    shippedQty: integer("shipped_qty").default(0).notNull(),
    /** 直发累计（冗余，TEMU+仓直发合计） */
    directQty: integer("direct_qty").default(0).notNull(),
    /** 工厂发货箱数（登记工厂已发时填） */
    factoryBoxQty: integer("factory_box_qty"),
    factoryShipDate: date("factory_ship_date"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("inv_po_ent_status").on(t.enterpriseId, t.status),
    index("inv_po_product").on(t.productId),
  ],
)

/** 直发记录（一单多次，可与入库交错；箱+件双输入件数为准） */
export const inventoryDirectShips = pgTable(
  "inventory_direct_ship",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => inventoryProductionOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "cascade" }),
    shipDate: date("ship_date").notNull(),
    boxQty: integer("box_qty"),
    qty: integer("qty").notNull(),
    /** temu=TEMU 备货直发（不动库存） warehouse=直发自有仓（义乌，入仓+流水） */
    destType: directShipDestEnum("dest_type").notNull(),
    warehouseId: uuid("warehouse_id").references(() => inventoryWarehouses.id, {
      onDelete: "restrict",
    }),
    /** TEMU 备货单号/发货单号备注 */
    temuRef: varchar("temu_ref", { length: 128 }),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("inv_ds_order").on(t.orderId), index("inv_ds_ent").on(t.enterpriseId)],
)

/** 库存日快照（worker 每日落 货号×仓 存量；趋势与分析页底座） */
export const inventorySnapshots = pgTable(
  "inventory_snapshot",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => inventoryWarehouses.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull(),
  },
  (t) => [
    uniqueIndex("inv_snap_unique").on(t.day, t.productId, t.warehouseId),
    index("inv_snap_ent_day").on(t.enterpriseId, t.day),
  ],
)

/** 库存企业级设置（每企业一行；补货阈值/滞销判定等统一配置，总览页按钮维护） */
export const inventorySettings = pgTable("inventory_settings", {
  enterpriseId: uuid("enterprise_id")
    .primaryKey()
    .references(() => enterprises.id, { onDelete: "cascade" }),
  /** 补货阈值（天）：可售天数 < 此值判定为「补货」状态 */
  restockThresholdDays: integer("restock_threshold_days").default(14).notNull(),
  /** 滞销判定天数（近 N 天销量 ≤ 上限判滞销） */
  stagnantDays: integer("stagnant_days").default(30).notNull(),
  /** 滞销判定销量上限（件） */
  stagnantMaxQty: integer("stagnant_max_qty").default(0).notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
})

/** 商品档案变更日志（字段/旧值→新值/操作人；档案页可查） */
export const inventoryProductLogs = pgTable(
  "inventory_product_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => inventoryProducts.id, { onDelete: "cascade" }),
    field: varchar("field", { length: 64 }).notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("inv_plog_product").on(t.productId, t.createdAt)],
)
