import { and, asc, eq, isNull, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { rewardNotices, users } from "@/db/schema"
import type {
  RewardNoticeDto,
  RewardNoticeType,
  RewardPayload,
} from "@/lib/rewards/types"

/**
 * 奖励礼物通知服务（手册计费红线之外的最佳努力通知层）
 *
 * 事件写入永远在业务事务提交成功之后进行，且绝不抛错——
 * 积分/套餐已到账，弹窗写失败只损失一次仪式感，绝不能反噬计费链路。
 *
 * 已读模型：user.reward_last_seen_at 单游标（收下/关闭卡片时推进到
 * 所展示事件的 created_at），不建已读明细表；事件保留 30 天窗口。
 */

/** 待弹事件最多返回条数（多张排队逐张弹出，超出部分下次轮询继续） */
const MAX_PENDING = 5

/**
 * 写入一条奖励事件（best-effort，绝不抛错）。
 *
 * operatorName 在此解析（昵称缺省回退用户名），调用方只需传 operatorId；
 * 套餐名/积分等展示字段由调用方在 payload 里备好。
 */
export async function createRewardNotice(input: {
  enterpriseId: string
  type: RewardNoticeType
  /** NULL/缺省 = 企业全员 */
  targetUserId?: string | null
  /** 触发操作的 user id（解析显示名用） */
  operatorId?: string | null
  payload: RewardPayload
}): Promise<void> {
  const { enterpriseId, type, targetUserId, operatorId, payload } = input
  try {
    let operatorName = payload.operatorName ?? null
    if (!operatorName && operatorId) {
      const [u] = await db
        .select({ name: users.name, username: users.username })
        .from(users)
        .where(eq(users.id, operatorId))
      operatorName = u?.name || u?.username || null
    }

    await db.insert(rewardNotices).values({
      enterpriseId,
      targetUserId: targetUserId ?? null,
      type,
      payload: operatorName ? { ...payload, operatorName } : payload,
      createdBy: operatorId ?? null,
    })
  } catch (err) {
    console.error(`[reward-notice] 写入失败（type=${type}）:`, err)
  }
}

/**
 * 查询用户的待弹事件（升序，先发生先弹）。
 *
 * 可见性：本企业 + （全员事件 或 定向给我的）；
 * 游标：created_at > greatest(reward_last_seen_at, 入企业时刻)；
 * 窗口：仅 30 天内的事件。
 *
 * 注意：游标比较必须在 SQL 内完成——reward_last_seen_at 是微秒精度
 * timestamptz，绕道 JS Date（毫秒截断）会把同毫秒的已读事件又判回未读。
 */
export async function listPendingRewardNotices(user: {
  id: string
  enterpriseId: string
}): Promise<RewardNoticeDto[]> {
  const rows = await db
    .select({
      id: rewardNotices.id,
      type: rewardNotices.type,
      payload: rewardNotices.payload,
      createdAt: rewardNotices.createdAt,
    })
    .from(rewardNotices)
    .innerJoin(users, eq(users.id, user.id))
    .where(
      and(
        eq(rewardNotices.enterpriseId, user.enterpriseId),
        or(
          isNull(rewardNotices.targetUserId),
          eq(rewardNotices.targetUserId, user.id),
        ),
        sql`${rewardNotices.createdAt} > greatest(
              coalesce(${users.rewardLastSeenAt}, '-infinity'::timestamptz),
              ${users.createdAt},
              now() - interval '30 days'
            )`,
      ),
    )
    .orderBy(asc(rewardNotices.createdAt))
    .limit(MAX_PENDING)

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    payload: r.payload ?? {},
    createdAt: r.createdAt.toISOString(),
  }))
}

/**
 * 推进已读游标（收下/关闭卡片时调用，按通知 id 定位）。
 *
 * 游标取该通知的原始 created_at（timestamptz 微秒精度）在 SQL 内比较推进——
 * 不能绕道 JS Date（毫秒截断会漏过同毫秒的相邻事件）；只进不退（greatest）。
 * 子查询按企业归属关联，跨企业的通知 id 推不动自己的游标。
 */
export async function ackRewardNotices(
  userId: string,
  noticeId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE "user" u
    SET reward_last_seen_at = greatest(
          coalesce(u.reward_last_seen_at, '-infinity'::timestamptz),
          (SELECT rn.created_at
             FROM reward_notice rn
            WHERE rn.id = ${noticeId}::uuid
              AND rn.enterprise_id = u.enterprise_id)
        ),
        updated_at = now()
    WHERE u.id = ${userId}::uuid
  `)
}
