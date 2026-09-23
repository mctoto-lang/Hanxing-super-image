"use server"

import { and, asc, desc, eq, isNull, or } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, generationTasks, models, promptTemplates, type ModelSizePreset } from "@/db/schema"
import { getCurrentEnterpriseScope, requireUserContext } from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import { saveExportTicket } from "@/server/services/export-ticket"
import type { TemplateType } from "@/lib/workspace/types"
import { fetchOwnedTask } from "./shared"


// ═══════════════ 导出 ═══════════════

/** 生成下载票据（2 分钟过期），返回下载地址。
 *  票据落 Redis（SET EX 120），多实例部署下任一实例均可消费。 */
export async function createExportTicketAction(
  taskId: string,
  input: { format: string; cardIds?: string[] },
): Promise<{ ok: boolean; error: string | null; downloadUrl?: string }> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在" }
  const token = await saveExportTicket({
    enterpriseId: scope.enterpriseId,
    userId: ctx.user.id,
    taskId,
    cardIds: input.cardIds,
    format: input.format,
  })
  return {
    ok: true,
    error: null,
    downloadUrl: `/api/workspace/export?ticket=${token}`,
  }
}

// ═══════════════ 旧接口保留（兼容现有调用方） ═══════════════

/** 列出本企业可见的对话模型（完整字段，旧接口保留兼容） */



// ═══════════════ 旧接口保留（兼容现有调用方） ═══════════════

/** 列出本企业可见的对话模型（完整字段，旧接口保留兼容） */
export async function listChatApiConfigsAction() {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  return await db
    .select({
      id: chatApiConfigs.id,
      name: chatApiConfigs.name,
      displayName: chatApiConfigs.displayName,
      isActive: chatApiConfigs.isActive,
    })
    .from(chatApiConfigs)
    .where(
      or(
        isNull(chatApiConfigs.enterpriseId),
        eq(chatApiConfigs.enterpriseId, scope.enterpriseId),
      ),
    )
}

/** 列出本企业的提示词模板（按 type 参数化，默认 fission） */



/** 列出本企业的提示词模板（按 type 参数化，默认 fission） */
export async function listPromptTemplatesAction(opts?: {
  type?: TemplateType
}) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const type = opts?.type ?? "fission"
  return await db
    .select()
    .from(promptTemplates)
    .where(
      and(
        eq(promptTemplates.enterpriseId, scope.enterpriseId),
        eq(promptTemplates.type, type),
        eq(promptTemplates.status, "active"),
        or(
          eq(promptTemplates.visibility, "public"),
          eq(promptTemplates.ownerId, ctx.user.id),
        ),
      ),
    )
    .orderBy(desc(promptTemplates.createdAt))
}

// ═══════════════ 工作台可用模型 + 队列状态 ═══════════════

/** 列出工作台可用的图片模型（visibleInWorkspace + isActive） */



// ═══════════════ 工作台可用模型 + 队列状态 ═══════════════

/** 列出工作台可用的图片模型（visibleInWorkspace + isActive） */
export async function listWorkspaceModelsAction(): Promise<
  Array<{
    id: string
    name: string
    displayName: string | null
    sizePresets: ModelSizePreset[] | null
    iconUrl: string | null
    supportsReferenceImage: boolean
    maxReferenceImages: number | null
    costPerImage: number
    enterpriseId: string | null
  }>
> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return []
  if (!ctx.enterprise) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      sizePresets: models.sizePresets,
      iconUrl: models.iconUrl,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      costPerImage: models.costPerImage,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(and(eq(models.isActive, true), eq(models.visibleInWorkspace, true)))
    .orderBy(asc(models.sortOrder), asc(models.createdAt))
  // 平台预置 + 本企业私有
  const accessible = rows.filter(
    (m) => m.enterpriseId === null || m.enterpriseId === scope.enterpriseId,
  )
  // 平台预置模型按企业 visiblePresetModels 白名单过滤（需求 2c：空 = 全部可见）
  const visiblePreset =
    (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
  const filtered =
    visiblePreset.length === 0
      ? accessible
      : accessible.filter(
          (m) => m.enterpriseId !== null || visiblePreset.includes(m.id),
        )
  // 权限组 allowedModels 过滤
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    return filtered.filter((m) =>
      ctx.group!.allowedModels.includes(m.id),
    )
  }
  return filtered
}

/** 获取当前企业的队列状态（queued + processing 计数） */



/** 获取当前企业的队列状态（queued + processing 计数） */
export async function getQueueStatusAction(): Promise<{
  queued: number
  processing: number
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { queued: 0, processing: 0 }
  if (!ctx.enterprise) return { queued: 0, processing: 0 }
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      status: generationTasks.status,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        isNull(generationTasks.deletedAt),
      ),
    )
  let queued = 0
  let processing = 0
  for (const r of rows) {
    if (r.status === "queued") queued++
    else if (r.status === "processing") processing++
  }
  return { queued, processing }
}


