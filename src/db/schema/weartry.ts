import {
  boolean,
  index,
  integer,
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
 * 穿戴图片（四 tab 产品族：服装组图 / 模特穿戴 / AI万戴 / AI换色）
 *
 * 服装组图的方向卡片复用 product_direction（appliesTo="weartry"），
 * 生图任务沿用 generationTasks（source="weartry"），上下文走 templateInfo。
 * 本文件只放穿戴专属主数据：模特穿戴的预置场景（超管配置，提示词注入）。
 */

/**
 * 预置场景（超管配置）
 *
 * 模特穿戴 tab 的「场景选择」数据源：选定后场景的 promptTemplate
 * 作为注入段拼进生图提示词（纯色棚拍 / 城市街拍 / 咖啡馆 …）。
 */
export const weartryScenes = pgTable(
  "weartry_scene",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 稳定标识（提交校验与 templateInfo.sceneKey 用） */
    key: varchar("key", { length: 60 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    /** 卡片副文案（如「干净背景，突出服装本体」） */
    description: varchar("description", { length: 200 }),
    /** 场景注入提示词模板，支持 {{vars}}，运行时 fillVars 填充 */
    promptTemplate: text("prompt_template").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ws_key_unique").on(t.key),
    index("ws_active_sort").on(t.isActive, t.sortOrder),
  ],
)

/**
 * 模特形象库（用户个人维度）
 *
 * 模特穿戴/AI万戴 的「模特形象-模特库」数据源：
 * AI 生成的模特形象完成后自动入库（source="ai"），自行上传的图片
 * 上传成功即入库（source="upload"），供后续生成直接选用。
 */
export const weartryFigures = pgTable(
  "weartry_figure",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 形象图 URL（AI 任务产物或用户上传，均为持久化存储地址） */
    imageUrl: text("image_url").notNull(),
    /** 来源：ai=生成自动入库 / upload=用户上传 */
    source: varchar("source", { length: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 同一用户同图去重（AI 重复采用/重复上传不产生重复行）
    uniqueIndex("wf_user_image_unique").on(t.userId, t.imageUrl),
    index("wf_user_created").on(t.userId, t.createdAt),
  ],
)
