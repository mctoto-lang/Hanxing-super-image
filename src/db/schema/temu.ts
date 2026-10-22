import {
  bigint,
  boolean,
  date,
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
 * Temu 卖家数据（手册 §4：多租户业务域）
 *
 * 数据来源：TEMU 官方开放平台（agentpartner.temu.com，bg.* 接口），
 * 由 temu-sync 定时/手动拉取（商品列表、生命周期、销售管理、爆款售罄），
 * 写入既有数据表并在 temu_ingest_log 留 api-* 审计。
 * 历史数据（2026-10 前）来自 Temu Collector 浏览器插件被动采集，该链路已下线；
 * 流量/广告等官方无接口的维度不再产生新数据（表保留历史）。
 *
 * 归属链：store（店铺，企业可多店铺，官方 API 店铺级 access_token）→ 各数据表。
 *
 * 数据域：商品、生命周期、销售管理、售罄、广告（官方 API 实时 + 历史插件存档）；
 * 流量表仅存档；核价/调价/活动工作台为实时拉取不落库；订单/备货单/发货批次未建表。
 */

/** 店铺（一个企业可配置多个 Temu 店铺；官方 API token 由企业管理员录入） */
export const temuStores = pgTable(
  "temu_store",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    /** 官方 API 店铺级令牌（AES-256-GCM 密文；卖家中心授权页复制，自研应用 365 天有效） */
    accessTokenEncrypted: text("access_token_encrypted"),
    /** 店铺类型（bg.mall.info.get 验证回写：full=全托 semi=半托） */
    mallType: varchar("mall_type", { length: 16 }),
    /** 绑定的 Temu mall（可选；bg.open.accesstoken.info.get.global 的 uniqueId，实测为 base64 串可到 56 字符） */
    mallId: varchar("mall_id", { length: 64 }),
    mallName: varchar("mall_name", { length: 100 }),
    /** token 状态：none=未录入 active=有效 invalid=已失效（7000007 触发） */
    tokenState: varchar("token_state", { length: 16 })
      .default("none")
      .notNull(),
    /** 预计到期时间（录入时间 + 365 天，展示提醒用；官方无自动刷新） */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    /** 是否参与定时同步 */
    syncEnabled: boolean("sync_enabled").default(true).notNull(),
    /** 最近一次同步时间 */
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** 最近一次同步结果（{ ok, startedAt, finishedAt, sources: { [source]: { ok, count, error } } }） */
    lastSyncStatus: jsonb("last_sync_status").$type<TemuSyncStatus | null>(),
    enabled: boolean("enabled").default(true).notNull(),
    /** 面板展示顺序（拖拽排序，小在前；默认 0 按 createdAt） */
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("gt_temu_store_ent").on(t.enterpriseId)],
)

/** 店铺同步结果（temu_store.lastSyncStatus 结构；skipped=true 表示该源不适用于店铺类型） */
export interface TemuSyncStatus {
  ok: boolean
  startedAt: string
  finishedAt: string
  sources: Record<
    string,
    { ok: boolean; count?: number; error?: string; skipped?: boolean }
  >
}

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

/** 销售管理总览明细（listOverall/salesv2，SKC 级 + SKU 价格在 priceDetail）。
 *  每 (店, SKC, 日) 一行、每轮同步覆盖更新——保证当日批次恒为全量，
 *  概览按「当日最新批次求和」才不漏内容未变化的在售商品。 */
export const temuSalesOverviews = pgTable(
  "temu_sales_overview",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    skcId: varchar("skc_id", { length: 32 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 数据日（北京时间；批次聚合/今日口径按它判日界） */
    capturedDay: date("captured_day").notNull(),
    productName: text("product_name"),
    category: varchar("category", { length: 120 }),
    supplierId: varchar("supplier_id", { length: 32 }),
    /** 货号（extCode，统一商品 ID） */
    productSn: varchar("product_sn", { length: 64 }),
    // —— SKC 级销量与库存（销售管理 listOverall：今日/7日/30日、仓内可用、已发货）——
    todaySalesVolume: integer("today_sales_volume"),
    last7DaysSalesVolume: integer("last7_days_sales_volume"),
    last30DaysSalesVolume: integer("last30_days_sales_volume"),
    warehouseAvailableStock: integer("warehouse_available_stock"),
    shippedStock: integer("shipped_stock"),
    /** 可售天数（销售管理同名列，availableSaleDays 优先 / warehouseAvailableSaleDays 兜底） */
    availableSaleDays: doublePrecision("available_sale_days"),
    /** SKU 价格明细（skuQuantityDetailList 原始数组） */
    priceDetail: jsonb("price_detail"),
    /** 顶层售罄/库存计数等其余字段 */
    overview: jsonb("overview").$type<Record<string, unknown>>(),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    /** 内容摘要（信息性保留；不再做唯一去重——改为按日覆盖） */
    contentHash: varchar("content_hash", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_sales_day").on(t.storeId, t.skcId, t.capturedDay),
    index("gt_temu_sales_time").on(t.storeId, t.capturedAt),
    index("gt_temu_sales_day_time").on(t.storeId, t.capturedDay),
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
    /** 上新生命周期状态文案（如 价格申报中；生命周期源 skcList 展开） */
    lifecycleStatus: varchar("lifecycle_status", { length: 64 }),
    /** 站点信息（生命周期源） */
    siteCode: varchar("site_code", { length: 32 }),
    siteName: varchar("site_name", { length: 64 }),
    /** 在售站点列表（goods-list 源 bindSites 拼接，如「US、EU」） */
    siteNames: text("site_names"),
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
    /** 商详访客去重数（流量情况-访客数） */
    goodsDetailVisitorNum: integer("goods_detail_visitor_num"),
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

/** 商品推广（ads.temu.com 商品级报表快照：花费/曝光/点击/成交；长尾指标进 metrics） */
export const temuProductAds = pgTable(
  "temu_product_ads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    /** 推广商品标识（goodsId / skcId 至少其一，与 temu_product 关联补货号） */
    goodsId: varchar("goods_id", { length: 32 }),
    skcId: varchar("skc_id", { length: 32 }),
    /** 货号（extCode，统一商品 ID；接口未携带时由 goodsId 关联 temu_product 回填） */
    productSn: varchar("product_sn", { length: 64 }),
    productName: text("product_name"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** 花费（金额单位以 ads 接口原始口径为准） */
    spend: doublePrecision("spend"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    orders: integer("orders"),
    gmv: doublePrecision("gmv"),
    /** 净口径（net_ad 组）：净申报价销售额（分） */
    netOrderPayAmt: doublePrecision("net_order_pay_amt"),
    /** ROAS 数值（全域，接口 ad 组原始值） */
    roasVal: doublePrecision("roas_val"),
    /** 净口径：净每笔成交花费（分） */
    netTransactionCost: doublePrecision("net_transaction_cost"),
    /** 净口径：净件数 */
    netGoodsNum: integer("net_goods_num"),
    /** 其余报表维度（CTR/CPC/转化率等整体存档） */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    mallMeta: jsonb("mall_meta").$type<TemuMallMeta | null>(),
    contentHash: varchar("content_hash", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_ads_dedup").on(t.storeId, t.contentHash),
    index("gt_temu_ads_time").on(t.storeId, t.capturedAt),
    index("gt_temu_ads_goods").on(t.storeId, t.goodsId),
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

/** 同步审计（官方 API 各 source 拉取结果；历史行为插件上报审计） */
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

/** 广告日报（店铺级：历史插件 queryReports 与官方 mall.query 共写，
 *  按日序列：花费/曝光/点击/订单/成交） */
export const temuAdsDailies = pgTable(
  "temu_ads_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** 花费（元；接口原始单位分已除 100；取 ad 推广维度） */
    adSpend: doublePrecision("ad_spend").default(0).notNull(),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    orders: integer("orders"),
    gmv: doublePrecision("gmv"),
    /** 官方 mall.query 日行长尾指标存档（ROAS/ACOS/CTR/CVR/加购/件数等，四维口径） */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("temu_ads_daily_unique").on(t.storeId, t.date),
    index("gt_temu_ads_daily_time").on(t.storeId, t.date),
  ],
)

/** 广告商品日报（官方 goods.query 天级行：bg.glo.searchrec.ad.reports.goods.query
 *  不传 productId 拉全店商品，按 (店, 日, 商品) upsert 幂等覆盖；金额分，
 *  指标取 ad 推广维度，四维全量存 metrics） */
export const temuAdsProductDailies = pgTable(
  "temu_ads_product_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    /** 货品 id（与 temu_product.productId 同空间） */
    productId: varchar("product_id", { length: 32 }).notNull(),
    /** 花费（分，ad 推广维度） */
    adSpend: doublePrecision("ad_spend"),
    /** 曝光量 */
    imprCnt: integer("impr_cnt"),
    /** 点击量 */
    clkCnt: integer("clk_cnt"),
    /** 加购数 */
    cartCnt: integer("cart_cnt"),
    /** 子订单量 */
    orderPayCnt: integer("order_pay_cnt"),
    /** 申报价销售额（分） */
    orderPayAmt: doublePrecision("order_pay_amt"),
    /** 件数 */
    goodsNum: integer("goods_num"),
    /** ROAS（推广维度） */
    roas: doublePrecision("roas"),
    /** ACOS 费比（推广维度） */
    acos: doublePrecision("acos"),
    /** 每笔成交花费（分） */
    transactionCost: doublePrecision("transaction_cost"),
    /** 全量指标（total/ad/netTotal/netAd 四维）存档 */
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("temu_ads_product_daily_unique").on(t.storeId, t.date, t.productId),
    index("gt_temu_ads_product_daily_time").on(t.storeId, t.date),
  ],
)

/** SKU 日销量序列（销售管理行内"销售趋势"图表直采，querySkuSalesNumber：
 *  {date, prodSkuId, salesNumber} 逐日条目；与快照推算相比是 TEMU 官方口径的日序列） */
export const temuSkuSalesDailies = pgTable(
  "temu_sku_sales_daily",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    /** SKU 编号（prodSkuId；与 listOverall 行内 skuQuantityDetailList.productSkuId 同空间） */
    skuId: varchar("sku_id", { length: 32 }).notNull(),
    date: date("date").notNull(),
    salesNumber: integer("sales_number").default(0).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("gt_temu_sku_sales_daily_dedup").on(t.storeId, t.skuId, t.date),
    index("gt_temu_sku_sales_daily_time").on(t.storeId, t.date),
  ],
)

/** SKU↔SKC 映射（listOverall 行内 SKU 明细提取；SKU 日序列按 SKC 聚合的关联依据）。
 *  supplier_price：SKU 级申报价（price.list.get 按 SKU 批查回填——salesv2
 *  的 SKU 明细 supplierPrice 实测已不返回，此列为 SKU 子表价格源） */
export const temuSkuMaps = pgTable(
  "temu_sku_map",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    skuId: varchar("sku_id", { length: 32 }).notNull(),
    skcId: varchar("skc_id", { length: 32 }).notNull(),
    supplierPrice: bigint("supplier_price", { mode: "number" }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("gt_temu_sku_map_dedup").on(t.storeId, t.skuId)],
)

/** API 广告注册表（temu_ad）：仅记录通过本站 ad.create 创建的广告。
 *  平台限制（2026-10-20 实测）：后台手动创建的广告对官方接口不可见，
 *  「我的广告」= 本表 + ad.detail.query 实时状态。budget 分口径。 */
export const temuAds = pgTable(
  "temu_ad",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    productId: varchar("product_id", { length: 32 }).notNull(),
    /** 日预算（分；创建时口径，实时值以 detail.query 为准） */
    budget: integer("budget"),
    /** 目标 ROAS */
    roas: doublePrecision("roas"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("gt_temu_ad_dedup").on(t.storeId, t.productId)],
)

/* ─── 模板化发品（M2：企业级刊登模板，跨店复用） ─── */

/** 发品模板属性值（attrs.get 选定项；父子联动在向导选值时已保证） */
export interface TemuTemplateAttr {
  templatePid: number
  pid: number
  refPid: number
  propName: string
  vid: number
  propValue: string
  valueUnit: string
  numberInputValue?: string
}

/** 自建规格定义（非服饰无内置销售规格——parentspec.get + spec.create 实测口径；
 *  specId 为店铺级，发品时按店 spec.create 同名幂等换取，不在模板落值） */
export interface TemuTemplateSpec {
  parentSpecId: number
  parentSpecName: string
  /** 规格值名（如 "藏青"） */
  specName: string
}

/** 发品模板默认层（发品实例可覆盖 title/imageUrls/declaredPriceFen/extCode） */
export interface TemuTemplateDefaults {
  /** 商品名（官方上限 500，类目特殊上限在预检透传官方错误） */
  title: string
  /** 素材图源（可为空；http(s) 或压缩 dataUrl——发品时按目标店上传图床并校验 1:1 ≥800×800 ≤2M） */
  imageUrls: string[]
  /** 申报价（分，SKU 级同价） */
  declaredPriceFen: number
  /** 货号（可空；字母数字标点） */
  extCode: string
  /** 产地二字码（productOrigin.countryShortName，2000146 必填） */
  countryShortName: string
  /** 中国省级 region2Id（官方仅到省级、无市级字段；仅 country=CN 时下发） */
  region2Id?: number
  /** SKU 重量（mg，官方口径） */
  weightMg: number
  /** SKU 体积（mm，最长边 ≥ 次长边 ≥ 最短边） */
  volumeMm: { len: number; width: number; height: number }
  /** 敏感属性（0 非敏感；1 需配 sensitiveTypes） */
  isSensitive: 0 | 1
  /** 敏感类型（110001 纯电 等；isSensitive=1 时必填） */
  sensitiveTypes: number[]
  /** 储电容量上限（Wh；纯电必填，非电池类目必须空） */
  maxBatteryCapacityWh?: number
  /** 外包装信息（形状 1 长方体/2 圆柱体，"其他不规则"=不提交形状；类型 0 硬包装/1 软包装+硬物/2 软包装+软物，按卖家中心顺序对应） */
  outerPackage?: { packageShape?: 1 | 2; packageType: 0 | 1 | 2 }
  /** 外包装图（正拍/侧拍/俯拍槽位顺序；≥1 张即提交） */
  outerPackageImages?: string[]
  /** 尺寸图源（可选；发品时按目标店上传后固定插轮播第 2 张——卖家中心页面口径，API 实测不校验位置） */
  dimensionImageUrl?: string
  /** 电子说明书（存 base64 源——发品时对目标店重传换 pdfId，需含英文内容 2000163；pdfMaterialId 兼容旧模板） */
  guideFile?: { fileName: string; pdfMaterialId?: number; languages: string[]; base64?: string }
  /** 定制商品工艺（§13.6；不配=非定制不提交该块） */
  customized?: { firstType: number; twiceType: number[]; technologyType: number }
  /** SKU 分类/多件装（不配=单品 1 件） */
  skuPack?: { skuClassification: 1 | 2 | 3; numberOfPieces: number; pieceUnitCode: number }
}

/**
 * 发品模板（企业级，跨店复用）。锁定层 = 类目链 + 属性 + 规格定义 + 默认层中的
 * 产地/重量/体积/敏感；可覆盖层 = 标题/图片/申报价/货号。发品仅能基于模板。
 */
export const temuPublishTemplates = pgTable(
  "temu_publish_template",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    /** draft 草稿 / active 可发 / archived 归档（软删） */
    status: varchar("status", { length: 16 }).default("draft").notNull(),
    createdBy: uuid("created_by"),
    /** 完整类目链（cats.get 钻取快照，1~6 级，最后一级 isLeaf） */
    categoryChain: jsonb("category_chain")
      .$type<Array<{ catId: number; catName: string; isLeaf: boolean }>>()
      .notNull(),
    leafCategoryId: bigint("leaf_category_id", { mode: "number" }).notNull(),
    /** 属性选定值（锁定层；实时 attrs.get 口径，模板过期由预检提示重选） */
    attributes: jsonb("attributes").$type<TemuTemplateAttr[]>().notNull(),
    /** 自建规格定义（锁定层；发品时按店铺幂等创建） */
    specConfig: jsonb("spec_config").$type<TemuTemplateSpec>().notNull(),
    /** 默认层（锁定骨架 + 可覆盖项） */
    defaults: jsonb("defaults").$type<TemuTemplateDefaults>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("gt_temu_pub_tpl_ent").on(t.enterpriseId, t.status)],
)

/** 发品记录（一次 publishFromTemplate 调用一行，成败都落） */
export const temuPublishRecords = pgTable(
  "temu_publish_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => temuPublishTemplates.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => temuStores.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    /** 发品时的覆盖值（未覆盖项为 null） */
    overrides: jsonb("overrides")
      .$type<Partial<Pick<TemuTemplateDefaults, "title" | "imageUrls" | "declaredPriceFen" | "extCode">>>()
      .notNull(),
    /** pending 组装中 / success / failed */
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    /** 官方返回的货品 id（成功时） */
    productId: varchar("product_id", { length: 32 }),
    errorCode: integer("error_code"),
    errorMsg: varchar("error_msg", { length: 1000 }),
    /** 审计：完整请求/响应快照（排障与口径回归） */
    requestSnapshot: jsonb("request_snapshot").$type<Record<string, unknown>>(),
    responseSnapshot: jsonb("response_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("gt_temu_pub_rec_ent").on(t.enterpriseId, t.createdAt),
    index("gt_temu_pub_rec_tpl").on(t.templateId),
  ],
)
