import type { ModuleName, EnterpriseRole } from "@/db/schema"
import type { UserContext } from "@/lib/auth/session"

/**
 * 角色/权限校验工具（手册 §5.1、§10.2）
 *
 * 四层鉴权维度（每个请求依次校验）：
 *   平台身份 isSuperAdmin → 企业归属 enterpriseId → 企业角色 enterpriseRole
 *   → 权限组 groupId（allowedModels/allowedPages/maxConcurrent）
 */

/** 是否平台超管 */
export function isSuperAdmin(ctx: UserContext | null): boolean {
  return !!ctx?.user.isSuperAdmin
}

/** 是否企业管理员（owner 或 admin） */
export function isEnterpriseAdmin(ctx: UserContext | null): boolean {
  if (!ctx) return false
  return ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"
}

/** 是否企业管理员（owner，企业最高管理员） */
export function isEnterpriseOwner(ctx: UserContext | null): boolean {
  return ctx?.user.enterpriseRole === "owner"
}

/** 角色中文显示名（全项目唯一文案来源：owner=企业管理员、admin=管理员） */
export function roleLabel(role: EnterpriseRole | undefined): string {
  switch (role) {
    case "owner":
      return "企业管理员"
    case "admin":
      return "管理员"
    case "member":
      return "成员"
    default:
      return "超管"
  }
}

/**
 * 校验页面访问（手册 §5.1 模块访问校验链）。
 *
 * 返回 null 表示放行；否则返回拒绝原因（供 middleware 或页面提示）。
 */
export function checkModuleAccess(
  ctx: UserContext | null,
  target: ModuleName,
): string | null {
  if (!ctx) return "未登录"
  if (ctx.user.isSuperAdmin) return null // 超管放行
  if (!ctx.enterprise) return "当前用户无有效企业"
  if (!ctx.canAccess(target)) {
    return `无权访问该模块（${target}）`
  }
  return null
}

/**
 * 校验模型访问：模型 id 必须在权限组 allowedModels 内
 * （allowedModels 为空时默认放行企业全部已开通模型，手册 D21）。
 *
 * 注意：企业可见性（平台白名单 / 企业私有归属）由调用方查询模型行后
 * 显式校验，本函数不再接收企业模型集合参数（历史签名传入 [modelId]
 * 自证，属于无效空转）。
 */
export function checkModelAccess(
  ctx: UserContext,
  modelId: string,
): string | null {
  if (ctx.user.isSuperAdmin) return null
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    if (!ctx.group.allowedModels.includes(modelId)) {
      return "当前权限组无权使用该模型"
    }
  }
  return null
}

/**
 * 取三层并发上限的最小值（手册 §10.5）：
 *   enterprise.maxConcurrent ≥ group.maxConcurrent ≥ model.maxConcurrent
 *
 * 消费端 Redis 槽位（task-queue.ts acquireImageSlot 的 ACQUIRE_SLOT_LUA）
 * 已按企业 + 模型 + 权限组三层强制执行；本函数用于前端并发上限提示。
 */
export function effectiveConcurrentLimit(opts: {
  enterprise: number
  group?: number | null
  model: number
}): number {
  const limits = [opts.enterprise, opts.group ?? Infinity, opts.model].filter(
    (n): n is number => typeof n === "number" && n > 0,
  )
  return limits.length ? Math.min(...limits) : 1
}
