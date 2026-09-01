import {
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
import { users } from "./auth"

/**
 * 样机渲染（对接外部 psd-render-api 渲染服务）
 *
 * 概念映射：
 * - 小模板 = 外部服务里的一个 PSD 模板版本（templateVersionId，tpv_ 前缀），
 *   含绑定定义（智能对象/文字图层 → bindingId）。上传与绑定编辑直连外部 API。
 * - 大模板 = 网页侧的套组分组（一个套组引用多个小模板），模板管理里维护。
 * - 卡片   = 个人工作区的渲染实例：基于某大模板建卡，卡片保存每个小模板的
 *   绑定配置（图片/文字），渲染时逐小模板建 generationTasks（taskType/source
 *   = "mockup"，modelId 为空），外部 jobId 等上下文走 templateInfo。
 *
 * 外部服务地址/密钥/单价按企业在 system_setting(key="mockup", enterpriseId)
 * 配置（超管平台），各企业对接各自渲染实例，模板目录天然隔离。
 */

/** 外部绑定定义快照（加入套组时从外部服务抄录，渲染与弹窗展示用） */
export interface MockupBindingDef {
  bindingId: string
  /** smartObject/pixel=图片替换 / text=文字替换 */
  type: "smartObject" | "text" | "pixel"
  layerId: number
  layerPath: string
  label: string
  required: boolean
  fit: "cover" | "contain" | "stretch"
}

/** 卡片级单绑定配置：图片绑定存本项目存储 URL；文字绑定存文本 */
export interface MockupBindingSetting {
  imageUrl?: string
  text?: string
}

/** mockup_cards.bindingConfig：{ [groupItemId]: { [bindingId]: setting } } */
export type MockupBindingConfig = Record<
  string,
  Record<string, MockupBindingSetting>
>

/** 大模板（套组） */
export const mockupGroups = pgTable(
  "mockup_group",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("mg_ent_sort").on(t.enterpriseId, t.sortOrder)],
)

/** 套组成员（小模板引用，版本钉住在加入时的 templateVersionId） */
export const mockupGroupItems = pgTable(
  "mockup_group_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => mockupGroups.id, { onDelete: "cascade" }),
    /** 外部模板版本（tpv_）与模板（tpl_）标识 */
    templateVersionId: varchar("template_version_id", { length: 64 }).notNull(),
    externalTemplateId: varchar("external_template_id", {
      length: 64,
    }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    canvasWidth: integer("canvas_width"),
    canvasHeight: integer("canvas_height"),
    /** 绑定定义快照（结构见 MockupBindingDef[]） */
    bindings: jsonb("bindings").$type<MockupBindingDef[]>(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("mgi_group_sort").on(t.groupId, t.sortOrder)],
)

/** 渲染卡片（个人工作区，仅本人可见） */
export const mockupCards = pgTable(
  "mockup_card",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => mockupGroups.id, { onDelete: "cascade" }),
    /** 卡片标题（默认取大模板名，可改名） */
    title: varchar("title", { length: 120 }).notNull(),
    /** 各小模板的绑定配置（结构见 MockupBindingConfig） */
    bindingConfig: jsonb("binding_config").$type<MockupBindingConfig>(),
    /** 最近一次整卡渲染的批次号（任务 templateInfo.batchTag 对应） */
    lastBatchTag: varchar("last_batch_tag", { length: 32 }),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("mc_ent_user_sort").on(t.enterpriseId, t.userId, t.sortOrder),
    index("mc_ent_user_updated").on(t.enterpriseId, t.userId, t.updatedAt),
  ],
)

/** 图片库：我的上传（样机替换用设计稿，个人维度） */
export const mockupDesignAssets = pgTable(
  "mockup_design_asset",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    imageUrl: text("image_url").notNull(),
    fileName: varchar("file_name", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("mda_user_image_unique").on(t.userId, t.imageUrl),
    index("mda_user_created").on(t.userId, t.createdAt),
  ],
)

/** 外部素材中转缓存：本项目图片 URL → 外部 assetId（同一图不重复上传） */
export const mockupExternalAssets = pgTable(
  "mockup_external_asset",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    imageUrl: text("image_url").notNull(),
    assetId: varchar("asset_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("mea_ent_image_unique").on(t.enterpriseId, t.imageUrl)],
)
