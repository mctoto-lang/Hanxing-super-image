import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterpriseSubscriptions,
  enterprises,
  planCreditGrants,
  subscriptionPlans,
} from "@/db/schema"
import type { PlanBadgeInfo } from "@/lib/plans/badge"
import { computeDuePeriods } from "@/lib/plans/cycle"

/**
 * 企业订阅套餐服务
 *
 * 发放语义（手册计费红线：变动必须 PG 事务 + 行锁 + 流水快照）：
 *   - 每期发放 = 单事务：锁订阅行 → 台账 INSERT ON CONFLICT DO NOTHING（幂等）
 *     → 锁企业行加池余额 → 写 plan_grant 流水 → 推进 lastGrantPeriodEnd；
 *   - worker 停机跨期由 computeDuePeriods 逐期补发，台账唯一索引兜底防重；
 *   - 企业停用（suspended）期间跳过发放，恢复后按锚点补发。
 */

/** 单期发放结果（creditsGranted=0 表示该期已被其它进程发放，仅推进进度） */
export interface GrantResult {
  periodStart: Date
  periodEnd: Date
  creditsGranted: number
  balanceAfter: number | null
}

/**
 * 发放订阅的下一个到期周期（单事务）。无到期周期返回 null。
 */
async function grantNextDuePeriod(
  enterpriseId: string,
  now: Date,
): Promise<GrantResult | null> {
  return await db.transaction(async (tx) => {
    // 1. 锁订阅行，串行化同一订阅的并发发放
    const [sub] = await tx
      .select()
      .from(enterpriseSubscriptions)
      .where(eq(enterpriseSubscriptions.enterpriseId, enterpriseId))
      .for("update")
    if (!sub) return null

    const [plan] = await tx
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, sub.planId))
    if (!plan) return null

    // 2. 基于事务内最新状态计算待发周期（取最早一期）
    const due = computeDuePeriods(
      {
        startsAt: sub.startsAt,
        expiresAt: sub.expiresAt,
        lastGrantPeriodEnd: sub.lastGrantPeriodEnd,
        cycleDays: plan.cycleDays,
      },
      now,
    )
    const next = due[0]
    if (!next) return null

    // 3. 台账幂等抢占：冲突说明该期已被发放过，仅推进进度
    const [grantRow] = await tx
      .insert(planCreditGrants)
      .values({
        enterpriseId,
        planId: plan.id,
        periodStart: next.periodStart,
        periodEnd: next.periodEnd,
        creditsGranted: plan.creditsPerCycle,
      })
      .onConflictDoNothing({
        target: [planCreditGrants.enterpriseId, planCreditGrants.periodStart],
      })
      .returning({ id: planCreditGrants.id })

    if (!grantRow) {
      await tx
        .update(enterpriseSubscriptions)
        .set({ lastGrantPeriodEnd: next.periodEnd, updatedAt: now })
        .where(eq(enterpriseSubscriptions.id, sub.id))
      return {
        periodStart: next.periodStart,
        periodEnd: next.periodEnd,
        creditsGranted: 0,
        balanceAfter: null,
      }
    }

    // 4. 锁企业行 → 池余额累加（整期额度，末期不满整周期也按整期发放）
    const [ent] = await tx
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, enterpriseId))
      .for("update")
    if (!ent) throw new Error("企业不存在")

    const [updated] = await tx
      .update(enterprises)
      .set({
        creditsBalance: sql`${enterprises.creditsBalance} + ${plan.creditsPerCycle}`,
        updatedAt: now,
      })
      .where(eq(enterprises.id, enterpriseId))
      .returning({ balance: enterprises.creditsBalance })

    // 5. 写 plan_grant 流水（balanceAfter 快照）并回链台账
    const [txRow] = await tx
      .insert(creditTransactions)
      .values({
        enterpriseId,
        userId: null,
        type: "plan_grant",
        amount: plan.creditsPerCycle,
        balanceAfter: updated!.balance,
        remark: `套餐「${plan.name}」周期发放（${next.periodStart.toISOString().slice(0, 10)} ~ ${next.periodEnd.toISOString().slice(0, 10)}）`,
      })
      .returning({ id: creditTransactions.id })

    await tx
      .update(planCreditGrants)
      .set({ transactionId: txRow.id })
      .where(eq(planCreditGrants.id, grantRow.id))

    // 6. 推进发放进度
    await tx
      .update(enterpriseSubscriptions)
      .set({ lastGrantPeriodEnd: next.periodEnd, updatedAt: now })
      .where(eq(enterpriseSubscriptions.id, sub.id))

    return {
      periodStart: next.periodStart,
      periodEnd: next.periodEnd,
      creditsGranted: plan.creditsPerCycle,
      balanceAfter: updated!.balance,
    }
  })
}

/** 发放某企业订阅的全部到期周期（逐期独立事务，锁粒度小） */
export async function grantDueSubscription(
  enterpriseId: string,
  now: Date = new Date(),
): Promise<GrantResult[]> {
  const results: GrantResult[] = []
  // computeDuePeriods 已按 expiresAt 封顶，循环必然终止（cycleDays > 0）
  for (;;) {
    const granted = await grantNextDuePeriod(enterpriseId, now)
    if (!granted) break
    results.push(granted)
  }
  return results
}

/**
 * worker 入口：扫描所有应发放的订阅并逐个发放。
 *
 * 候选 = 正常企业 + 发放进度落后于到期时间（首期未发或还有未覆盖周期）；
 * 是否真到期由 grantNextDuePeriod 内的 computeDuePeriods 判定（periodStart <= now）。
 */
export async function grantAllDueSubscriptions(
  now: Date = new Date(),
): Promise<Array<{ enterpriseId: string; results: GrantResult[] }>> {
  const rows = await db
    .select({ enterpriseId: enterpriseSubscriptions.enterpriseId })
    .from(enterpriseSubscriptions)
    .innerJoin(enterprises, eq(enterprises.id, enterpriseSubscriptions.enterpriseId))
    .where(
      and(
        eq(enterprises.status, "active"),
        or(
          isNull(enterpriseSubscriptions.lastGrantPeriodEnd),
          lt(enterpriseSubscriptions.lastGrantPeriodEnd, enterpriseSubscriptions.expiresAt),
        ),
      ),
    )

  const out: Array<{ enterpriseId: string; results: GrantResult[] }> = []
  for (const r of rows) {
    const results = await grantDueSubscription(r.enterpriseId, now)
    if (results.length > 0) out.push({ enterpriseId: r.enterpriseId, results })
  }
  return out
}

/**
 * 给企业分配（或重分配）套餐：覆盖现有订阅，重置周期锚点，立即发放首期。
 */
export async function assignEnterprisePlan(input: {
  enterpriseId: string
  planId: string
  expiresAt: Date
}): Promise<{ planName: string; firstGrant: GrantResult | null }> {
  const { enterpriseId, planId, expiresAt } = input
  const [plan] = await db
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.isActive, true)))
  if (!plan) throw new Error("套餐不存在或已停用")

  const now = new Date()
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error("到期时间必须晚于当前时间")
  }

  await db
    .insert(enterpriseSubscriptions)
    .values({
      enterpriseId,
      planId,
      startsAt: now,
      expiresAt,
      lastGrantPeriodEnd: null,
    })
    .onConflictDoUpdate({
      target: enterpriseSubscriptions.enterpriseId,
      set: {
        planId,
        startsAt: now,
        expiresAt,
        lastGrantPeriodEnd: null,
        updatedAt: now,
      },
    })

  const results = await grantDueSubscription(enterpriseId, now)
  return { planName: plan.name, firstGrant: results[0] ?? null }
}

/**
 * 续期：未过期时仅延长到期时间（周期锚点不变，台账幂等防重复发放）；
 * 已断档（过期后续费）则从现在起重算周期锚点并立即发放首期。
 */
export async function renewEnterprisePlan(input: {
  enterpriseId: string
  expiresAt: Date
}): Promise<{ planName: string; restarted: boolean; grants: GrantResult[] }> {
  const { enterpriseId, expiresAt } = input
  const [sub] = await db
    .select()
    .from(enterpriseSubscriptions)
    .where(eq(enterpriseSubscriptions.enterpriseId, enterpriseId))
  if (!sub) throw new Error("企业未分配套餐")

  const [plan] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, sub.planId))
  if (!plan) throw new Error("套餐不存在")

  const now = new Date()
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error("到期时间必须晚于当前时间")
  }

  if (now.getTime() <= sub.expiresAt.getTime()) {
    // 连续续期：新到期必须晚于原到期，否则无意义
    if (expiresAt.getTime() <= sub.expiresAt.getTime()) {
      throw new Error("新到期时间必须晚于当前到期时间")
    }
    await db
      .update(enterpriseSubscriptions)
      .set({ expiresAt, updatedAt: now })
      .where(eq(enterpriseSubscriptions.id, sub.id))
    // 停机期间可能已滚过周期边界，补发一次（无到期周期则空操作）
    const grants = await grantDueSubscription(enterpriseId, now)
    return { planName: plan.name, restarted: false, grants }
  }

  // 断档续期：重置锚点，立即发放首期
  await db
    .update(enterpriseSubscriptions)
    .set({
      startsAt: now,
      expiresAt,
      lastGrantPeriodEnd: null,
      updatedAt: now,
    })
    .where(eq(enterpriseSubscriptions.id, sub.id))
  const grants = await grantDueSubscription(enterpriseId, now)
  return { planName: plan.name, restarted: true, grants }
}

/** 取消企业套餐（删除订阅行；发放台账保留审计） */
export async function clearEnterprisePlan(input: { enterpriseId: string }) {
  const { enterpriseId } = input
  await db
    .delete(enterpriseSubscriptions)
    .where(eq(enterpriseSubscriptions.enterpriseId, enterpriseId))
}

/** 查询企业当前订阅摘要（侧边栏勋章 + 账户弹窗用），无订阅返回 null */
export async function getEnterprisePlanInfo(
  enterpriseId: string,
  now: Date = new Date(),
): Promise<PlanBadgeInfo | null> {
  const [row] = await db
    .select({ sub: enterpriseSubscriptions, plan: subscriptionPlans })
    .from(enterpriseSubscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, enterpriseSubscriptions.planId))
    .where(eq(enterpriseSubscriptions.enterpriseId, enterpriseId))
  if (!row) return null

  return {
    planId: row.plan.id,
    planName: row.plan.name,
    iconKey: row.plan.iconKey,
    color: row.plan.color,
    creditsPerCycle: row.plan.creditsPerCycle,
    cycleDays: row.plan.cycleDays,
    maxMembers: row.plan.maxMembers,
    startsAt: row.sub.startsAt.toISOString(),
    expiresAt: row.sub.expiresAt.toISOString(),
    lastGrantPeriodEnd: row.sub.lastGrantPeriodEnd?.toISOString() ?? null,
    isExpired: row.sub.expiresAt.getTime() <= now.getTime(),
  }
}
