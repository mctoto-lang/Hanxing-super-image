import {
  boolean,
  index,
  text,
  timestamp,
  uuid,
  varchar,
  pgTable,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"
import { users } from "./auth"

/**
 * 登录审计日志（手册 §10.7）
 *
 * 记录所有登录尝试（成功/失败），用于安全审计与限流取证。
 * 失败登录 userId 可空（用户名不存在时）。
 */
export const loginLogs = pgTable(
  "login_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }), // 失败登录且用户名不存在时为 NULL
    username: varchar("username", { length: 50 }), // 尝试登录的用户名（审计）
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "set null",
    }),
    ip: varchar("ip", { length: 64 }).notNull(),
    userAgent: text("user_agent"),
    success: boolean("success").notNull(),
    failureReason: varchar("failure_reason", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 按 IP + 时间查限流计数；按企业查审计
    index("ll_ip_created").on(t.ip, t.createdAt),
    index("ll_ent_created").on(t.enterpriseId, t.createdAt),
    index("ll_user").on(t.userId),
  ],
)
