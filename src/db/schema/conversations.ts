import { relations } from "drizzle-orm"
import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import { generationTasks } from "./tasks"

/**
 * 创作会话（自由创作页 §6 重新设计）
 *
 * 多次生图（generation_task）归类到一个会话容器下，
 * 类似 ChatGPT 左侧会话列表。全表 enterpriseId 租户隔离。
 */
export const conversations = pgTable(
  "conversation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 会话标题（默认取首个任务提示词截断，可双击改名） */
    title: text("title").notNull(),
    /** 冗余缓存：最近一张生成图 URL，供列表缩略图，避免 join */
    lastImageThumb: text("last_image_thumb"),
    /** 置顶时间（null = 未置顶），列表置顶排前 */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** 软删除时间（null = 未删）：用户删会话只隐藏，管理端看板/生图日志/积分流水仍可见 */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("conv_ent_user_updated").on(t.enterpriseId, t.userId, t.updatedAt),
  ],
)

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    enterprise: one(enterprises, {
      fields: [conversations.enterpriseId],
      references: [enterprises.id],
    }),
    user: one(users, {
      fields: [conversations.userId],
      references: [users.id],
    }),
    tasks: many(generationTasks),
  }),
)
