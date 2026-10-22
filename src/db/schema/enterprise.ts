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
import {
  type ModuleName,
  enterpriseStatusEnum,
} from "./_shared"

/**
 * 企业（租户）—— 多租户顶层实体（手册 §4.1、D7/D8/D22）
 *
 * - 平台超管创建；
 * - 独立积分池（creditsBalance，企业全员共享，D8）；
 * - 模块开关（enabledModules，超管配置，D22）；
 * - 企业级并发上限（maxConcurrent）；
 * - allowCustomModels：是否允许企业自建私有模型（超管开关）；
 * - visiblePresetModels：该企业可见的平台预置模型 id 白名单（空 = 全部预置可见）；
 * - visiblePresetChatModels：同上，作用于对话模型（chat_api_config 平台预置）。
 */
export const enterprises = pgTable("enterprise", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  logoUrl: text("logo_url"),
  status: enterpriseStatusEnum("status").default("active").notNull(),
  creditsBalance: integer("credits_balance").default(0).notNull(),
  enabledModules: jsonb("enabled_modules")
    .$type<ModuleName[]>()
    .default(["create", "chat", "assets", "mockup", "settings"])
    .notNull(),
  /** 生图企业级并发上限（Redis 槽位跨副本强制，图片级计数；≤0 = 不限） */
  maxConcurrent: integer("max_concurrent").default(5).notNull(),
  /** 对话企业级并发上限（/chat 流式在途流数，Redis 计数跨副本强制；≤0 = 不限） */
  chatMaxConcurrent: integer("chat_max_concurrent").default(5).notNull(),
  allowCustomModels: boolean("allow_custom_models")
    .default(true)
    .notNull(), // 超管开关：是否允许企业自建私有模型
  visiblePresetModels: jsonb("visible_preset_models")
    .$type<string[]>()
    .default([])
    .notNull(), // 平台预置模型 id 白名单（空 = 全部预置可见）
  visiblePresetChatModels: jsonb("visible_preset_chat_models")
    .$type<string[]>()
    .default([])
    .notNull(), // 平台预置对话模型 id 白名单（空 = 全部预置可见）
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})

/**
 * 权限组（手册 §4.1、D21）
 *
 * 绑定企业（enterpriseId 非空）；每企业可有多个组；
 * 组决定 allowedModels / allowedChatModels / allowedPages / maxConcurrent / priority。
 * 每企业至多一个 isDefault=true 的默认组（新建用户默认分配）。
 */
export const permissionGroups = pgTable(
  "permission_group",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    allowedModels: jsonb("allowed_models")
      .$type<string[]>()
      .default([])
      .notNull(), // 生图模型 id 白名单（空 = 企业全部已开通模型）
    allowedChatModels: jsonb("allowed_chat_models")
      .$type<string[]>()
      .default([])
      .notNull(), // 对话模型 id 白名单（空 = 企业全部已开通对话模型）
    allowedPages: jsonb("allowed_pages")
      .$type<ModuleName[]>()
      .default([])
      .notNull(), // 页面白名单（在企业 enabledModules 范围内）
    maxConcurrent: integer("max_concurrent").default(2).notNull(),
    priority: integer("priority").default(0).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 每企业至多一个默认组（部分唯一索引）
    uniqueIndex("one_default_per_enterprise")
      .on(t.enterpriseId)
      .where(sql`is_default = true`),
    // §4.5 索引：按企业列组
    index("pg_ent").on(t.enterpriseId),
  ],
)

