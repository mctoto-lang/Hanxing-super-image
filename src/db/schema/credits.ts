import { relations } from "drizzle-orm"
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { creditTxTypeEnum } from "./_shared"
import { enterprises } from "./enterprise"
import { users } from "./auth"

/**
 * 积分流水（手册 §4.2）
 *
 * 余额不单独建表，直接在 enterprises.creditsBalance。
 * 所有积分变动（充值/消费/退款/调整）都落此审计表，写 balanceAfter 快照。
 *
 * 扣减必须用 PG 事务 + SELECT ... FOR UPDATE 行锁（见 credits-service.ts）。
 */
export const creditTransactions = pgTable(
  "credit_transaction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }), // 触发者（充值时为管理员）
    type: creditTxTypeEnum("type").notNull(),
    amount: integer("amount").notNull(), // 正=充值/退款, 负=扣减
    balanceAfter: integer("balance_after").notNull(), // 变动后余额快照
    taskId: uuid("task_id"), // 关联任务（消费/退款时），无外键约束避免循环依赖
    remark: text("remark"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // §4.5 索引：按企业 + 时间倒序查流水
    index("ct_ent_created").on(t.enterpriseId, t.createdAt),
  ],
)

export const creditTransactionsRelations = relations(
  creditTransactions,
  ({ one }) => ({
    enterprise: one(enterprises, {
      fields: [creditTransactions.enterpriseId],
      references: [enterprises.id],
    }),
    user: one(users, {
      fields: [creditTransactions.userId],
      references: [users.id],
    }),
  }),
)
