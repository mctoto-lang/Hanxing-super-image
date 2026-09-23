"use server"

import { and, asc, desc, eq, isNull, or } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, promptTemplates } from "@/db/schema"
import { getCurrentEnterpriseScope, requireUserContext } from "@/lib/auth/session"
import { checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import { createTemplateSchema, updateTemplateSchema, wsIdSchema } from "@/server/schemas/workspace"
import { revalidatePath } from "next/cache"
import type { ChatApiOption, TemplateRow, TemplateType } from "@/lib/workspace/types"


// ═══════════════ 模板管理 ═══════════════

/** 按类型查询模板（JOIN chatApiConfigs 获取 api_name） */
export async function listTemplatesAction(opts: {
  type: TemplateType
}): Promise<TemplateRow[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: promptTemplates.id,
      type: promptTemplates.type,
      name: promptTemplates.name,
      content: promptTemplates.content,
      chatApiId: promptTemplates.chatApiId,
      chatApiName: chatApiConfigs.displayName,
      fissionCount: promptTemplates.fissionCount,
      ownerId: promptTemplates.ownerId,
      visibility: promptTemplates.visibility,
      status: promptTemplates.status,
      createdAt: promptTemplates.createdAt,
    })
    .from(promptTemplates)
    .leftJoin(
      chatApiConfigs,
      eq(promptTemplates.chatApiId, chatApiConfigs.id),
    )
    .where(
      and(
        eq(promptTemplates.enterpriseId, scope.enterpriseId),
        eq(promptTemplates.type, opts.type),
        eq(promptTemplates.status, "active"),
        or(
          eq(promptTemplates.visibility, "public"),
          eq(promptTemplates.ownerId, ctx.user.id),
        ),
      ),
    )
    .orderBy(desc(promptTemplates.createdAt))
  return rows as TemplateRow[]
}

/** 列出可用对话模型（平台预置 + 本企业，均需 active） */



/** 列出可用对话模型（平台预置 + 本企业，均需 active） */
export async function listChatApisAction(): Promise<ChatApiOption[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: chatApiConfigs.id,
      name: chatApiConfigs.name,
      displayName: chatApiConfigs.displayName,
      enterpriseId: chatApiConfigs.enterpriseId,
    })
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.isActive, true),
        or(
          isNull(chatApiConfigs.enterpriseId),
          eq(chatApiConfigs.enterpriseId, scope.enterpriseId),
        ),
      ),
    )
    .orderBy(asc(chatApiConfigs.sortOrder), asc(chatApiConfigs.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    isPlatformPreset: r.enterpriseId === null,
  }))
}

/** 创建模板 */



/** 创建模板 */
export async function createTemplateAction(input: {
  type: TemplateType
  name: string
  content: string
  chatApiId: string
  fissionCount?: number | null
  visibility: "private" | "public"
}): Promise<{ ok: boolean; error: string | null; template?: TemplateRow }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  const parsed = createTemplateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const scope = getCurrentEnterpriseScope(ctx)
  const [tpl] = await db
    .insert(promptTemplates)
    .values({
      enterpriseId: scope.enterpriseId,
      type: input.type,
      name: input.name.trim(),
      content: input.content,
      chatApiId: input.chatApiId || null,
      fissionCount:
        input.type === "fission" ? (input.fissionCount ?? null) : null,
      ownerId: ctx.user.id,
      visibility: input.visibility,
      status: "active",
    })
    .returning()
  revalidatePath("/workspace")
  revalidatePath("/templates")
  return {
    ok: true,
    error: null,
    template: {
      id: tpl!.id,
      type: tpl!.type as TemplateType,
      name: tpl!.name,
      content: tpl!.content,
      chatApiId: tpl!.chatApiId,
      chatApiName: null,
      fissionCount: tpl!.fissionCount,
      ownerId: tpl!.ownerId,
      visibility: tpl!.visibility as "private" | "public",
      status: tpl!.status as "active" | "archived",
      createdAt: tpl!.createdAt,
    },
  }
}

/** 更新模板（校验 owner 或 admin） */



/** 更新模板（校验 owner 或 admin） */
export async function updateTemplateAction(
  templateId: string,
  input: {
    name?: string
    content?: string
    chatApiId?: string
    fissionCount?: number | null
    visibility?: "private" | "public"
  },
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(templateId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = updateTemplateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const scope = getCurrentEnterpriseScope(ctx)
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.id, templateId),
        eq(promptTemplates.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!existing) return { ok: false, error: "模板不存在" }
  if (existing.ownerId !== ctx.user.id && !isEnterpriseAdmin(ctx)) {
    return { ok: false, error: "无权修改该模板" }
  }

  await db
    .update(promptTemplates)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.chatApiId !== undefined
        ? { chatApiId: input.chatApiId || null }
        : {}),
      ...(input.fissionCount !== undefined
        ? { fissionCount: input.fissionCount }
        : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      updatedAt: new Date(),
    })
    .where(eq(promptTemplates.id, templateId))
  revalidatePath("/workspace")
  revalidatePath("/templates")
  return { ok: true, error: null }
}

/** 归档模板（status='archived'） */



/** 归档模板（status='archived'） */
export async function deleteTemplateAction(
  templateId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(templateId).success) return { ok: false, error: "参数错误（id 非法）" }
  const scope = getCurrentEnterpriseScope(ctx)
  const [existing] = await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.id, templateId),
        eq(promptTemplates.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!existing) return { ok: false, error: "模板不存在" }
  if (existing.ownerId !== ctx.user.id && !isEnterpriseAdmin(ctx)) {
    return { ok: false, error: "无权删除该模板" }
  }
  await db
    .update(promptTemplates)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(promptTemplates.id, templateId))
  revalidatePath("/workspace")
  revalidatePath("/templates")
  return { ok: true, error: null }
}

// ═══════════════ 导出 ═══════════════

/** 生成下载票据（2 分钟过期），返回下载地址。
 *  票据落 Redis（SET EX 120），多实例部署下任一实例均可消费。 */


