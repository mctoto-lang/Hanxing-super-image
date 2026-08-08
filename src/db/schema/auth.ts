import { relations } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterpriseRoleEnum, userStatusEnum } from "./_shared"
import { enterprises, permissionGroups } from "./enterprise"

/**
 * 用户 —— 单一归属企业（手册 §4.1、D18/D19）
 *
 * 一个用户名只属一家企业，不可跨企业（去掉 memberships 多对多表）。
 * 用户名（username）全局唯一 = 登录账号；昵称（name）可重复。
 * 超管 isSuperAdmin=true 且 enterpriseId 为 NULL。
 */
export const users = pgTable(
  "user",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    username: varchar("username", { length: 50 }).notNull().unique(),
    email: varchar("email", { length: 255 }),
    name: varchar("name", { length: 100 }),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    image: text("image"),
    isSuperAdmin: boolean("is_super_admin").default(false).notNull(),
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "set null",
    }),
    enterpriseRole: enterpriseRoleEnum("enterprise_role")
      .default("member")
      .notNull(),
    groupId: uuid("group_id").references(() => permissionGroups.id, {
      onDelete: "set null",
    }),
    status: userStatusEnum("status").default("active").notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Auth.js 兼容字段（保留以便未来扩展 OAuth）
    emailVerified: timestamp("email_verified", { withTimezone: true }),
  },
  (t) => [
    // §4.5 索引：按企业列用户、超管筛选
    index("user_ent").on(t.enterpriseId),
    index("user_super").on(t.isSuperAdmin),
  ],
)

/* Auth.js 标准表（DrizzleAdapter 期望的命名与字段，手册 §5.3） */

export const accounts = pgTable(
  "account",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 255 }).notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 255,
    }).notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: varchar("token_type", { length: 255 }),
    scope: varchar("scope", { length: 255 }),
    id_token: text("id_token"),
    session_state: varchar("session_state", { length: 255 }),
  },
  (t) => [
    unique("account_provider_unique").on(t.provider, t.providerAccountId),
  ],
)

export const sessions = pgTable("session", {
  // sessionToken 作为主键（符合 DrizzleAdapter 期望）
  sessionToken: varchar("session_token", { length: 255 }).notNull().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
})

export const verificationTokens = pgTable(
  "verificationtoken",
  {
    identifier: varchar("identifier", { length: 255 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

// 关系定义
export const usersRelations = relations(users, ({ one, many }) => ({
  enterprise: one(enterprises, {
    fields: [users.enterpriseId],
    references: [enterprises.id],
  }),
  group: one(permissionGroups, {
    fields: [users.groupId],
    references: [permissionGroups.id],
  }),
  accounts: many(accounts),
  sessions: many(sessions),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}))
