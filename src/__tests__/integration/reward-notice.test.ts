import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { and, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  permissionGroups,
  rewardNotices,
  users,
  enterpriseSubscriptions,
  subscriptionPlans,
} from "@/db/schema"
import {
  allocateCreditsToUser,
  rechargeCredits,
} from "@/server/services/credits-service"
import {
  assignEnterprisePlan,
  grantDueSubscription,
  renewEnterprisePlan,
} from "@/server/services/subscription-service"
import {
  ackRewardNotices,
  listPendingRewardNotices,
} from "@/server/services/reward-notice-service"

/**
 * 奖励礼物通知集成测试（迁移 0099）
 *
 * 验证五类事件（套餐开通/续约/周期发放/充值/成员分配）各自写入正确的
 * reward_notice 行，以及待弹查询的可见性（全员 vs 定向）、已读游标、
 * 企业隔离与 30 天窗口。
 */

const RUN = randomUUID().slice(0, 8)

let entAId: string
let entBId: string
let adminId: string // 企业 A 管理员（操作人）
let memberId: string // 企业 A 普通成员（分配目标）
let otherMemberId: string // 企业 A 另一成员（不应看到定向卡）
let entBUserId: string // 企业 B 成员（隔离验证）
let planId: string
let planName: string

/** 读取用户行（listPending 入参形状） */
async function userView(id: string) {
  const [row] = await db
    .select({
      id: users.id,
      enterpriseId: users.enterpriseId,
      createdAt: users.createdAt,
      rewardLastSeenAt: users.rewardLastSeenAt,
    })
    .from(users)
    .where(eq(users.id, id))
  if (!row?.enterpriseId) throw new Error("测试用户缺失")
  return row as {
    id: string
    enterpriseId: string
    createdAt: Date
    rewardLastSeenAt: Date | null
  }
}

async function noticesOf(enterpriseId: string, type?: string) {
  const conds = [eq(rewardNotices.enterpriseId, enterpriseId)]
  if (type) conds.push(eq(rewardNotices.type, type as never))
  return db
    .select()
    .from(rewardNotices)
    .where(and(...conds))
}

beforeAll(async () => {
  // 企业 A（主舞台）：管理员 + 两个成员
  const [entA] = await db
    .insert(enterprises)
    .values({
      name: `礼物通知测试A-${RUN}`,
      slug: `reward-notice-a-${RUN}`,
      creditsBalance: 10_000,
    })
    .returning()
  entAId = entA!.id

  const [group] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entAId, name: "默认组", isDefault: true })
    .returning()

  const mkUser = async (username: string, role: "owner" | "member") => {
    const [u] = await db
      .insert(users)
      .values({
        username,
        passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
        enterpriseId: entAId,
        groupId: group!.id,
        enterpriseRole: role,
      })
      .returning()
    return u!.id
  }
  adminId = await mkUser(`reward_admin_${RUN}`, "owner")
  memberId = await mkUser(`reward_member_${RUN}`, "member")
  otherMemberId = await mkUser(`reward_other_${RUN}`, "member")

  // 企业 B：隔离验证
  const [entB] = await db
    .insert(enterprises)
    .values({
      name: `礼物通知测试B-${RUN}`,
      slug: `reward-notice-b-${RUN}`,
      creditsBalance: 100,
    })
    .returning()
  entBId = entB!.id
  const [uB] = await db
    .insert(users)
    .values({
      username: `reward_entb_${RUN}`,
      passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entBId,
    })
    .returning()
  entBUserId = uB!.id

  // 套餐定义（名称全局唯一，带随机后缀）
  planName = `礼物套餐-${RUN}`
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: planName,
      creditsPerCycle: 500,
      cycleDays: 30,
      iconKey: "crown",
      color: "#f59e0b",
    })
    .returning()
  planId = plan!.id
})

afterAll(async () => {
  for (const entId of [entAId, entBId]) {
    if (!entId) continue
    await db
      .delete(creditTransactions)
      .where(eq(creditTransactions.enterpriseId, entId))
    await db
      .delete(rewardNotices)
      .where(eq(rewardNotices.enterpriseId, entId))
    await db.delete(users).where(eq(users.enterpriseId, entId))
    await db
      .delete(permissionGroups)
      .where(eq(permissionGroups.enterpriseId, entId))
    await db
      .delete(enterpriseSubscriptions)
      .where(eq(enterpriseSubscriptions.enterpriseId, entId))
    await db.delete(enterprises).where(eq(enterprises.id, entId))
  }
  if (planId) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId))
  }
})

describe("充值事件（全员）", () => {
  it("rechargeCredits 写 recharge 通知：全员可见、payload 含金额与操作人", async () => {
    await rechargeCredits({
      enterpriseId: entAId,
      amount: 1234,
      userId: adminId,
      remark: "季度充值",
    })

    const rows = await noticesOf(entAId, "recharge")
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.targetUserId).toBeNull() // 全员
    expect(row.createdBy).toBe(adminId)
    expect(row.payload.amount).toBe(1234)
    expect(row.payload.remark).toBe("季度充值")
    // 操作人显示名：昵称缺省回退用户名
    const [admin] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, adminId))
    expect(row.payload.operatorName).toBe(admin!.username)

    // 企业 A 三个成员都能看到；企业 B 成员看不到
    for (const uid of [adminId, memberId, otherMemberId]) {
      const items = await listPendingRewardNotices(await userView(uid))
      expect(items.some((n) => n.id === row.id)).toBe(true)
    }
    const bItems = await listPendingRewardNotices(await userView(entBUserId))
    expect(bItems.some((n) => n.id === row.id)).toBe(false)
  })
})

describe("成员分配事件（定向）", () => {
  it("allocateCreditsToUser 写 member_allocation 通知：仅被分配成员可见", async () => {
    await allocateCreditsToUser({
      enterpriseId: entAId,
      operatorUserId: adminId,
      targetUserId: memberId,
      amount: 300,
      remark: "项目激励",
    })

    const rows = await noticesOf(entAId, "member_allocation")
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.targetUserId).toBe(memberId)
    expect(row.payload.amount).toBe(300)
    expect(row.payload.operatorName).toBeTruthy()

    const targetItems = await listPendingRewardNotices(await userView(memberId))
    expect(targetItems.some((n) => n.id === row.id)).toBe(true)

    // 其他成员与企业管理员都不弹这张卡
    for (const uid of [adminId, otherMemberId]) {
      const items = await listPendingRewardNotices(await userView(uid))
      expect(items.some((n) => n.id === row.id)).toBe(false)
    }
  })
})

describe("套餐事件（全员）", () => {
  it("assignEnterprisePlan 写 plan_assigned（含首期积分）且不重复写 plan_grant", async () => {
    await assignEnterprisePlan({
      enterpriseId: entAId,
      planId,
      expiresAt: new Date(Date.now() + 30 * 864e5),
      operatorId: adminId,
    })

    const assigned = await noticesOf(entAId, "plan_assigned")
    expect(assigned).toHaveLength(1)
    expect(assigned[0]!.targetUserId).toBeNull()
    expect(assigned[0]!.payload.planName).toBe(planName)
    expect(assigned[0]!.payload.planIconKey).toBe("crown")
    expect(assigned[0]!.payload.planColor).toBe("#f59e0b")
    expect(assigned[0]!.payload.credits).toBe(500) // 首期已随分配发放
    expect(assigned[0]!.payload.expiresAt).toBeTruthy()

    // 首期积分不另弹 plan_grant 卡（避免同笔积分弹两张）
    const grants = await noticesOf(entAId, "plan_grant")
    expect(grants).toHaveLength(0)
  })

  it("renewEnterprisePlan 连续续约写 plan_renewed（无积分重复发放）", async () => {
    const [sub] = await db
      .select({ expiresAt: enterpriseSubscriptions.expiresAt })
      .from(enterpriseSubscriptions)
      .where(eq(enterpriseSubscriptions.enterpriseId, entAId))
    await renewEnterprisePlan({
      enterpriseId: entAId,
      expiresAt: new Date(sub!.expiresAt.getTime() + 30 * 864e5),
      operatorId: adminId,
    })

    const renewed = await noticesOf(entAId, "plan_renewed")
    expect(renewed).toHaveLength(1)
    expect(renewed[0]!.payload.planName).toBe(planName)
    expect(renewed[0]!.payload.credits).toBe(0) // 连续续约无新周期到期
    expect(renewed[0]!.payload.restarted).toBe(false)
  })

  it("worker 周期发放（notice: true）写 plan_grant；assign 路径不写", async () => {
    // 直接把发放进度回拨一个周期，制造「到期未发」再走 worker 通路
    await db
      .update(enterpriseSubscriptions)
      .set({
        startsAt: new Date(Date.now() - 65 * 864e5),
        expiresAt: new Date(Date.now() + 25 * 864e5),
        lastGrantPeriodEnd: new Date(Date.now() - 35 * 864e5),
      })
      .where(eq(enterpriseSubscriptions.enterpriseId, entAId))

    const results = await grantDueSubscription(entAId, new Date(), {
      notice: true,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.creditsGranted === 500)).toBe(true)

    const grants = await noticesOf(entAId, "plan_grant")
    expect(grants).toHaveLength(results.length)
    for (const g of grants) {
      expect(g.targetUserId).toBeNull()
      expect(g.payload.planName).toBe(planName)
      expect(g.payload.credits).toBe(500)
    }
  })
})

describe("已读游标与窗口", () => {
  it("ack 推进游标后待弹清空；游标只进不退", async () => {
    const member = await userView(memberId)
    // member 可见的全部事件（全员 + 定向给 member），按时间升序
    const visible = (await noticesOf(entAId))
      .filter((n) => !n.targetUserId || n.targetUserId === memberId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    expect(visible.length).toBeGreaterThanOrEqual(5) // 覆盖 LIMIT 分页场景

    const before = await listPendingRewardNotices(member)
    expect(before).toHaveLength(Math.min(visible.length, 5))

    // ack 最旧的一张（首张弹出的卡）：其余更晚的仍可见（LIMIT 顶上来）
    await ackRewardNotices(memberId, visible[0]!.id)
    const afterFirst = await listPendingRewardNotices(await userView(memberId))
    expect(afterFirst).toHaveLength(Math.min(visible.length - 1, 5))

    // 再 ack 最新的一张：全部清空（µs 精度游标，同毫秒事件不漏）
    await ackRewardNotices(memberId, visible[visible.length - 1]!.id)
    expect(
      await listPendingRewardNotices(await userView(memberId)),
    ).toHaveLength(0)

    // 回头 ack 旧的：游标不回退，仍为空
    await ackRewardNotices(memberId, visible[0]!.id)
    expect(
      await listPendingRewardNotices(await userView(memberId)),
    ).toHaveLength(0)
  })

  it("超过 30 天窗口的陈年事件不再弹出（窗口内仍弹）", async () => {
    // otherMember 从未 ack（游标 null）；把其入企时间回拨到 50 天前，
    // 使「游标/入企时间」均不拦截，唯一过滤因素 = 30 天窗口
    await db
      .update(users)
      .set({ createdAt: new Date(Date.now() - 50 * 864e5) })
      .where(eq(users.id, otherMemberId))

    await db.insert(rewardNotices).values([
      {
        enterpriseId: entAId,
        type: "recharge",
        targetUserId: otherMemberId,
        payload: { amount: 1 },
        createdBy: adminId,
        createdAt: new Date(Date.now() - 40 * 864e5), // 超窗
      },
      {
        enterpriseId: entAId,
        type: "recharge",
        targetUserId: otherMemberId,
        payload: { amount: 2 },
        createdBy: adminId,
        createdAt: new Date(Date.now() - 5 * 864e5), // 窗口内
      },
    ])

    const items = await listPendingRewardNotices(await userView(otherMemberId))
    // 窗口内的定向卡可见；40 天前的被窗口滤掉
    expect(items.some((n) => n.payload.amount === 2)).toBe(true)
    expect(items.some((n) => n.payload.amount === 1)).toBe(false)
  })
})
