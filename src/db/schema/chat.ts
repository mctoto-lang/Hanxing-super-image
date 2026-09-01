import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import { chatApiConfigs } from "./workspace"

/**
 * AI 对话域（/chat 交互式对话，M6）
 *
 * - 与生图 conversation/generation_task 同构的租户隔离：全部表带
 *   enterpriseId + userId 双过滤；
 * - 与 chat_task（工作台异步提示词队列）无关：交互式对话走 SSE 直连，
 *   不进 Redis 队列；
 * - 计费：chat_message.costCenticredits 以「厘」（0.01 积分）为整数单位
 *   记录每条消息账单，余额扣减走 users.chatUnbilledCenticredits 累计器。
 */

/** 思考强度档位（UI 统一四档，适配层按格式映射为各家参数） */
export type ChatThinkingLevel = "off" | "low" | "medium" | "high"

/** 对话会话（左侧历史栏实体） */
export const chatConversations = pgTable(
  "chat_conversation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    modelId: uuid("model_id").references(() => chatApiConfigs.id, {
      onDelete: "set null",
    }), // 会话当前模型（切换模型随会话持久化）
    thinkingLevel: varchar("thinking_level", { length: 10 })
      .default("off")
      .notNull(),
    /** 上下文已用 tokens（每条消息后用 API usage 精确回写，圆环数据源） */
    contextTokens: integer("context_tokens").default(0).notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("cc_ent_user_last").on(t.enterpriseId, t.userId, t.lastMessageAt),
    index("cc_ent_user_pinned").on(t.enterpriseId, t.userId, t.pinnedAt),
  ],
)

/** 对话消息（user / assistant 成对；assistant 流式落库） */
export const chatMessages = pgTable(
  "chat_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 10 }).notNull(), // user | assistant
    content: text("content").default("").notNull(),
    /** 思考过程（reasoning 流，可能为空） */
    thinkingContent: text("thinking_content"),
    modelId: uuid("model_id").references(() => chatApiConfigs.id, {
      onDelete: "set null",
    }),
    thinkingLevel: varchar("thinking_level", { length: 10 }),
    /** streaming = 生成中；stopped = 用户手动停止（按实际用量计费） */
    status: varchar("status", { length: 12 }).default("completed").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** 本条消息账单（单位：厘 = 0.01 积分，整数避免浮点误差） */
    costCenticredits: integer("cost_centicredits").default(0).notNull(),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("cm_conv_created").on(t.conversationId, t.createdAt),
    index("cm_ent_user_created").on(t.enterpriseId, t.userId, t.createdAt),
    check("chat_message_role_chk", sql`${t.role} IN ('user', 'assistant')`),
    check(
      "chat_message_status_chk",
      sql`${t.status} IN ('streaming', 'completed', 'failed', 'stopped')`,
    ),
  ],
)
