import { relations } from "drizzle-orm"
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
  taskSourceEnum,
  taskStatusEnum,
  taskTypeEnum,
} from "./_shared"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import { models } from "./models"

/**
 * 生图任务（手册 §4.3）
 *
 * 全表 enterpriseId 租户隔离；source 统一为 create/workspace/product（D13）；
 * creditsCharged 统一积分（无 creative/project 区分）。
 */
export const generationTasks = pgTable(
  "generation_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "restrict" }),
    prompt: text("prompt").notNull(),
    imageSize: varchar("image_size", { length: 30 }),
    imageCount: integer("image_count").default(1).notNull(),
    status: taskStatusEnum("status").default("queued").notNull(),
    taskType: taskTypeEnum("task_type").default("normal").notNull(),
    source: taskSourceEnum("source").default("create").notNull(),
    priority: integer("priority").default(0).notNull(),
    creditsCharged: integer("credits_charged").default(0).notNull(),
    resultImages: jsonb("result_images").$type<string[]>(),
    referenceImages: jsonb("reference_images").$type<string[]>(),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0).notNull(),
    retryErrors: jsonb("retry_errors").$type<string[]>(),
    templateInfo: jsonb("template_info"),
    taskUuid: varchar("task_uuid", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    // §4.5 索引：按企业+状态查队列、按企业+用户查历史、taskUuid 唯一
    index("gt_ent_status").on(t.enterpriseId, t.status),
    index("gt_ent_user_created").on(t.enterpriseId, t.userId, t.createdAt),
    uniqueIndex("gt_uuid").on(t.taskUuid),
  ],
)

/** API 调用日志（沿用旧项目，+ enterpriseId） */
export const apiCallLogs = pgTable(
  "api_call_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => generationTasks.id, {
      onDelete: "cascade",
    }),
    modelId: uuid("model_id"),
    requestSummary: text("request_summary"),
    responseSummary: text("response_summary"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("acl_ent_created").on(t.enterpriseId, t.createdAt)],
)

/** 任务收藏（沿用旧项目，+ enterpriseId） */
export const pinnedTasks = pgTable(
  "pinned_task",
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
      .references(() => generationTasks.id, { onDelete: "cascade" }),
    source: taskSourceEnum("source").default("create").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pt_ent_user_task").on(t.enterpriseId, t.userId, t.taskId),
    index("pt_ent_user").on(t.enterpriseId, t.userId),
  ],
)

export const generationTasksRelations = relations(
  generationTasks,
  ({ one }) => ({
    enterprise: one(enterprises, {
      fields: [generationTasks.enterpriseId],
      references: [enterprises.id],
    }),
    user: one(users, {
      fields: [generationTasks.userId],
      references: [users.id],
    }),
    model: one(models, {
      fields: [generationTasks.modelId],
      references: [models.id],
    }),
  }),
)

// 预留 boolean/text 引用避免 tree-shake 误删（pinnedTasks.note 用了 text）
void boolean
