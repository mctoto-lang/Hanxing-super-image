import { describe, expect, it } from "vitest"

import { updateSubscriptionPlanSchema } from "@/server/schemas/platform"

/**
 * 编辑套餐 isActive 契约（superadmin-2#0 回归）：
 * plan-form-dialog 编辑分支提交 isActive（「启用套餐」开关），
 * updateSubscriptionPlanAction 直接 `.set({...parsed.data})`——
 * 若 schema 剥离该键，开关保存后静默失效。锁三点：
 * 传入则保留、不传则不写（键缺省）、类型非法则拒绝。
 */

const PLAN_ID = "33333333-3333-4333-8333-333333333333"

/** subscriptionPlanInputSchema 的最小合法夹具 */
const planBase = {
  name: "Pro",
  iconKey: "medal",
  color: "#8b5cf6",
  creditsPerCycle: 10_000,
  cycleDays: 30,
  maxMembers: null,
}

describe("updateSubscriptionPlanSchema isActive", () => {
  it("传入 isActive 时保留（不被 zod 剥离），关闭开关可落库", () => {
    const parsed = updateSubscriptionPlanSchema.safeParse({
      ...planBase,
      id: PLAN_ID,
      isActive: false,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.isActive).toBe(false)
    }
  })

  it("不传 isActive 时键缺省（旧调用方不改状态）", () => {
    const parsed = updateSubscriptionPlanSchema.safeParse({
      ...planBase,
      id: PLAN_ID,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect("isActive" in parsed.data).toBe(false)
    }
  })

  it("isActive 非布尔时拒绝", () => {
    const parsed = updateSubscriptionPlanSchema.safeParse({
      ...planBase,
      id: PLAN_ID,
      isActive: "yes",
    })
    expect(parsed.success).toBe(false)
  })
})
