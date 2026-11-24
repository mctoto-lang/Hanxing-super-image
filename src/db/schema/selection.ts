import { relations, sql } from "drizzle-orm"
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import {
  selectionTaskStatusEnum,
  selectionTaskTypeEnum,
} from "./_shared"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import type { SelectionAiSummaryData } from "@/lib/selection/ai-summary-types"

/**
 * 选品工具（selection 域，0104）
 *
 * 基于 Apify Actor 按结果付费抓取：任务提交时预扣个人配额积分，worker 双循环
 * （认领启动 + 轮询收割）结算，实际条数 < 预估时退差额。
 * 任务与结果企业内共享（保留 userId 创建人字段）；收藏按用户隔离。
 */

/**
 * 企业级 Apify 抓取凭证（每企业最多一行，仿 temu_app 模式）
 *
 * token 加密存储（enc:v1: AES-256-GCM）；企业未配置时回退平台级
 * APIFY_API_TOKEN 环境变量。任务提交时快照 providerId，worker 启动/收割
 * 均按任务快照解析 token（dataset 归属启动账号，跨账号不可读）。
 */
export const selectionProviders = pgTable(
  "selection_provider",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .unique()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    /** enc:v1: AES-256-GCM 密文（空串 = 未设置，提交任务时报错指引配置） */
    tokenEncrypted: text("token_encrypted").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("sp_ent_enabled").on(t.enterpriseId, t.enabled)],
)

/**
 * 选品抓取任务
 *
 * 状态机：queued（web 单事务写入+扣积分）→ processing（worker 认领并调
 * Apify startActorRun，回写 apifyRunId/apifyDatasetId）→ completed / failed /
 * cancelled（轮询收割循环对 Apify 侧终态幂等收敛，无属主、崩溃自愈）。
 */
export const selectionTasks = pgTable(
  "selection_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    /** 创建人（企业共享可见，保留归属便于筛选） */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskType: selectionTaskTypeEnum("task_type").default("market").notNull(),
    /** 平台 key（selection-platforms 注册表：amazon/etsy/temu/...） */
    platform: varchar("platform", { length: 32 }).notNull(),
    /** Apify Actor 全名（提交时从注册表快照，便于日后换 Actor 仍可溯源） */
    actorId: varchar("actor_id", { length: 255 }).notNull(),
    /** 表单原始参数（不同平台字段不同，jsonb 灵活存储） */
    searchParams: jsonb("search_params").$type<Record<string, unknown>>().notNull(),
    /** 展示用关键词（列表/筛选用；非关键词型任务存目标描述如店铺域名） */
    keyword: varchar("keyword", { length: 255 }),
    /** 抓取目标国家/站点（ISO 码大写，如 US；平台无国家参数时为 null） */
    country: varchar("country", { length: 16 }),
    /** 提交时使用的企业凭证快照（null = 平台级 APIFY_API_TOKEN 兜底启动） */
    providerId: uuid("provider_id").references(() => selectionProviders.id, {
      onDelete: "set null",
    }),
    maxResults: integer("max_results").notNull(),
    /** 提交时按 maxResults × 平台费率预扣的积分 */
    estimatedCredits: integer("estimated_credits").notNull(),
    /** 结算时按实际入库条数计算的实际消耗（未结算为 null） */
    actualCredits: integer("actual_credits"),
    status: selectionTaskStatusEnum("status").default("queued").notNull(),
    /** 0-100：dataset 条数 ÷ maxResults 近似估算 */
    progress: integer("progress").default(0).notNull(),
    fetchedCount: integer("fetched_count").default(0).notNull(),
    apifyRunId: varchar("apify_run_id", { length: 64 }),
    apifyDatasetId: varchar("apify_dataset_id", { length: 64 }),
    errorMessage: text("error_message"),
    /** 竞品监控目标（0106）：monitor/review 型任务的归属，趋势查询 join 用 */
    monitorId: uuid("monitor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    index("st_ent_status").on(t.enterpriseId, t.status),
    index("st_ent_created").on(t.enterpriseId, t.createdAt),
    index("st_apify_run").on(t.apifyRunId),
    index("st_monitor").on(t.monitorId),
  ],
)

/**
 * 抓取结果（每任务不可变快照行）
 *
 * 统一字段由各平台 normalizer 从 raw_data 提炼；rawData 永久保留完整原始行
 * （后续 Phase 3 AI 分析、竞品监控 diff 都基于历史快照）。
 * dedupeKey + unique(taskId, dedupeKey)：worker 重入（轮询循环崩溃重启后重拉
 * dataset）幂等，不产生重复行。
 */
export const selectionResults = pgTable(
  "selection_result",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => selectionTasks.id, { onDelete: "cascade" }),
    /** 冗余企业隔离字段（防跨租户泄漏的查询口径统一） */
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 32 }).notNull(),
    /** 数据池筛选/卡片国家徽章：从任务参数传播（ISO 大写；无则 null） */
    country: varchar("country", { length: 16 }),
    /** 任务类型快照（discover/market；卡片 kind 判定与池筛选用） */
    taskType: varchar("task_type", { length: 16 }),
    /** 平台原生 ID（ASIN/goodsId/pinId/tweet id...；无 ID 型结果为 null） */
    externalId: varchar("external_id", { length: 255 }),
    sourceUrl: text("source_url"),
    /** 幂等键：externalId 优先，回退 sourceUrl/标题哈希 */
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title"),
    /** 社交平台正文（帖子文案/推文）；电商为 null */
    content: text("content"),
    /** numeric 返回 string，展示层 Number() 转换 */
    price: numeric("price", { precision: 12, scale: 2 }),
    originalPrice: numeric("original_price", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 8 }),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    reviewCount: integer("review_count"),
    salesCount: integer("sales_count"),
    likesCount: integer("likes_count"),
    commentsCount: integer("comments_count"),
    sharesCount: integer("shares_count"),
    viewsCount: integer("views_count"),
    /** 平台名次（0108）：Amazon BSR / 榜单名次；其余平台 null，供标签内排序与表格列 */
    rank: integer("rank"),
    sellerName: varchar("seller_name", { length: 255 }),
    images: jsonb("images").$type<string[]>(),
    videos: jsonb("videos").$type<string[]>(),
    category: varchar("category", { length: 255 }),
    categoryPath: jsonb("category_path").$type<string[]>(),
    tags: jsonb("tags").$type<string[]>(),
    hashtags: jsonb("hashtags").$type<string[]>(),
    /** 平台侧发布时间（社交帖子；电商/榜单为 null） */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** 完整原始行（永久保留） */
    rawData: jsonb("raw_data").notNull(),
    /** Phase 3 AI 分析结果（情感/关键词/痛点/机会点），当前恒 null */
    aiAnalysis: jsonb("ai_analysis"),
    scrapedAt: timestamp("scraped_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("sr_task").on(t.taskId),
    index("sr_ent_created").on(t.enterpriseId, t.createdAt),
    index("sr_ent_platform").on(t.enterpriseId, t.platform, t.createdAt),
    index("sr_platform_external").on(t.platform, t.externalId),
    index("sr_ent_platform_rank").on(t.enterpriseId, t.platform, t.rank),
    uniqueIndex("sr_task_dedupe").on(t.taskId, t.dedupeKey),
  ],
)

/**
 * 选品收藏（我的选品页；按用户隔离，集合用 collectionName 字符串分组不建表）
 */
export const selectionBookmarks = pgTable(
  "selection_bookmark",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resultId: uuid("result_id")
      .notNull()
      .references(() => selectionResults.id, { onDelete: "cascade" }),
    notes: text("notes"),
    customTags: jsonb("custom_tags").$type<string[]>(),
    /** 集合名（如「2026 春季选品」），空 = 未分组 */
    collectionName: varchar("collection_name", { length: 100 }),
    /** high / medium / low */
    priority: varchar("priority", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("sb_user_result").on(t.userId, t.resultId),
    index("sb_user_created").on(t.userId, t.createdAt),
  ],
)

/**
 * 竞品监控目标（0106）
 *
 * 从数据池卡片「加入竞品监控」创建：worker 调度循环按 nextRunAt 认领到期
 * 目标，创建 monitor（指标重抓）/ review（评论抓取）任务，计费走发起人
 * 个人配额（与普通任务同口径；积分不足自动暂停）。latest_* 列为最近一次
 * 重抓快照（列表页免 join 展示）；趋势 = 按 monitor_id 聚合 selection_result
 * 历史行按日期展开。
 */
export const selectionMonitors = pgTable(
  "selection_monitor",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    /** 发起人（重抓计费归属；监控企业内共享可见） */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 32 }).notNull(),
    /** 监控目标直链（商品页/帖子页/店铺页；Actor URL 入口） */
    targetUrl: text("target_url").notNull(),
    /** 平台原生 ID（ASIN/pinId/tweet id…；X 回复抓取需 tweet id） */
    externalId: varchar("external_id", { length: 255 }),
    title: text("title"),
    imageUrl: text("image_url"),
    country: varchar("country", { length: 16 }),
    // ── 最近一次重抓快照（worker 收割后回写） ──
    lastPrice: numeric("last_price", { precision: 12, scale: 2 }),
    lastRating: numeric("last_rating", { precision: 3, scale: 2 }),
    lastSalesCount: integer("last_sales_count"),
    lastReviewCount: integer("last_review_count"),
    lastLikesCount: integer("last_likes_count"),
    lastCommentsCount: integer("last_comments_count"),
    // ── 0108 扩列：社媒播放/转发、Amazon BSR/榜单名次、币种（原实现恒按 $ 展示） ──
    lastViewsCount: integer("last_views_count"),
    lastSharesCount: integer("last_shares_count"),
    lastRank: integer("last_rank"),
    lastCurrency: varchar("last_currency", { length: 8 }),
    lastMetricsAt: timestamp("last_metrics_at", { withTimezone: true }),
    /** 重抓间隔（小时；6/12/24/48/72） */
    intervalHours: integer("interval_hours").default(24).notNull(),
    /** 是否随重抓一起抓评论（平台支持时） */
    trackReviews: boolean("track_reviews").default(true).notNull(),
    /** 单次评论抓取条数上限 */
    reviewMax: integer("review_max").default(50).notNull(),
    /** active / paused（积分不足或手动暂停） */
    status: varchar("status", { length: 16 }).default("active").notNull(),
    pauseReason: varchar("pause_reason", { length: 255 }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    runCount: integer("run_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("sm_ent_target").on(t.enterpriseId, t.targetUrl),
    index("sm_ent_status_next").on(t.enterpriseId, t.status, t.nextRunAt),
  ],
)

/**
 * 评论正文（0106）：监控评论抓取（电商评论/社媒评论）统一归一化落库。
 * dedupeKey + unique(taskId, dedupeKey) 幂等（worker 重拉 dataset 不重复）。
 */
export const selectionReviews = pgTable(
  "selection_review",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => selectionTasks.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id").references(() => selectionMonitors.id, {
      onDelete: "set null",
    }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 32 }).notNull(),
    country: varchar("country", { length: 16 }),
    /** 评论平台 ID */
    externalId: varchar("external_id", { length: 255 }),
    dedupeKey: text("dedupe_key").notNull(),
    /** 被评论对象（列表页展示上下文） */
    targetTitle: text("target_title"),
    targetUrl: text("target_url"),
    authorName: varchar("author_name", { length: 255 }),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    content: text("content"),
    likesCount: integer("likes_count"),
    verified: boolean("verified"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    scrapedAt: timestamp("scraped_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    rawData: jsonb("raw_data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("srv_task_dedupe").on(t.taskId, t.dedupeKey),
    index("srv_ent_platform").on(t.enterpriseId, t.platform, t.scrapedAt),
    index("srv_monitor").on(t.monitorId, t.scrapedAt),
  ],
)

/**
 * AI 分析结果（0106，内部 AI 生成、平台承担成本不扣积分）：
 *   kind='monitor'：单监控目标评论汇总（每目标一行，重抓后覆盖刷新）
 *   kind='digest' ：社媒平台日汇总（enterprise+platform+day 一行，任务完成后覆盖刷新）
 *   kind='target' ：一次性抓评论的目标级汇总（0108，无监控目标时按 enterprise+target_url 归并）
 * summary 形状 { sentiment, sentimentScore, pros[], cons[], keywords[], quotes[], suggestion, hotTopics? }
 */
export const selectionAiSummaries = pgTable(
  "selection_ai_summary",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    monitorId: uuid("monitor_id").references(() => selectionMonitors.id, {
      onDelete: "cascade",
    }),
    /** kind='target' 的归并键：被评论对象的来源链接 */
    targetUrl: text("target_url"),
    day: date("day"),
    platform: varchar("platform", { length: 32 }),
    modelName: varchar("model_name", { length: 255 }),
    summary: jsonb("summary").$type<SelectionAiSummaryData>().notNull(),
    reviewCount: integer("review_count").default(0).notNull(),
    postCount: integer("post_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("sas_monitor")
      .on(t.monitorId)
      .where(sql`kind = 'monitor' AND monitor_id IS NOT NULL`),
    uniqueIndex("sas_digest")
      .on(t.enterpriseId, t.platform, t.day)
      .where(sql`kind = 'digest'`),
    uniqueIndex("sas_target")
      .on(t.enterpriseId, t.targetUrl)
      .where(sql`kind = 'target' AND ${t.targetUrl} IS NOT NULL`),
  ],
)

export const selectionTasksRelations = relations(
  selectionTasks,
  ({ one, many }) => ({
    enterprise: one(enterprises, {
      fields: [selectionTasks.enterpriseId],
      references: [enterprises.id],
    }),
    user: one(users, {
      fields: [selectionTasks.userId],
      references: [users.id],
    }),
    provider: one(selectionProviders, {
      fields: [selectionTasks.providerId],
      references: [selectionProviders.id],
    }),
    results: many(selectionResults),
  }),
)

export const selectionProvidersRelations = relations(
  selectionProviders,
  ({ one, many }) => ({
    enterprise: one(enterprises, {
      fields: [selectionProviders.enterpriseId],
      references: [enterprises.id],
    }),
    tasks: many(selectionTasks),
  }),
)

export const selectionResultsRelations = relations(
  selectionResults,
  ({ one }) => ({
    task: one(selectionTasks, {
      fields: [selectionResults.taskId],
      references: [selectionTasks.id],
    }),
  }),
)

export const selectionBookmarksRelations = relations(
  selectionBookmarks,
  ({ one }) => ({
    user: one(users, {
      fields: [selectionBookmarks.userId],
      references: [users.id],
    }),
    result: one(selectionResults, {
      fields: [selectionBookmarks.resultId],
      references: [selectionResults.id],
    }),
  }),
)

export const selectionMonitorsRelations = relations(
  selectionMonitors,
  ({ one, many }) => ({
    enterprise: one(enterprises, {
      fields: [selectionMonitors.enterpriseId],
      references: [enterprises.id],
    }),
    user: one(users, {
      fields: [selectionMonitors.userId],
      references: [users.id],
    }),
    tasks: many(selectionTasks),
    reviews: many(selectionReviews),
  }),
)

export const selectionReviewsRelations = relations(
  selectionReviews,
  ({ one }) => ({
    task: one(selectionTasks, {
      fields: [selectionReviews.taskId],
      references: [selectionTasks.id],
    }),
    monitor: one(selectionMonitors, {
      fields: [selectionReviews.monitorId],
      references: [selectionMonitors.id],
    }),
  }),
)
