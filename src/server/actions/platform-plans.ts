"use server"

import { asc, count, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/db/client"
import { enterpriseSubscriptions, subscriptionPlans } from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  assignEnterprisePlanSchema,
  clearEnterprisePlanSchema,
  renewEnterprisePlanSchema,
  subscriptionPlanInputSchema,
  toggleSubscriptionPlanSchema,
  updateSubscriptionPlanSchema,
} from "@/server/schemas/platform"
import {
  assignEnterprisePlan,
  clearEnterprisePlan,
  renewEnterprisePlan,
} from "@/server/services/subscription-service"

/**
 * 订阅套餐管理 Server Actions（超管专用）
 *
 * 套餐 = 名称 + 勋章（预设图标 + 颜色）+ 周期积分 + 周期天数 + 人数上限。
 * 分配/续期/取消挂到企业维度（一企业一条当前订阅，见 subscription-service）。
 */

/** 列出全部套餐（含使用中的企业数，超管） */
export async function listSubscriptionPlansAction() {
  await requireSuperAdmin()
  const rows = await db
    .select({ plan: subscriptionPlans, enterpriseCount: count(enterpriseSubscriptions.id) })
    .from(subscriptionPlans)
    .leftJoin(
      enterpriseSubscriptions,
      eq(enterpriseSubscriptions.planId, subscriptionPlans.id),
    )
    .groupBy(subscriptionPlans.id)
    .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.createdAt))
  return {
    items: rows.map((r) => ({
      ...r.plan,
      createdAt: r.plan.createdAt.toISOString(),
      updatedAt: r.plan.updatedAt.toISOString(),
      enterpriseCount: r.enterpriseCount,
    })),
  }
}

/** 新建套餐 */
export async function createSubscriptionPlanAction(
  input: unknown,
) {
  await requireSuperAdmin()
  const parsed = subscriptionPlanInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  try {
    const [plan] = await db
      .insert(subscriptionPlans)
      .values(parsed.data)
      .returning({ id: subscriptionPlans.id, name: subscriptionPlans.name })
    revalidatePath("/platform/plans")
    return { ok: true as const, error: null, id: plan.id, name: plan.name }
  } catch (err) {
    const message = err instanceof Error ? err.message : "创建失败"
    return {
      ok: false as const,
      error: message.includes("unique") ? "套餐名称已存在" : message,
    }
  }
}

/** 编辑套餐（影响后续周期发放，已发放的不追溯） */
export async function updateSubscriptionPlanAction(input: unknown) {
  await requireSuperAdmin()
  const parsed = updateSubscriptionPlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const { id, ...data } = parsed.data
  try {
    const [plan] = await db
      .update(subscriptionPlans)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, id))
      .returning({ id: subscriptionPlans.id })
    if (!plan) return { ok: false as const, error: "套餐不存在" }
    revalidatePath("/platform/plans")
    return { ok: true as const, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : "更新失败"
    return {
      ok: false as const,
      error: message.includes("unique") ? "套餐名称已存在" : message,
    }
  }
}

/** 启用/停用套餐（停用后不可新分配，存量订阅履约至到期） */
export async function toggleSubscriptionPlanAction(input: unknown) {
  await requireSuperAdmin()
  const parsed = toggleSubscriptionPlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const { id, isActive } = parsed.data
  await db
    .update(subscriptionPlans)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(subscriptionPlans.id, id))
  revalidatePath("/platform/plans")
  return { ok: true as const, error: null }
}

/** 给企业分配（或重分配）套餐：重置周期锚点并立即发放首期 */
export async function assignEnterprisePlanAction(input: unknown) {
  await requireSuperAdmin()
  const parsed = assignEnterprisePlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data
  try {
    const { planName, firstGrant } = await assignEnterprisePlan({
      enterpriseId: d.enterpriseId,
      planId: d.planId,
      expiresAt: new Date(d.expiresAt),
    })
    revalidatePath("/platform/enterprises")
    revalidatePath("/platform/plans")
    return {
      ok: true as const,
      error: null,
      planName,
      grantedCredits: firstGrant?.creditsGranted ?? 0,
    }
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "分配失败",
    }
  }
}

/** 套餐续期（未过期仅延长时间；已断档则重算周期并发放首期） */
export async function renewEnterprisePlanAction(input: unknown) {
  await requireSuperAdmin()
  const parsed = renewEnterprisePlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data
  try {
    const { planName, restarted, grants } = await renewEnterprisePlan({
      enterpriseId: d.enterpriseId,
      expiresAt: new Date(d.expiresAt),
    })
    revalidatePath("/platform/enterprises")
    return {
      ok: true as const,
      error: null,
      planName,
      restarted,
      grantedCredits: grants.reduce((s, g) => s + g.creditsGranted, 0),
    }
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "续期失败",
    }
  }
}

/** 取消企业套餐（停止后续发放，台账保留审计） */
export async function clearEnterprisePlanAction(input: unknown) {
  await requireSuperAdmin()
  const parsed = clearEnterprisePlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  await clearEnterprisePlan({ enterpriseId: parsed.data.enterpriseId })
  revalidatePath("/platform/enterprises")
  return { ok: true as const, error: null }
}
