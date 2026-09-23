import type { z } from "zod"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
  type UserContext,
} from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import type { ModuleName } from "@/db/schema"

/**
 * Server Action 守卫与返回类型工具（"use server" 文件的共享基建，本模块不带
 * "use server"，可导出类型与同步工具）
 *
 * 现状问题：各 action 文件重复六行序言——requireUserContext →
 * checkModuleAccess → safeParse → getCurrentEnterpriseScope，且
 * `Promise<{ ok: boolean; error?: string }>` 内联声明 20+ 处、错误文案
 * 各写各的。新代码用 requireActionGuard + ActionResult 收敛。
 */

/** 通用返回约定：ok=false 时 error 必有值；特定负载字段由各 action 自行扩展 */
export type ActionResult = { ok: boolean; error?: string | null }

/** 守卫失败（可直接作为 action 返回值的一部分）；成功携带执行上下文 */
export type ActionGuard =
  | { ok: false; error: string }
  | {
      ok: true
      ctx: UserContext
      enterpriseId: string
      /** schema 校验后的输入（已按 zod 规范化/转型） */
      parsed: z.output<z.ZodTypeAny>
    }

/**
 * action 前置守卫一次完成：登录（未登录抛错，与既有 action 行为一致）→
 * 模块权限（module 传 null 跳过）→ 入参校验 → 企业作用域。
 *
 * 用法：
 * ```ts
 * const g = await requireActionGuard("workspace", wsIdSchema, id)
 * if (!g.ok) return { ok: false, error: g.error }
 * const { ctx, enterpriseId } = g
 * ```
 */
export async function requireActionGuard(
  module: ModuleName | null,
  schema: z.ZodTypeAny,
  input: unknown,
): Promise<ActionGuard> {
  const ctx = await requireUserContext()
  if (module) {
    const denied = checkModuleAccess(ctx, module)
    if (denied) return { ok: false, error: denied }
  }
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  return {
    ok: true,
    ctx,
    enterpriseId: getCurrentEnterpriseScope(ctx).enterpriseId,
    parsed: parsed.data,
  }
}
