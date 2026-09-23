/**
 * 样机域共享类型与内部助手（自 actions/mockup.ts 拆出；非 "use server" 模块，
 * 供同目录各 action 文件复用）
 */

import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { generationTasks, mockupGroupItems, mockupGroups, mockupTemplateExtras, productPromptTemplates, type MockupBindingDef, users } from "@/db/schema"
import { type UserContext } from "@/lib/auth/session"
import { checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import { MockupApiError, getTemplate, listTemplates, type ExternalBindingDef, type MockupUserContext } from "@/lib/mockup/client"
import { type MockupEnterpriseConfig } from "@/lib/mockup/settings"
import { MOCKUP_DEFAULT_PROMPT_TEMPLATES } from "@/lib/mockup/prompt-defaults"


/**
 * 样机渲染 Server Actions
 *
 * 模板管理（外部 PSD 小模板 + 大模板套组）对全体成员开放：归属人管理
 * 自己的模板，企业管理员可管理本企业全部（可见性 public/private 按企业
 * 隔离）；卡片/图片库/渲染/批量替换为个人工作区。
 * 渲染任务不走 Redis 图像队列：扣费后批量任务经 after() 后台提交外部
 * createRenderJob（建任务+扣费落库即返回，素材中转不占用户请求），
 * 状态由 syncMockupJobs（worker/cron）+ 前端轮询双通道收敛。
 */

export function apiErrMsg(err: unknown, fallback: string): string {
  if (err instanceof MockupApiError) return err.message
  return err instanceof Error && err.message ? err.message : fallback
}



export function moduleDenied(ctx: UserContext): string | null {
  return checkModuleAccess(ctx, "mockup")
}

/** 终端用户透传上下文（模板归属/私有可见性/渲染权限） */



/** 终端用户透传上下文（模板归属/私有可见性/渲染权限） */
export function mockupUser(ctx: UserContext): MockupUserContext {
  return {
    id: ctx.user.id,
    admin: isEnterpriseAdmin(ctx),
  }
}

/** 用户 id → 显示名（昵称缺失回退登录账号） */



/** 用户 id → 显示名（昵称缺失回退登录账号） */
export async function userNamesByIds(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(inArray(users.id, unique))
  return new Map(rows.map((r) => [r.id, r.name || r.username]))
}

/** 小模板本地扩展（背景绑定标记） */



/** 小模板本地扩展（背景绑定标记） */
export async function loadBackgroundBindingIds(
  enterpriseId: string,
  externalTemplateId: string,
): Promise<string[]> {
  const [extra] = await db
    .select({ ids: mockupTemplateExtras.backgroundBindingIds })
    .from(mockupTemplateExtras)
    .where(
      and(
        eq(mockupTemplateExtras.enterpriseId, enterpriseId),
        eq(mockupTemplateExtras.externalTemplateId, externalTemplateId),
      ),
    )
    .limit(1)
  return extra?.ids ?? []
}

/** 外部绑定定义 → 本地快照（合并背景角色标记） */



/** 外部绑定定义 → 本地快照（合并背景角色标记） */
export async function toBindingSnapshot(
  enterpriseId: string,
  externalTemplateId: string,
  defs: ExternalBindingDef[] | undefined,
): Promise<MockupBindingDef[]> {
  const background = new Set(
    await loadBackgroundBindingIds(enterpriseId, externalTemplateId),
  )
  return (defs ?? []).map((b) => ({
    bindingId: b.bindingId,
    layerId: b.layerId,
    layerPath: b.layerPath,
    type: b.type,
    required: b.required ?? true,
    label: b.label ?? b.bindingId,
    fit: b.fit ?? "stretch",
    ...(background.has(b.bindingId) ? { role: "background" as const } : {}),
  }))
}

/**
 * 以模板背景标记（mockup_template_extra）为权威，双向校正套组快照 bindings 的 role：
 * 快照只在入组时合并一次，之后标记的增删不会回写，读取时需重新校正。
 */



/**
 * 以模板背景标记（mockup_template_extra）为权威，双向校正套组快照 bindings 的 role：
 * 快照只在入组时合并一次，之后标记的增删不会回写，读取时需重新校正。
 */
export function overlayBackgroundRole(
  defs: MockupBindingDef[],
  background: Set<string>,
): MockupBindingDef[] {
  return defs.map((b) => {
    const { role: _stale, ...rest } = b
    return background.has(b.bindingId)
      ? { ...rest, role: "background" as const }
      : rest
  })
}

/** 当前任务快照的必填绑定是否配齐 */



/** 当前任务快照的必填绑定是否配齐 */
export function isItemConfigured(
  defs: MockupBindingDef[],
  settings: Record<string, { imageUrl?: string; text?: string }> | undefined,
): boolean {
  return defs.every((def) => {
    if (!def.required) return true
    const value = settings?.[def.bindingId]
    if (def.type === "text") {
      return Boolean(value?.text?.trim())
    }
    return Boolean(value?.imageUrl)
  })
}

/** AI背景提示词：平台模板（product_prompt_template mockup.ai_background）缺省回退内置 */



/** AI背景提示词：平台模板（product_prompt_template mockup.ai_background）缺省回退内置 */
export async function loadMockupAiBackgroundPrompt(): Promise<string> {
  try {
    const [row] = await db
      .select({ template: productPromptTemplates.template })
      .from(productPromptTemplates)
      .where(
        and(
          eq(productPromptTemplates.scene, "mockup.ai_background"),
          eq(productPromptTemplates.isActive, true),
        ),
      )
      .limit(1)
    const template = row?.template?.trim()
    if (template) return template
  } catch {
    // 查询异常回退内置默认
  }
  return MOCKUP_DEFAULT_PROMPT_TEMPLATES["mockup.ai_background"]!
}

/**
 * 查方块最近一张渲染完成的原图（AI 参考/对比基准，不信任前端传入）；
 * before 限定只取该时间点之前创建的（首个 AI背景落地前的 = 纯套版渲染）。
 */



/**
 * 查方块最近一张渲染完成的原图（AI 参考/对比基准，不信任前端传入）；
 * before 限定只取该时间点之前创建的（首个 AI背景落地前的 = 纯套版渲染）。
 */
export async function latestRenderedImageUrl(
  enterpriseId: string,
  userId: string,
  cardId: string,
  groupItemId: string,
  before?: Date,
): Promise<string | null> {
  const conditions = [
    eq(generationTasks.taskType, "mockup"),
    eq(generationTasks.status, "completed"),
    eq(generationTasks.enterpriseId, enterpriseId),
    eq(generationTasks.userId, userId),
    sql`${generationTasks.templateInfo}->>'cardId' = ${cardId}`,
    sql`${generationTasks.templateInfo}->>'groupItemId' = ${groupItemId}`,
    ...(before ? [lt(generationTasks.createdAt, before)] : []),
  ]
  const [task] = await db
    .select({ resultImages: generationTasks.resultImages })
    .from(generationTasks)
    .where(and(...conditions))
    .orderBy(desc(generationTasks.completedAt))
    .limit(1)
  return task?.resultImages?.[0] ?? null
}

/** 查方块某时间点之后第一张渲染完成的图（AI背景落地触发的重套样机结果） */



/** 查方块某时间点之后第一张渲染完成的图（AI背景落地触发的重套样机结果） */
export async function firstRenderedImageUrlAfter(
  enterpriseId: string,
  userId: string,
  cardId: string,
  groupItemId: string,
  after: Date,
): Promise<string | null> {
  const [task] = await db
    .select({ resultImages: generationTasks.resultImages })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.status, "completed"),
        eq(generationTasks.enterpriseId, enterpriseId),
        eq(generationTasks.userId, userId),
        sql`${generationTasks.templateInfo}->>'cardId' = ${cardId}`,
        sql`${generationTasks.templateInfo}->>'groupItemId' = ${groupItemId}`,
        gte(generationTasks.createdAt, after),
      ),
    )
    .orderBy(asc(generationTasks.createdAt))
    .limit(1)
  return task?.resultImages?.[0] ?? null
}

/* ═══════════════ 页面初始数据 ═══════════════ */

/** 大模板可见范围（管理员全部；成员 = 公开 + 自己的） */



/* ═══════════════ 页面初始数据 ═══════════════ */

/** 大模板可见范围（管理员全部；成员 = 公开 + 自己的） */
export function groupVisibilityCondition(ctx: UserContext) {
  if (isEnterpriseAdmin(ctx)) return undefined
  return or(
    eq(mockupGroups.visibility, "public"),
    eq(mockupGroups.ownerUserId, ctx.user.id),
  )
}



/** 从外部模板详情快照成员信息（版本钉住 + 绑定定义抄录 + 背景角色合并） */
export async function snapshotGroupItem(
  cfg: MockupEnterpriseConfig,
  enterpriseId: string,
  input: { templateId: string; displayName?: string; sortOrder: number },
  user: MockupUserContext,
): Promise<{ ok: true; item: typeof mockupGroupItems.$inferInsert } | { ok: false; error: string }> {
  const detail = await getTemplate(cfg, input.templateId, user)
  const version = detail.latestVersion
  if (!version || !version.published) {
    return { ok: false, error: `模板「${detail.name}」未发布，不能加入套组` }
  }
  const bindings = await toBindingSnapshot(
    enterpriseId,
    detail.templateId,
    version.layerSchema.bindings,
  )
  return {
    ok: true,
    item: {
      groupId: "", // 由调用方回填
      templateVersionId: version.versionId,
      externalTemplateId: detail.templateId,
      displayName: input.displayName?.trim() || detail.name,
      canvasWidth: version.canvas?.width ?? null,
      canvasHeight: version.canvas?.height ?? null,
      bindings,
      sortOrder: input.sortOrder,
    },
  }
}

/** 外部模板可见性表（校验成员可选性与公开规则用） */



/** 外部模板可见性表（校验成员可选性与公开规则用） */
export async function loadTemplateVisibilityMap(
  cfg: MockupEnterpriseConfig,
  user: MockupUserContext,
): Promise<Map<string, { visibility: "public" | "private"; ownerUserId: string | null }>> {
  const templates = await listTemplates(cfg, user)
  return new Map(
    templates.map((t) => [
      t.templateId,
      {
        visibility: t.visibility === "private" ? ("private" as const) : ("public" as const),
        ownerUserId: t.ownerUserId,
      },
    ]),
  )
}

/** 校验成员模板可选 + 公开规则（公开套组要求成员全部公开） */



/* ═══════════════ 渲染提交与状态 ═══════════════ */

export interface ReadyItem {
  cardId: string
  groupItemId: string
  displayName: string
  templateVersionId: string
  canvasWidth: number | null
  canvasHeight: number | null
  input: Record<string, { imageUrl?: string; text?: string }>
}

/**
 * 渲染核心（整卡/多卡/单样机共用）：
 * 校验 → 建任务 → 扣费 → 逐任务素材中转 + 提交外部（失败单个退款）。
 *
 * 仅首次渲染规则：已成功出图/渲染中的方块直接跳过（skipped 说明原因），
 * 彻底规避模板后续变动导致的重渲染失败；AI背景落地重渲染传
 * allowCompleted 旁路（该重渲染本身是 AI背景功能的一环）。
 */


