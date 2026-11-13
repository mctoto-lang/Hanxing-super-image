import { relations, sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import type { RewardNoticeType, RewardPayload } from "@/lib/rewards/types"

/**
 * 奖励礼物通知域（迁移 0099）
 *
 * 套餐开通/续约/周期发放、超管充值、管理员分配积分成功后各写一条事件；
 * 客户端按 user.reward_last_seen_at 游标轮询未读事件弹「滑动开礼物」卡。
 *
 *   - target_user_id 为空 = 企业全员可见；member_allocation 时 = 被分配成员；
 *   - payload 为展示就绪字段（写入时解析好操作人/套餐名等，弹卡端零 join）；
 *   - 已读游标在 user 表（reward_last_seen_at），不建已读明细表。
 */
export const rewardNotices = pgTable(
  "reward_notice",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    /** NULL = 企业全员；member_allocation 时 = 被分配成员 */
    targetUserId: uuid("target_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    type: varchar("type", { length: 32 })
      .$type<RewardNoticeType>()
      .notNull(),
    payload: jsonb("payload").$type<RewardPayload>().notNull().default({}),
    /** 触发操作的 user id（展示名写入 payload.operatorName） */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("gt_reward_notice_ent_created").on(t.enterpriseId, t.createdAt),
    index("gt_reward_notice_target")
      .on(t.targetUserId)
      .where(sql`target_user_id IS NOT NULL`),
  ],
)

export const rewardNoticesRelations = relations(rewardNotices, ({ one }) => ({
  enterprise: one(enterprises, {
    fields: [rewardNotices.enterpriseId],
    references: [enterprises.id],
  }),
  targetUser: one(users, {
    fields: [rewardNotices.targetUserId],
    references: [users.id],
  }),
}))
