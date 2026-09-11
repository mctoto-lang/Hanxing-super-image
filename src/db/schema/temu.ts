import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"

/**
 * Temu 卖家数据采集（手册 §4：多租户业务域）
 *
 * 数据来源：Temu Collector 浏览器插件（被动捕获卖家中心接口）经
 * /api/v1/ingest 上报（X-Device-Token = temu_store.deviceToken）。
 *
 * 归属链：store（店铺，企业可多店铺）→ 各数据表；
 * 条目级 mall 归属由数据内嵌 supplierId 判定（一个登录账号可挂多个 mall），
 * mallMeta（supplierIds/mallNames）随上报携带，落库于各表 mall_meta。
 *
 * 数据域（v1 范围）：销售管理、商品列表、上新生命周期、流量分析、活动数据；
 * 订单/备货单/发货批次本期不建表（未知 source 仅记 temu_ingest_log 审计）。
 */

/** 店铺（一个企业可配置多个 Temu 店铺；token 由企业管理员在面板生成） */
export const temuStores = pgTable(
  "temu_store",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    /** 插件上报凭证（X-Device-Token），仅创建/重置时明文展示 */
    deviceToken: varchar("device_token", { length: 64 }).notNull(),
    /** 绑定的 Temu mall（可选，数据内嵌 supplierId 与之对应时归属成立） */
    mallId: varchar("mall_id", { length: 32 }),
    mallName: varchar("mall_name", { length: 100 }),
    enabled: boolean("enabled").default(true).notNull(),
    /** 最近一次成功上报时间（在线状态判据） */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_store_token").on(t.deviceToken),
    index("gt_temu_store_ent").on(t.enterpriseId),
  ],
)

/** 条目级 mall 归属（数据内嵌 supplierId → mallName 映射，随上报携带） */
export interface TemuMallMeta {
  supplierIds?: string[]
  mallNames?: string[]
}

/** 指标快照（首页经营大盘 / 售罄看板 / 履约统计，每次上报一行，按天取最新画趋势） */
export const temuMetricSnapshots = pgTable(
  "temu_metric_snapshot",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    /** 插件规则 id（dashboard-stats / soldout-overview / fulfilment-stats / activity-data…） */
    source: varchar("source", { length: 64 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    // —— 首页大盘（queryStatisticDataFullManaged）——
    saleVolume: integer("sale_volume"),
    sevenDaysSaleVolume: integer("seven_days_sale_volume"),
    thirtyDaysSaleVolume: integer("thirty_days_sale_volume"),
    onSaleProductNumber: integer("on_sale_product_number"),
    waitProductNumber: integer("wait_product_number"),
    lackSkcNumber: integer("lack_skc_number"),
    aboutToSellOutNumber: integer("about_to_sell_out_number"),
    alreadySoldOutNumber: integer("already_sold_out_number"),
    adjustPrice: integer("adjust_price"),
    reviewAdjustPrice: integer("review_adjust_price"),
    highPriceLimitNumber: integer("high_price_limit_number"),
    advicePrepareSkcNumber: integer("advice_prepare_skc_number"),
    // —— 售罄看板（querySoldOutOverview）——
    todaySellOutNum: integer("today_sell_out_num"),
    todaySellOutRatio: doublePrecision("today_sell_out_ratio"),
    todaySoonSellOutNum: integer("today_soon_sell_out_num"),
    todaySoonSellOutRatio: doublePrecision("today_soon_sell_out_ratio"),
    todaySellOutLossNum: integer("today_sell_out_loss_num"),
    increaseSellOutNum: integer("increase_sell_out_num"),
    increaseSoonSellOutNum: integer("increase_soon_sell_out_num"),
    /** 其余标量与整包响应（活动大盘等未展开字段）兜底存档 */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    /** 内容哈希：防插件重发导致的重复快照 */
    contentHash: varchar("content_hash", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_metric_dedup").on(t.storeId, t.source, t.contentHash),
    index("gt_temu_metric_time").on(t.storeId, t.source, t.capturedAt),
  ],
)

/** 销售管理总览明细（listOverall，SKC 级 + SKU 价格在 priceDetail） */
export const temuSalesOverviews = pgTable(
  "temu_sales_overview",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    skcId: varchar("skc_id", { length: 32 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    productName: text("product_name"),
    category: varchar("category", { length: 120 }),
    supplierId: varchar("supplier_id", { length: 32 }),
    /** SKU 价格明细（skuQuantityDetailList 原始数组） */
    priceDetail: jsonb("price_detail"),
    /** 顶层售罄/库存计数等其余字段 */
    overview: jsonb("overview").$type<Record<string, unknown>>(),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    contentHash: varchar("content_hash", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_sales_dedup").on(t.storeId, t.skcId, t.contentHash),
    index("gt_temu_sales_time").on(t.storeId, t.capturedAt),
  ],
)

/** 商品（商品列表 + 上新生命周期两源合并，按 skcId upsert 保最新状态） */
export const temuProducts = pgTable(
  "temu_product",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    productSkcId: varchar("product_skc_id", { length: 32 }).notNull(),
    productId: varchar("product_id", { length: 32 }),
    goodsId: varchar("goods_id", { length: 32 }),
    productName: text("product_name"),
    category: varchar("category", { length: 120 }),
    leafCategoryName: varchar("leaf_category_name", { length: 120 }),
    cat1Name: varchar("cat1_name", { length: 120 }),
    supplierId: varchar("supplier_id", { length: 32 }),
    /** 申报供货价（分，CNY） */
    supplierPrice: bigint("supplier_price", { mode: "number" }),
    /** 流量增长状态（生命周期源） */
    flowGrowStatus: integer("flow_grow_status"),
    hasSkcSelected: boolean("has_skc_selected"),
    /** 0=正常 1=已下架（products-list 源 removeStatus） */
    removeStatus: integer("remove_status"),
    /** SKC 状态码（products-list 源，11=在售等） */
    skcStatus: integer("skc_status"),
    /** 货号（extCode） */
    productSn: varchar("product_sn", { length: 64 }),
    /** 商品累计销量 */
    totalSalesVolume: integer("total_sales_volume"),
    /** 近 7 天销量 */
    last7DaysSalesVolume: integer("last7_days_sales_volume"),
    /** 主图 URL */
    mainImageUrl: text("main_image_url"),
    /** 对接买手/运营（生命周期源 nickContact） */
    buyerName: varchar("buyer_name", { length: 100 }),
    /** 生命周期时间线摘要（epoch ms） */
    skcCreatedAt: bigint("skc_created_at", { mode: "number" }),
    priceVerifiedAt: bigint("price_verified_at", { mode: "number" }),
    firstPurchaseAt: bigint("first_purchase_at", { mode: "number" }),
    addedSiteAt: bigint("added_site_at", { mode: "number" }),
    /** 生命周期明细：skcList（状态时间线/各 SKC 状态）+ 状态聚合分布 */
    lifecycleDetail: jsonb("lifecycle_detail"),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_product_skc").on(t.storeId, t.productSkcId),
    index("gt_temu_product_name").on(t.storeId),
    index("gt_temu_product_sn").on(t.storeId, t.productSn),
  ],
)

/** 商品流量（流量分析明细 + 首页流量增长榜，12 项核心指标结构化，环比留 metrics） */
export const temuProductFlows = pgTable(
  "temu_product_flow",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    /** flux-analysis-goods 用 goodsId；flow-grow-home 用 skcId */
    goodsId: varchar("goods_id", { length: 32 }).notNull(),
    goodsName: text("goods_name"),
    category: varchar("category", { length: 120 }),
    goodsImageUrl: text("goods_image_url"),
    productSpuId: varchar("product_spu_id", { length: 32 }),
    /** 数据源（flux-analysis-goods / flow-grow-home） */
    source: varchar("source", { length: 64 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    // —— 12 项核心指标（结构化，当日值；环比与长尾维度在 metrics）——
    exposeNum: integer("expose_num"),
    clickNum: integer("click_num"),
    payGoodsNum: integer("pay_goods_num"),
    payOrderNum: integer("pay_order_num"),
    buyerNum: integer("buyer_num"),
    addToCartUserNum: integer("add_to_cart_user_num"),
    goodsDetailVisitNum: integer("goods_detail_visit_num"),
    searchExposeNum: integer("search_expose_num"),
    searchClickNum: integer("search_click_num"),
    recommendExposeNum: integer("recommend_expose_num"),
    recommendClickNum: integer("recommend_click_num"),
    /** 其余维度值与全部环比（字段多且常变，整体存档） */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    contentHash: varchar("content_hash", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_flow_dedup").on(t.storeId, t.goodsId, t.source, t.contentHash),
    index("gt_temu_flow_time").on(t.storeId, t.source, t.capturedAt),
    index("gt_temu_flow_expose").on(t.storeId, t.exposeNum),
  ],
)

/** 活动数据（宽前缀规则 /api/activity/data/*：大盘/明细整包存档，结构稳定后提升关系列） */
export const temuActivities = pgTable(
  "temu_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    /** 具体接口短名（market-trend / goods-list 等，从 URL 提取） */
    source: varchar("source", { length: 64 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 整包响应（normalized 标量 + raw） */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    contentHash: varchar("content_hash", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_act_dedup").on(t.storeId, t.source, t.contentHash),
    index("gt_temu_act_time").on(t.storeId, t.source, t.capturedAt),
  ],
)

/** 上报审计（全部 source 落此表；未建表的 source 仅此留痕不丢） */
export const temuIngestLogs = pgTable(
  "temu_ingest_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 64 }).notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    acceptedCount: integer("accepted_count").default(0).notNull(),
    /** 处理备注（unknown-source / upsert 冲突统计等） */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("gt_temu_log_time").on(t.storeId, t.receivedAt)],
)
