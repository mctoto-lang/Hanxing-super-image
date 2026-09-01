import { sql } from "drizzle-orm"
import {
  boolean,
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
import { apiFormatEnum } from "./_shared"
import { enterprises } from "./enterprise"

/**
 * AI 模型（手册 §4.3）
 *
 * - enterpriseId NULL = 平台级共享模型（所有企业可见）；
 *   非 NULL = 企业私有模型。
 * - apiFormat: openai | jimeng（openai = OpenAI 标准生图格式）。
 * - 可见性合并：旧项目 visible_in_generate + visible_in_canvas → 单一 visibleInCreate（D13）。
 */
export interface ModelExtraConfig {
  // Jimeng 族
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
  [key: string]: unknown
}

/**
 * 模型尺寸预设（结构化，替代旧 supportedSizes 字符串数组）
 *
 * 每条 = 一个可选比例：label 为展示文案（如 "1:1"、"智能"），
 * width/height 为对应的实际像素尺寸。比例图标的宽高比由 width/height 推导。
 *
 * enabled：后台可逐个开启/关闭某个比例。false 时创作页置灰不可选，
 * 且不会进入提交尺寸白名单。缺省视为 true（兼容旧数据）。
 */
export interface ModelSizePreset {
  label: string
  width: number
  height: number
  enabled?: boolean
}

export const models = pgTable(
  "model",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "cascade",
    }), // NULL = 平台预置模型
    name: varchar("name", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    /** 模型描述：展示在自由创作模型卡片名称下方，可空 */
    description: text("description"),
    /** 名称后勋章文字（如 "NEW"），可空 */
    badgeText: varchar("badge_text", { length: 30 }),
    /** 勋章配色 key（见 src/lib/model-badges.ts 色板），可空 */
    badgeColor: varchar("badge_color", { length: 30 }),
    apiEndpoint: text("api_endpoint").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    apiFormat: apiFormatEnum("api_format").default("openai").notNull(),
    extraConfig: jsonb("extra_config").$type<ModelExtraConfig>(),
    costPerImage: integer("cost_per_image").default(1).notNull(),
    /** 结构化尺寸预设（替代 supportedSizes） */
    sizePresets: jsonb("size_presets").$type<ModelSizePreset[]>(),
    /** 创作页是否显示 1-4 生成数量选择 */
    supportsImageCount: boolean("supports_image_count")
      .default(false)
      .notNull(),
    /** 是否支持「智能」比例（选择后 size 传 auto，由模型决定尺寸） */
    supportsSmartSize: boolean("supports_smart_size")
      .default(false)
      .notNull(),
    visibleInCreate: boolean("visible_in_create").default(true).notNull(),
    visibleInWorkspace: boolean("visible_in_workspace")
      .default(false)
      .notNull(),
    visibleInProduct: boolean("visible_in_product").default(false).notNull(),
    visibleInWeartry: boolean("visible_in_weartry")
      .default(false)
      .notNull(),
    supportsReferenceImage: boolean("supports_reference_image")
      .default(false)
      .notNull(),
    maxReferenceImages: integer("max_reference_images").default(0).notNull(),
    referenceImageField: varchar("reference_image_field", {
      length: 50,
    }).default("images"),
    maxConcurrent: integer("max_concurrent").default(2).notNull(),
    maxRetries: integer("max_retries").default(2).notNull(),
    apiTimeout: integer("api_timeout").default(120).notNull(),
    taskTimeout: integer("task_timeout").default(300).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    iconUrl: text("icon_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 按企业列模型
    index("model_ent").on(t.enterpriseId),
    index("model_active_create").on(t.isActive, t.visibleInCreate),
    // 唯一约束：含可空 enterprise_id 时 Postgres NULL≠NULL 会导致平台级（NULL）模型
    // 唯一性失效，故拆为两个 partial unique index 分别覆盖：
    // 企业私有模型——同企业内 (name, api_endpoint) 唯一
    uniqueIndex("model_name_endpoint_ent_unique")
      .on(t.name, t.apiEndpoint, t.enterpriseId)
      .where(sql`${t.enterpriseId} IS NOT NULL`),
    // 平台级模型（enterprise_id IS NULL）——(name, api_endpoint) 全局唯一
    uniqueIndex("model_name_endpoint_platform_unique")
      .on(t.name, t.apiEndpoint)
      .where(sql`${t.enterpriseId} IS NULL`),
  ],
)
