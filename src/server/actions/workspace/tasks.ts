"use server"

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { cardImages, chatApiConfigs, chatTasks, promptCards, promptTemplates, workspaceApiLogs, workspacePinnedTasks, workspaceTasks } from "@/db/schema"
import { getCurrentEnterpriseScope, requireUserContext } from "@/lib/auth/session"
import { checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import { DEFAULT_FISSION_TEMPLATE, extractPromptDescriptions, fissionPrompts, getExecutableTemplate, type ChatApiConfig } from "@/server/services/workspace-ai"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { createWorkspaceTaskSchema, updateTaskTitleSchema, wsIdSchema } from "@/server/schemas/workspace"
import { revalidatePath } from "next/cache"
import { normalizeReferenceImages } from "@/lib/workspace/helpers"
import type { WorkspaceTaskRow } from "@/lib/workspace/types"
import { defaultTaskTitle, fetchOwnedTask, toChatApiConfig } from "./shared"


// ═══════════════ 任务管理 ═══════════════

/**
 * 列出当前用户的工作台任务（增强版：搜索/状态过滤/缩略图/置顶/图片计数/分页）。
 */
export async function listWorkspaceTasksAction(opts?: {
  page?: number
  pageSize?: number
  status?: string
  search?: string
}): Promise<{
  tasks: WorkspaceTaskRow[]
  total: number
  page: number
  pageSize: number
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { tasks: [], total: 0, page: 1, pageSize: 20 }
  const scope = getCurrentEnterpriseScope(ctx)
  const page = Math.max(1, opts?.page ?? 1)
  const pageSize = Math.max(1, Math.min(100, opts?.pageSize ?? 20))
  const offset = (page - 1) * pageSize

  const conds = [
    eq(workspaceTasks.enterpriseId, scope.enterpriseId),
    eq(workspaceTasks.userId, ctx.user.id),
  ]
  if (opts?.status) conds.push(eq(workspaceTasks.status, opts.status))
  if (opts?.search) {
    conds.push(sql`${workspaceTasks.title} ilike ${`%${opts.search}%`}`)
  }

  const [tasks, totalRow, pinnedRows] = await Promise.all([
    db
      .select({
        id: workspaceTasks.id,
        title: workspaceTasks.title,
        themePrompt: workspaceTasks.themePrompt,
        templateId: workspaceTasks.templateId,
        templateName: promptTemplates.name,
        status: workspaceTasks.status,
        cardCount: workspaceTasks.cardCount,
        errorMessage: workspaceTasks.errorMessage,
        createdAt: workspaceTasks.createdAt,
        updatedAt: workspaceTasks.updatedAt,
      })
      .from(workspaceTasks)
      .leftJoin(
        promptTemplates,
        eq(workspaceTasks.templateId, promptTemplates.id),
      )
      .where(and(...conds))
      .orderBy(desc(workspaceTasks.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ c: sql<number>`count(*)` })
      .from(workspaceTasks)
      .where(and(...conds)),
    db
      .select({ taskId: workspacePinnedTasks.taskId })
      .from(workspacePinnedTasks)
      .where(
        and(
          eq(workspacePinnedTasks.enterpriseId, scope.enterpriseId),
          eq(workspacePinnedTasks.userId, ctx.user.id),
        ),
      ),
  ])

  const total = Number(totalRow[0]?.c ?? 0)
  const pinnedSet = new Set(pinnedRows.map((p) => p.taskId))
  const taskIds = tasks.map((t) => t.id)

  const aggMap = new Map<
    string,
    { completed: number; generating: number; failed: number }
  >()
  const thumbMap = new Map<string, string[]>()

  if (taskIds.length > 0) {
    const [aggRows, thumbRows] = await Promise.all([
      db
        .select({
          taskId: promptCards.taskId,
          completed: sql<number>`count(*) filter (where ${cardImages.status} = 'completed')`,
          generating: sql<number>`count(*) filter (where ${cardImages.status} in ('pending','generating'))`,
          failed: sql<number>`count(*) filter (where ${cardImages.status} = 'failed')`,
        })
        .from(cardImages)
        .innerJoin(promptCards, eq(cardImages.cardId, promptCards.id))
        .where(
          and(
            eq(cardImages.enterpriseId, scope.enterpriseId),
            inArray(promptCards.taskId, taskIds),
          ),
        )
        .groupBy(promptCards.taskId),
      db
        .select({
          taskId: promptCards.taskId,
          imageUrl: cardImages.imageUrl,
        })
        .from(cardImages)
        .innerJoin(promptCards, eq(cardImages.cardId, promptCards.id))
        .where(
          and(
            eq(cardImages.enterpriseId, scope.enterpriseId),
            eq(cardImages.status, "completed"),
            inArray(promptCards.taskId, taskIds),
          ),
        )
        .orderBy(desc(cardImages.createdAt)),
    ])
    for (const r of aggRows) {
      aggMap.set(r.taskId, {
        completed: Number(r.completed),
        generating: Number(r.generating),
        failed: Number(r.failed),
      })
    }
    for (const r of thumbRows) {
      const arr = thumbMap.get(r.taskId) ?? []
      if (arr.length < 3) arr.push(r.imageUrl)
      thumbMap.set(r.taskId, arr)
    }
  }

  const rows: WorkspaceTaskRow[] = tasks.map((t) => {
    const agg = aggMap.get(t.id) ?? {
      completed: 0,
      generating: 0,
      failed: 0,
    }
    const thumbs = thumbMap.get(t.id) ?? []
    return {
      id: t.id,
      title: t.title,
      themePrompt: t.themePrompt,
      templateId: t.templateId,
      templateName: t.templateName,
      status: t.status as WorkspaceTaskRow["status"],
      cardCount: t.cardCount,
      thumbnailUrl: thumbs[0] ?? null,
      thumbnailUrls: thumbs,
      completedImageCount: agg.completed,
      generatingImageCount: agg.generating,
      failedImageCount: agg.failed,
      isPinned: pinnedSet.has(t.id),
      errorMessage: t.errorMessage,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }
  })

  return { tasks: rows, total, page, pageSize }
}

/**
 * 创建工作台任务。支持三种模式：
 *  - smart（默认）：主题 → 异步裂变 N 张卡片
 *  - extract：长文本 → 异步提取 N 张卡片
 *  - custom：直接用传入的 prompts 创建卡片
 */



/**
 * 创建工作台任务。支持三种模式：
 *  - smart（默认）：主题 → 异步裂变 N 张卡片
 *  - extract：长文本 → 异步提取 N 张卡片
 *  - custom：直接用传入的 prompts 创建卡片
 */
export async function createWorkspaceTaskAction(input: {
  mode?: "smart" | "extract" | "custom"
  theme?: string
  cardCount?: number
  templateId?: string
  prompts?: string[]
  title?: string
  referenceImages?: string[]
}): Promise<{
  ok: boolean
  error: string | null
  taskId?: string
  cardCount?: number
}> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  const parsed = createWorkspaceTaskSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  if (!ctx.enterprise) return { ok: false, error: "无企业归属" }
  const scope = getCurrentEnterpriseScope(ctx)
  const mode = input.mode ?? "smart"

  // ── custom：直接创建卡片 ──
  if (mode === "custom") {
    const prompts = (input.prompts ?? [])
      .map((p) => p.trim())
      .filter(Boolean)
    if (prompts.length === 0) {
      return { ok: false, error: "请至少提供一条提示词" }
    }
    const refImgs = normalizeReferenceImages(input.referenceImages)
    // 参考图归属校验（防跨租户引用 / 把上游 AI 当 SSRF 代理拉任意 URL）
    const refErr = await validateReferenceImageUrls(refImgs, scope.enterpriseId)
    if (refErr) return { ok: false, error: refErr }
    const title = input.title?.trim().slice(0, 200) || defaultTaskTitle()
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        enterpriseId: scope.enterpriseId,
        userId: ctx.user.id,
        title,
        themePrompt: title,
        templateId: null,
        status: "completed",
        cardCount: prompts.length,
      })
      .returning()
    await db.insert(promptCards).values(
      prompts.map((p, i) => ({
        enterpriseId: scope.enterpriseId,
        taskId: task!.id,
        cardIndex: i + 1,
        prompt: p,
        referenceImages: refImgs,
      })),
    )
    revalidatePath("/workspace")
    return { ok: true, error: null, taskId: task!.id, cardCount: prompts.length }
  }

  // ── smart / extract：异步裂变 ──
  const isExtract = mode === "extract"
  const theme = (input.theme ?? "").trim()
  if (theme.length < 2) {
    return { ok: false, error: "主题至少 2 字符" }
  }
  const cardCount = Math.max(1, Math.min(100, input.cardCount ?? 4))

  let chatApi: ChatApiConfig | null = null
  let templateContent = isExtract ? "" : DEFAULT_FISSION_TEMPLATE
  let templateId: string | null = input.templateId ?? null

  if (input.templateId) {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: isExtract ? "extract" : "fission",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    chatApi = tpl.chatApi
    templateContent = tpl.content
    templateId = tpl.id
  } else {
    const [tpl] = await db
      .select()
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.enterpriseId, scope.enterpriseId),
          eq(promptTemplates.type, isExtract ? "extract" : "fission"),
          eq(promptTemplates.status, "active"),
          or(
            eq(promptTemplates.visibility, "public"),
            eq(promptTemplates.ownerId, ctx.user.id),
          ),
        ),
      )
      .orderBy(desc(promptTemplates.createdAt))
      .limit(1)
    if (tpl?.chatApiId) {
      const [api] = await db
        .select()
        .from(chatApiConfigs)
        .where(
          and(
            eq(chatApiConfigs.id, tpl.chatApiId),
            eq(chatApiConfigs.isActive, true),
            or(
              isNull(chatApiConfigs.enterpriseId),
              eq(chatApiConfigs.enterpriseId, scope.enterpriseId),
            ),
          ),
        )
        .limit(1)
      if (api) {
        chatApi = toChatApiConfig(api)
        templateContent = tpl.content
        templateId = tpl.id
      }
    }
    if (!chatApi) {
      const [api] = await db
        .select()
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
        .limit(1)
      if (api) chatApi = toChatApiConfig(api)
    }
    if (!chatApi) {
      return { ok: false, error: "未配置可用的对话模型（联系管理员）" }
    }
  }

  const [task] = await db
    .insert(workspaceTasks)
    .values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      title: input.title?.trim().slice(0, 200) || defaultTaskTitle(),
      themePrompt: theme,
      templateId,
      status: "generating",
      cardCount,
    })
    .returning()

  const entId = scope.enterpriseId
  const userId = ctx.user.id
  const taskId = task!.id
  const api = chatApi
  const apiId = chatApi.id
  const apiName = chatApi.name
  const tmpl = templateContent

  setImmediate(async () => {
    try {
      const prompts = isExtract
        ? await extractPromptDescriptions({
            config: api,
            rawText: theme,
            template: tmpl,
            enterpriseId: entId,
            userId,
            workspaceTaskId: taskId,
            apiConfigId: apiId,
            apiConfigName: apiName,
          })
        : await fissionPrompts({
            config: api,
            theme,
            count: cardCount,
            template: tmpl,
            enterpriseId: entId,
            userId,
            workspaceTaskId: taskId,
            apiConfigId: apiId,
            apiConfigName: apiName,
          })
      const sliced = prompts.slice(0, cardCount)
      if (sliced.length > 0) {
        await db.insert(promptCards).values(
          sliced.map((p, i) => ({
            enterpriseId: entId,
            taskId,
            cardIndex: i + 1,
            prompt: p,
          })),
        )
      }
      await db
        .update(workspaceTasks)
        .set({
          status: "completed",
          cardCount: sliced.length,
          updatedAt: new Date(),
        })
        .where(eq(workspaceTasks.id, taskId))
      try {
        revalidatePath("/workspace")
      } catch {
        // 异步上下文外可能无请求作用域，忽略
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "裂变失败"
      await db
        .update(workspaceTasks)
        .set({
          status: "failed",
          errorMessage: msg,
          updatedAt: new Date(),
        })
        .where(eq(workspaceTasks.id, taskId))
    }
  })

  return { ok: true, error: null, taskId: task!.id, cardCount }
}

/** 获取单个任务详情（含 templateName） */



/** 获取单个任务详情（含 templateName） */
export async function getTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return null
  const scope = getCurrentEnterpriseScope(ctx)
  const [task] = await db
    .select({
      id: workspaceTasks.id,
      title: workspaceTasks.title,
      themePrompt: workspaceTasks.themePrompt,
      templateId: workspaceTasks.templateId,
      templateName: promptTemplates.name,
      status: workspaceTasks.status,
      cardCount: workspaceTasks.cardCount,
      errorMessage: workspaceTasks.errorMessage,
      createdAt: workspaceTasks.createdAt,
      updatedAt: workspaceTasks.updatedAt,
      userId: workspaceTasks.userId,
    })
    .from(workspaceTasks)
    .leftJoin(
      promptTemplates,
      eq(workspaceTasks.templateId, promptTemplates.id),
    )
    .where(
      and(
        eq(workspaceTasks.id, taskId),
        eq(workspaceTasks.enterpriseId, scope.enterpriseId),
        eq(workspaceTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  return task ?? null
}

/** 获取任务状态（id/status/cardCount/errorMessage，轮询用） */



/** 获取任务状态（id/status/cardCount/errorMessage，轮询用） */
export async function getTaskStatusAction(taskId: string): Promise<{
  id: string
  status: string
  cardCount: number
  errorMessage: string | null
} | null> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return null
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return null
  return {
    id: task.id,
    status: task.status,
    cardCount: task.cardCount,
    errorMessage: task.errorMessage,
  }
}

/** 重命名任务 */



/** 重命名任务 */
export async function updateTaskAction(
  taskId: string,
  input: { title: string },
) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, error: "参数错误（id 非法）" }
  const parsed = updateTaskTitleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在" }
  await db
    .update(workspaceTasks)
    .set({ title: input.title.slice(0, 200), updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 删除任务（级联清理） */



/** 删除任务（级联清理） */
export async function deleteTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, error: "参数错误（id 非法）" }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在" }

  const cards = await db
    .select({ id: promptCards.id })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const cardIds = cards.map((c) => c.id)

  if (cardIds.length > 0) {
    await db
      .delete(chatTasks)
      .where(
        and(
          eq(chatTasks.enterpriseId, scope.enterpriseId),
          or(
            inArray(chatTasks.cardId, cardIds),
            eq(chatTasks.workspaceTaskId, taskId),
          ),
        ),
      )
    await db
      .delete(cardImages)
      .where(
        and(
          eq(cardImages.enterpriseId, scope.enterpriseId),
          inArray(cardImages.cardId, cardIds),
        ),
      )
    await db
      .delete(workspaceApiLogs)
      .where(
        and(
          eq(workspaceApiLogs.enterpriseId, scope.enterpriseId),
          or(
            inArray(workspaceApiLogs.cardId, cardIds),
            eq(workspaceApiLogs.workspaceTaskId, taskId),
          ),
        ),
      )
  } else {
    await db
      .delete(chatTasks)
      .where(
        and(
          eq(chatTasks.enterpriseId, scope.enterpriseId),
          eq(chatTasks.workspaceTaskId, taskId),
        ),
      )
    await db
      .delete(workspaceApiLogs)
      .where(
        and(
          eq(workspaceApiLogs.enterpriseId, scope.enterpriseId),
          eq(workspaceApiLogs.workspaceTaskId, taskId),
        ),
      )
  }

  await db
    .delete(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  await db
    .delete(workspacePinnedTasks)
    .where(
      and(
        eq(workspacePinnedTasks.taskId, taskId),
        eq(workspacePinnedTasks.enterpriseId, scope.enterpriseId),
        eq(workspacePinnedTasks.userId, ctx.user.id),
      ),
    )
  await db.delete(workspaceTasks).where(eq(workspaceTasks.id, taskId))

  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 置顶任务（INSERT OR IGNORE） */



/** 置顶任务（INSERT OR IGNORE） */
export async function pinTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, error: "参数错误（id 非法）" }
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在" }
  await db
    .insert(workspacePinnedTasks)
    .values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      taskId,
    })
    .onConflictDoNothing({
      target: [
        workspacePinnedTasks.enterpriseId,
        workspacePinnedTasks.userId,
        workspacePinnedTasks.taskId,
      ],
    })
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 取消置顶 */



/** 取消置顶 */
export async function unpinTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return { ok: false, error: denied }
  if (!wsIdSchema.safeParse(taskId).success) return { ok: false, error: "参数错误（id 非法）" }
  const scope = getCurrentEnterpriseScope(ctx)
  await db
    .delete(workspacePinnedTasks)
    .where(
      and(
        eq(workspacePinnedTasks.taskId, taskId),
        eq(workspacePinnedTasks.enterpriseId, scope.enterpriseId),
        eq(workspacePinnedTasks.userId, ctx.user.id),
      ),
    )
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 列出置顶任务 ID 数组 */



/** 列出置顶任务 ID 数组 */
export async function listPinnedTaskIdsAction(): Promise<string[]> {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "workspace")
  if (denied) return []
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({ taskId: workspacePinnedTasks.taskId })
    .from(workspacePinnedTasks)
    .where(
      and(
        eq(workspacePinnedTasks.enterpriseId, scope.enterpriseId),
        eq(workspacePinnedTasks.userId, ctx.user.id),
      ),
    )
  return rows.map((r) => r.taskId)
}

/**
 * 聚合查询任务下所有卡片的图片状态（轮询核心）。
 *
 * 增量模式（传 since，上一轮返回的 serverTime）：
 *   - 计数来自一条 GROUP BY 聚合（替代全量图片行 + O(卡×图) filter）；
 *   - images 只返回 updatedAt > since 的变化行 + 各卡当前选中行
 *     （保证 selectedImage 可构建），客户端按 id upsert 合并；
 *   - 未变化的卡片 images 为空数组，客户端保留原数组引用（memo 生效）。
 * 不传 since 返回全量（首次轮询）。
 */


