import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
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
 * - apiFormat: grs | jimeng（沿用旧项目）。
 * - 可见性合并：旧项目 visible_in_generate + visible_in_canvas → 单一 visibleInCreate（D13）。
 */
export interface ModelExtraConfig {
  // GRS 族
  grsModelFamily?: "gpt" | "gemini"
  replyType?: "json" | "async"
  imageSizeGrs?: "1K" | "2K" | "4K"
  // Jimeng 族
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
  [key: string]: unknown
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
    apiEndpoint: text("api_endpoint").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    apiFormat: apiFormatEnum("api_format").default("grs").notNull(),
    extraConfig: jsonb("extra_config").$type<ModelExtraConfig>(),
    costPerImage: integer("cost_per_image").default(1).notNull(),
    supportedSizes: jsonb("supported_sizes").$type<string[]>(),
    visibleInCreate: boolean("visible_in_create").default(true).notNull(),
    visibleInWorkspace: boolean("visible_in_workspace")
      .default(false)
      .notNull(),
    visibleInProduct: boolean("visible_in_product").default(false).notNull(),
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
    // UNIQUE(name, api_endpoint, enterprise_id) + 按企业列模型
    unique("model_name_endpoint_ent_unique").on(
      t.name,
      t.apiEndpoint,
      t.enterpriseId,
    ),
    index("model_ent").on(t.enterpriseId),
    index("model_active_create").on(t.isActive, t.visibleInCreate),
  ],
)
