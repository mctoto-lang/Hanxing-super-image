import { relations } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { creditTransactions } from "./credits"
import { enterprises } from "./enterprise"

/**
 * 企业订阅套餐域（超管管理，手册 §4.1/§4.2 之上扩展）
 *
 * 三张表：
 *   - subscription_plan：套餐定义（名称/勋章/颜色/周期积分/周期天数/人数上限）；
 *   - enterprise_subscription：企业当前订阅（一企业一条，含到期时间与发放进度）；
 *   - plan_credit_grant：周期发放台账（enterpriseId+periodStart 唯一，幂等防重复发放）。
 *
 * 发放语义：从订阅 startsAt 起，按套餐 cycleDays 滚动周期，每期开始把
 * creditsPerCycle 发放到企业积分池（credit_transaction type=plan_grant）。
 * 分配套餐时立即发放首期；到期（expiresAt）后停止发放。
 */

/** 订阅套餐（超管 CRUD，勋章 = 预设图标 key + 自定义颜色） */
export const subscriptionPlans = pgTable("subscription_plan", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  /** 勋章图标（src/lib/plans/badge.ts 白名单内的 lucide 图标 key） */
  iconKey: varchar("icon_key", { length: 50 }).notNull().default("medal"),
  /** 勋章颜色（#RRGGBB） */
  color: varchar("color", { length: 7 }).notNull().default("#8b5cf6"),
  /** 每周期发放到企业池的积分额度 */
  creditsPerCycle: integer("credits_per_cycle").notNull(),
  /** 周期长度（天，从分配日起滚动） */
  cycleDays: integer("cycle_days").notNull().default(30),
  /** 人数上限（null = 不限，用于权益展示） */
  maxMembers: integer("max_members"),
  sortOrder: integer("sort_order").notNull().default(0),
  /** 停用后不可新分配，存量订阅履约至到期 */
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
})

/** 企业当前订阅（enterpriseId 唯一 = 一企业仅一条生效订阅，重分配即覆盖） */
export const enterpriseSubscriptions = pgTable(
  "enterprise_subscription",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" })
      .unique(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: "restrict" }),
    /** 订阅开始（分配）时刻，也是周期滚动的锚点 */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** 到期时刻，此后停止发放 */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** 最近一次已发放周期的结束时刻（null = 首期尚未发放） */
    lastGrantPeriodEnd: timestamp("last_grant_period_end", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("es_plan").on(t.planId)],
)

/** 周期发放台账（幂等：同企业同周期起点只发一次） */
export const planCreditGrants = pgTable(
  "plan_credit_grant",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    /** 本期结束（未满整周期时为 expiresAt） */
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    creditsGranted: integer("credits_granted").notNull(),
    /** 对应的 credit_transaction 流水 id（审计关联） */
    transactionId: uuid("transaction_id").references(() => creditTransactions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pcg_ent_period").on(t.enterpriseId, t.periodStart),
    index("pcg_ent_created").on(t.enterpriseId, t.createdAt),
  ],
)

export const enterpriseSubscriptionsRelations = relations(
  enterpriseSubscriptions,
  ({ one }) => ({
    enterprise: one(enterprises, {
      fields: [enterpriseSubscriptions.enterpriseId],
      references: [enterprises.id],
    }),
    plan: one(subscriptionPlans, {
      fields: [enterpriseSubscriptions.planId],
      references: [subscriptionPlans.id],
    }),
  }),
)

export const planCreditGrantsRelations = relations(planCreditGrants, ({ one }) => ({
  enterprise: one(enterprises, {
    fields: [planCreditGrants.enterpriseId],
    references: [enterprises.id],
  }),
  plan: one(subscriptionPlans, {
    fields: [planCreditGrants.planId],
    references: [subscriptionPlans.id],
  }),
}))
