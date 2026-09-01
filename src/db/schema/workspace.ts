import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import { models } from "./models"
import { generationTasks } from "./tasks"

/**
 * 批量生图工作台（手册 §4.4、M5，1:1 对齐旧项目）
 *
 * 全部表加 enterpriseId 租户隔离；jsonb 替代旧 SQLite text。
 * 翻译/参考图/异步对话队列/导出等旧项目全部能力均落表。
 */

/** 对话模型特有扩展配置（OpenAI 请求参数） */
export interface ChatModelExtraConfig {
  temperature?: number
  maxTokens?: number
  [key: string]: unknown
}

/**
 * 对话模型配置（/chat 交互式对话 + 提示词裂变/细化/翻译/重生成 用的 LLM）
 *
 * 与 model 表同构的租户双轨：enterpriseId 为 NULL = 平台预置（超管维护，
 * 全企业可用）；否则为企业私有（企业管理员维护，受 allowCustomModels 门控）。
 * 除图片特有字段（尺寸预设/参考图/页面可见性等）外，字段与 model 表保持一致。
 * name 为模型标识（请求体 model 参数），displayName 为显示名。
 *
 * formatType：openai（OpenAI 兼容）/ claude（Anthropic）/ gemini（Google）/
 * grok（xAI，OpenAI 兼容）。工作台内部提示词操作仍走旧 callChatApi，仅支持
 * openai 格式（解析侧有 formatType='openai' 过滤防回归）。
 *
 * 计费：inputPriceCenticredits / outputPriceCenticredits 为百万 token 价格，
 * 单位「厘」= 0.01 积分（250 = 2.50 积分/百万 tokens），整数存储避免浮点误差。
 */
export const chatApiConfigs = pgTable(
  "chat_api_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "cascade",
    }), // NULL = 平台预置
    name: varchar("name", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    description: text("description"),
    badgeText: varchar("badge_text", { length: 30 }),
    badgeColor: varchar("badge_color", { length: 30 }),
    iconUrl: text("icon_url"),
    apiEndpoint: text("api_endpoint").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    formatType: varchar("format_type", { length: 30 }).default("openai").notNull(), // openai | claude | gemini | grok
    extraConfig: jsonb("extra_config").$type<ChatModelExtraConfig>(),
    /** 最大上下文 tokens（圆环分母 + 服务端上下文裁剪预算） */
    maxContextTokens: integer("max_context_tokens").default(32768).notNull(),
    /** 单次最大输出 tokens（请求 max_tokens 上限） */
    maxOutputTokens: integer("max_output_tokens").default(4096).notNull(),
    /** 百万输入 token 价格（厘 = 0.01 积分；0 = 免费） */
    inputPriceCenticredits: integer("input_price_centicredits")
      .default(0)
      .notNull(),
    /** 百万输出 token 价格（厘 = 0.01 积分；0 = 免费） */
    outputPriceCenticredits: integer("output_price_centicredits")
      .default(0)
      .notNull(),
    /** 是否支持思考强度（UI 显示 关闭/低/中/高 选择器） */
    supportsThinking: boolean("supports_thinking").default(false).notNull(),
    maxConcurrent: integer("max_concurrent").default(5).notNull(),
    maxRetries: integer("max_retries").default(3).notNull(),
    apiTimeout: integer("api_timeout").default(120).notNull(),
    taskTimeout: integer("task_timeout").default(300).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("cac_ent").on(t.enterpriseId),
    // 平台预置 / 企业私有 各自 (name, apiEndpoint) 唯一，与 model 表的拆分唯一索引同构
    uniqueIndex("chat_model_name_endpoint_platform_unique")
      .on(t.name, t.apiEndpoint)
      .where(sql`${t.enterpriseId} IS NULL`),
    uniqueIndex("chat_model_name_endpoint_ent_unique")
      .on(t.name, t.apiEndpoint)
      .where(sql`${t.enterpriseId} IS NOT NULL`),
  ],
)

/**
 * 提示词模板（裂变/细化/重生成/提取/翻译）
 *
 * type: fission | deepen | regenerate | extract | translate
 * visibility: private（仅 owner）| public（企业内可见）
 * status: active | archived（软删除）
 */
export const promptTemplates = pgTable(
  "prompt_template",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 30 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    content: text("content").notNull(), // 含 {{prompt}} / {{count}} 占位符
    chatApiId: uuid("chat_api_id").references(() => chatApiConfigs.id, {
      onDelete: "set null",
    }),
    fissionCount: integer("fission_count"),
    ownerId: uuid("owner_id").references(() => users.id, {
      onDelete: "set null",
    }), // NULL = 系统级
    visibility: varchar("visibility", { length: 20 }).default("public").notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pt_ent_type").on(t.enterpriseId, t.type),
    check(
      "prompt_template_type_chk",
      sql`${t.type} IN ('fission', 'deepen', 'regenerate', 'extract', 'translate')`,
    ),
    check("prompt_template_visibility_chk", sql`${t.visibility} IN ('private', 'public')`),
    check("prompt_template_status_chk", sql`${t.status} IN ('active', 'archived')`),
  ],
)

/** 工作台任务（一个主题 → N 张卡片） */
export const workspaceTasks = pgTable(
  "workspace_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    themePrompt: text("theme_prompt").notNull(),
    templateId: uuid("template_id").references(() => promptTemplates.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 20 }).default("generating").notNull(), // generating | completed | failed
    cardCount: integer("card_count").default(0).notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wt_ent_user").on(t.enterpriseId, t.userId),
    index("wt_ent_status").on(t.enterpriseId, t.status),
    check(
      "workspace_task_status_chk",
      sql`${t.status} IN ('generating', 'completed', 'failed')`,
    ),
  ],
)

/** 工作台任务收藏 */
export const workspacePinnedTasks = pgTable(
  "workspace_pinned_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workspaceTasks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique("wpt_ent_user_task").on(t.enterpriseId, t.userId, t.taskId)],
)

/**
 * 提示词卡片（任务下 N 张）
 *
 * 翻译相关字段支持中英文切换与译文过期判定；
 * referenceImages 为参考图 URL 数组。
 */
export const promptCards = pgTable(
  "prompt_card",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workspaceTasks.id, { onDelete: "cascade" }),
    cardIndex: integer("card_index").notNull(),
    prompt: text("prompt").notNull(),
    selectedImageId: uuid("selected_image_id"),
    translatedPrompt: text("translated_prompt"),
    translationSourcePrompt: text("translation_source_prompt"), // 翻译时的源中文，用于判断译文是否过期
    translationStatus: varchar("translation_status", { length: 20 })
      .default("none")
      .notNull(), // none | translating | synced | outdated | failed
    translationTemplateId: uuid("translation_template_id").references(
      () => promptTemplates.id,
      { onDelete: "set null" },
    ),
    displayLanguage: varchar("display_language", { length: 5 })
      .default("zh")
      .notNull(), // zh | en
    referenceImages: jsonb("reference_images").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pc_ent_task").on(t.enterpriseId, t.taskId),
    check(
      "prompt_card_translation_status_chk",
      sql`${t.translationStatus} IN ('none', 'translating', 'synced', 'outdated', 'failed')`,
    ),
    check("prompt_card_display_language_chk", sql`${t.displayLanguage} IN ('zh', 'en')`),
  ],
)

/**
 * 卡片图片（每张卡片下 M 张候选图）
 *
 * source: generated（AI 生成）| uploaded（用户上传）
 * generationTaskId 关联 generation_tasks，generationPrompt 为实际用于生图的提示词（可能为英文译文）。
 */
export const cardImages = pgTable(
  "card_image",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => promptCards.id, { onDelete: "cascade" }),
    imageApiId: uuid("image_api_id").references(() => models.id, {
      onDelete: "set null",
    }),
    imageUrl: text("image_url").notNull(),
    size: varchar("size", { length: 30 }),
    format: varchar("format", { length: 10 }).default("png").notNull(),
    status: varchar("status", { length: 20 }).default("generating").notNull(), // pending | generating | completed | failed
    errorMessage: text("error_message"),
    isSelected: boolean("is_selected").default(false).notNull(),
    generationTaskId: uuid("generation_task_id").references(
      () => generationTasks.id,
      { onDelete: "set null" },
    ),
    generationPrompt: text("generation_prompt"),
    source: varchar("source", { length: 20 }).default("generated").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("ci_ent_card").on(t.enterpriseId, t.cardId),
    check(
      "card_image_status_chk",
      sql`${t.status} IN ('pending', 'generating', 'completed', 'failed')`,
    ),
    check("card_image_format_chk", sql`${t.format} IN ('png', 'jpg', 'jpeg', 'webp')`),
    check("card_image_source_chk", sql`${t.source} IN ('generated', 'uploaded')`),
  ],
)

/** 工作台 API 日志 */
export const workspaceApiLogs = pgTable(
  "workspace_api_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    apiType: varchar("api_type", { length: 30 }).notNull(), // chat | image
    apiConfigId: uuid("api_config_id"),
    apiConfigName: varchar("api_config_name", { length: 100 }),
    workspaceTaskId: uuid("workspace_task_id").references(() => workspaceTasks.id, {
      onDelete: "cascade",
    }),
    cardId: uuid("card_id").references(() => promptCards.id, {
      onDelete: "cascade",
    }),
    generationTaskId: uuid("generation_task_id").references(
      () => generationTasks.id,
      { onDelete: "set null" },
    ),
    requestParams: text("request_params"),
    responseStatus: varchar("response_status", { length: 20 })
      .default("success")
      .notNull(),
    responseBody: text("response_body"),
    durationMs: integer("duration_ms"),
    retryCount: integer("retry_count").default(0).notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wal_ent_created").on(t.enterpriseId, t.createdAt),
    check("workspace_api_log_api_type_chk", sql`${t.apiType} IN ('chat', 'image')`),
    check(
      "workspace_api_log_response_status_chk",
      sql`${t.responseStatus} IN ('success', 'failure', 'timeout')`,
    ),
  ],
)

/**
 * 对话任务（异步队列：批量细化/重生成/翻译）
 *
 * taskType: deepen | regenerate | translate
 * status: queued | processing | completed | failed
 */
export const chatTasks = pgTable(
  "chat_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiConfigId: uuid("api_config_id").references(() => chatApiConfigs.id, {
      onDelete: "set null",
    }),
    taskType: varchar("task_type", { length: 20 }).default("deepen").notNull(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => promptCards.id, { onDelete: "cascade" }),
    workspaceTaskId: uuid("workspace_task_id").references(
      () => workspaceTasks.id,
      { onDelete: "cascade" },
    ),
    templateId: uuid("template_id").references(() => promptTemplates.id, {
      onDelete: "set null",
    }),
    originalPrompt: text("original_prompt").notNull(),
    messages: jsonb("messages"), // 兼容字段（异步队列场景可选）
    status: varchar("status", { length: 20 }).default("queued").notNull(),
    resultPrompt: text("result_prompt"),
    response: text("response"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0).notNull(),
    retryErrors: jsonb("retry_errors").$type<string[]>().default([]).notNull(),
    /** 下次可重试时间（指数退避）：为空表示立即可处理；非空表示需等到该时刻后才可被消费 */
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("chat_ent_status").on(t.enterpriseId, t.status),
    index("chat_ent_api").on(t.enterpriseId, t.apiConfigId),
    // 跳过未到点重试任务的高频过滤索引（仅 queued 且有待重试时间的行）
    index("chat_task_next_retry")
      .on(t.nextRetryAt)
      .where(sql`${t.status} = 'queued' AND ${t.nextRetryAt} IS NOT NULL`),
    check(
      "chat_task_status_chk",
      sql`${t.status} IN ('queued', 'processing', 'completed', 'failed')`,
    ),
    check(
      "chat_task_task_type_chk",
      sql`${t.taskType} IN ('deepen', 'regenerate', 'translate')`,
    ),
  ],
)
