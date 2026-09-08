"use server"

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  cardImages,
  chatApiConfigs,
  chatTasks,
  generationTasks,
  models,
  promptCards,
  promptTemplates,
  workspaceApiLogs,
  workspacePinnedTasks,
  workspaceTasks,
  type ModelSizePreset,
} from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
  type UserContext,
} from "@/lib/auth/session"
import { checkModelAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import {
  deepenPrompt,
  extractNumberedPromptReplacements,
  extractPromptDescriptions,
  fissionPrompts,
  getExecutableTemplate,
  translatePrompt,
  DEFAULT_FISSION_TEMPLATE,
  type ChatApiConfig,
} from "@/server/services/workspace-ai"
import { deductUserCredits, refundFailedTask, refundUserCredits } from "@/server/services/credits-service"
import { saveExportTicket } from "@/server/services/export-ticket"
import { enqueue, enqueueMany } from "@/lib/queue/task-queue"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { revalidatePath } from "next/cache"
import {
  getGenerationPrompt,
  getReferenceImageLimit,
  normalizeReferenceImages,
} from "@/lib/workspace/helpers"
import type {
  BatchGenerationLanguage,
  CardImageRow,
  ChatApiOption,
  PromptCardRow,
  TaskCardImagesPayload,
  TemplateRow,
  TemplateType,
  WorkspaceTaskRow,
} from "@/lib/workspace/types"

/**
 * 工作台 Server Actions（手册 M5，1:1 对齐旧项目 REST API）
 *
 * 任务/卡片/批量/模板/导出全能力。多租户：所有查询按 enterpriseId 隔离，
 * 任务级数据再按 userId 收敛为当前用户私有。
 */

// ─── 导出票据（Redis 存储，2 分钟过期；核心逻辑在 services/export-ticket） ───

// ─── 复用 select 字段 ───

const cardImageSelectFields = {
  id: cardImages.id,
  cardId: cardImages.cardId,
  generationTaskId: cardImages.generationTaskId,
  generationPrompt: cardImages.generationPrompt,
  imageApiId: cardImages.imageApiId,
  imageUrl: cardImages.imageUrl,
  modelName: models.displayName,
  size: cardImages.size,
  format: cardImages.format,
  status: cardImages.status,
  errorMessage: cardImages.errorMessage,
  isSelected: cardImages.isSelected,
  source: cardImages.source,
  generationStartedAt: generationTasks.startedAt,
  generationCompletedAt: generationTasks.completedAt,
  createdAt: cardImages.createdAt,
}

const cardRowSelectFields = {
  id: promptCards.id,
  taskId: promptCards.taskId,
  cardIndex: promptCards.cardIndex,
  prompt: promptCards.prompt,
  translatedPrompt: promptCards.translatedPrompt,
  translationSourcePrompt: promptCards.translationSourcePrompt,
  translationStatus: promptCards.translationStatus,
  translationTemplateId: promptCards.translationTemplateId,
  displayLanguage: promptCards.displayLanguage,
  selectedImageId: promptCards.selectedImageId,
  referenceImages: promptCards.referenceImages,
  selImgId: cardImages.id,
  selImgUrl: cardImages.imageUrl,
  selImgModelName: models.displayName,
  selImgSize: cardImages.size,
  selImgStartedAt: generationTasks.startedAt,
  selImgCompletedAt: generationTasks.completedAt,
  selImgCreatedAt: cardImages.createdAt,
  createdAt: promptCards.createdAt,
  updatedAt: promptCards.updatedAt,
}

// ─── 内部辅助 ───

/**
 * 默认任务标题（用户未填写时）：只用时间戳，不含提示词内容——
 * 任务名称以用户创建/重命名时输入的名字为准，主题/提示词不再填入名称
 */
function defaultTaskTitle(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `批量任务 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** 取当前用户拥有的工作台任务（enterpriseId + userId 双重隔离） */
async function fetchOwnedTask(ctx: UserContext, taskId: string) {
  const scope = getCurrentEnterpriseScope(ctx)
  const [task] = await db
    .select()
    .from(workspaceTasks)
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

/** 取当前用户拥有的卡片（含其任务，校验 task.userId） */
async function fetchOwnedCard(ctx: UserContext, cardId: string) {
  const scope = getCurrentEnterpriseScope(ctx)
  const [row] = await db
    .select({ card: promptCards, task: workspaceTasks })
    .from(promptCards)
    .innerJoin(workspaceTasks, eq(promptCards.taskId, workspaceTasks.id))
    .where(
      and(
        eq(promptCards.id, cardId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
        eq(workspaceTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  return row ?? null
}

/** 重算任务 cardCount */
async function updateTaskCardCount(taskId: string, enterpriseId: string) {
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, enterpriseId),
      ),
    )
  await db
    .update(workspaceTasks)
    .set({ cardCount: Number(row?.c ?? 0), updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))
}

/** 规范化 chatApi 行为 ChatApiConfig */
function toChatApiConfig(
  api: typeof chatApiConfigs.$inferSelect,
): ChatApiConfig {
  return {
    id: api.id,
    name: api.name,
    displayName: api.displayName,
    apiEndpoint: api.apiEndpoint,
    apiKeyEncrypted: api.apiKeyEncrypted,
    formatType: api.formatType,
    extraConfig: api.extraConfig,
    maxConcurrent: api.maxConcurrent,
    maxRetries: api.maxRetries,
    apiTimeout: api.apiTimeout,
  }
}

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
export async function getTaskAction(taskId: string) {
  const ctx = await requireUserContext()
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
export async function getTaskStatusAction(taskId: string): Promise<{
  id: string
  status: string
  cardCount: number
  errorMessage: string | null
} | null> {
  const ctx = await requireUserContext()
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
export async function updateTaskAction(
  taskId: string,
  input: { title: string },
) {
  const ctx = await requireUserContext()
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
export async function deleteTaskAction(taskId: string) {
  const ctx = await requireUserContext()
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
export async function pinTaskAction(taskId: string) {
  const ctx = await requireUserContext()
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
export async function unpinTaskAction(taskId: string) {
  const ctx = await requireUserContext()
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
export async function listPinnedTaskIdsAction(): Promise<string[]> {
  const ctx = await requireUserContext()
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
export async function getTaskCardImagesAction(
  taskId: string,
  since?: string,
): Promise<TaskCardImagesPayload> {
  // serverTime 取在查询之前：查询执行期间落库的行下一轮 since 一定能覆盖到
  const serverTime = new Date()
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { cards: {} }

  const cards = await db
    .select({
      id: promptCards.id,
      selectedImageId: promptCards.selectedImageId,
    })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
    .orderBy(promptCards.cardIndex)

  const cardIds = cards.map((c) => c.id)
  if (cardIds.length === 0) {
    return { cards: {}, serverTime: serverTime.toISOString() }
  }

  // 计数聚合（一条 GROUP BY）
  const countRows = await db
    .select({
      cardId: cardImages.cardId,
      status: cardImages.status,
      count: sql<number>`count(*)`,
    })
    .from(cardImages)
    .where(
      and(
        eq(cardImages.enterpriseId, scope.enterpriseId),
        inArray(cardImages.cardId, cardIds),
      ),
    )
    .groupBy(cardImages.cardId, cardImages.status)

  const countMap = new Map<
    string,
    { pending: number; completed: number; failed: number }
  >()
  for (const row of countRows) {
    const entry = countMap.get(row.cardId) ?? {
      pending: 0,
      completed: 0,
      failed: 0,
    }
    const n = Number(row.count)
    if (row.status === "pending" || row.status === "generating") {
      entry.pending += n
    } else if (row.status === "completed") {
      entry.completed += n
    } else if (row.status === "failed") {
      entry.failed += n
    }
    countMap.set(row.cardId, entry)
  }

  const incremental = Boolean(since)
  const sinceDate = incremental ? new Date(since!) : null
  if (incremental && Number.isNaN(sinceDate!.getTime())) {
    // 非法 since 按全量处理
    return getTaskCardImagesAction(taskId)
  }

  // 增量窗口回看 3s：worker 写入的 updatedAt（worker 进程时钟）可能落在上一轮
  // serverTime（web 进程时钟）附近甚至之前，跨界行会被所有后续增量永久跳过。
  // 重发的未变化行由客户端 mergeImageRows 幂等吸收，代价仅为 3s 内的变化行。
  const DELTA_OVERLAP_MS = 3_000
  const deltaSinceDate =
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? new Date(sinceDate.getTime() - DELTA_OVERLAP_MS)
      : null

  const selectedIds = cards
    .map((c) => c.selectedImageId)
    .filter((v): v is string => Boolean(v))

  const imageConditions = [
    eq(cardImages.enterpriseId, scope.enterpriseId),
    inArray(cardImages.cardId, cardIds),
  ]
  if (deltaSinceDate) {
    const deltaCondition = selectedIds.length > 0
      ? or(
          gt(cardImages.updatedAt, deltaSinceDate),
          inArray(cardImages.id, selectedIds),
        )
      : gt(cardImages.updatedAt, deltaSinceDate)
    imageConditions.push(deltaCondition!)
  }

  const images = await db
    .select(cardImageSelectFields)
    .from(cardImages)
    .leftJoin(models, eq(cardImages.imageApiId, models.id))
    .leftJoin(
      generationTasks,
      eq(cardImages.generationTaskId, generationTasks.id),
    )
    .where(and(...imageConditions))
    .orderBy(desc(cardImages.createdAt))

  const imagesByCard = new Map<string, typeof images>()
  for (const img of images) {
    const list = imagesByCard.get(img.cardId)
    if (list) list.push(img)
    else imagesByCard.set(img.cardId, [img])
  }

  const payload: TaskCardImagesPayload = {
    serverTime: serverTime.toISOString(),
    incremental,
    cards: {},
  }
  for (const card of cards) {
    const counts = countMap.get(card.id) ?? {
      pending: 0,
      completed: 0,
      failed: 0,
    }
    const cardImgs = imagesByCard.get(card.id) ?? []
    const sel = cardImgs.find((i) => i.id === card.selectedImageId) ?? null
    payload.cards[card.id] = {
      cardId: card.id,
      pendingCount: counts.pending,
      completedCount: counts.completed,
      failedCount: counts.failed,
      // 增量模式下未取到选中行时省略该字段，客户端保留上一轮的选中图信息
      selectedImage: sel
        ? {
            id: sel.id,
            imageUrl: sel.imageUrl,
            modelName: sel.modelName,
            size: sel.size,
            startedAt: sel.generationStartedAt,
            completedAt: sel.generationCompletedAt,
            createdAt: sel.createdAt,
          }
        : incremental
          ? undefined
          : null,
      images: cardImgs as CardImageRow[],
    }
  }
  return payload
}

// ═══════════════ 卡片管理 ═══════════════

/** 获取任务的卡片列表（JOIN 选中图信息 + 模型名） */
export async function getTaskCardsAction(
  taskId: string,
  opts?: { pageSize?: number },
): Promise<{ cards: PromptCardRow[]; total: number }> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { cards: [], total: 0 }
  const pageSize = opts?.pageSize ?? 1000

  const [cards, totalRow] = await Promise.all([
    db
      .select(cardRowSelectFields)
      .from(promptCards)
      .leftJoin(cardImages, eq(promptCards.selectedImageId, cardImages.id))
      .leftJoin(models, eq(cardImages.imageApiId, models.id))
      .leftJoin(
        generationTasks,
        eq(cardImages.generationTaskId, generationTasks.id),
      )
      .where(
        and(
          eq(promptCards.taskId, taskId),
          eq(promptCards.enterpriseId, scope.enterpriseId),
        ),
      )
      .orderBy(promptCards.cardIndex)
      .limit(pageSize),
    db
      .select({ c: sql<number>`count(*)` })
      .from(promptCards)
      .where(
        and(
          eq(promptCards.taskId, taskId),
          eq(promptCards.enterpriseId, scope.enterpriseId),
        ),
      ),
  ])

  return { cards: cards as PromptCardRow[], total: Number(totalRow[0]?.c ?? 0) }
}

/** 添加卡片（cardIndex = MAX+1） */
export async function addCardAction(
  taskId: string,
  input: { prompt: string },
) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在" }
  // 允许空白卡片：点击「添加卡片」直接创建，提示词后续在卡片背面编辑
  const prompt = input.prompt.trim()

  const [maxRow] = await db
    .select({ m: sql<number>`coalesce(max(${promptCards.cardIndex}), 0)` })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const nextIndex = Number(maxRow?.m ?? 0) + 1

  const [card] = await db
    .insert(promptCards)
    .values({
      enterpriseId: scope.enterpriseId,
      taskId,
      cardIndex: nextIndex,
      prompt,
    })
    .returning()
  await updateTaskCardCount(taskId, scope.enterpriseId)
  revalidatePath("/workspace")
  return { ok: true, error: null, cardId: card!.id }
}

/** 更新卡片提示词/显示语言 */
export async function updateCardAction(
  cardId: string,
  input: { prompt?: string; displayLanguage?: "zh" | "en" },
) {
  const ctx = await requireUserContext()
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  await db
    .update(promptCards)
    .set({
      ...(input.prompt !== undefined
        ? { prompt: input.prompt, translationStatus: "outdated" }
        : {}),
      ...(input.displayLanguage !== undefined
        ? { displayLanguage: input.displayLanguage }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(promptCards.id, cardId))
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 删除卡片 */
export async function deleteCardAction(cardId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const taskId = owned.task.id
  await db
    .delete(promptCards)
    .where(
      and(
        eq(promptCards.id, cardId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  await updateTaskCardCount(taskId, scope.enterpriseId)
  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 批量删除卡片 */
export async function batchDeleteCardsAction(cardIds: string[]) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const validIds: string[] = []
  const taskIds = new Set<string>()
  for (const id of cardIds) {
    const owned = await fetchOwnedCard(ctx, id)
    if (owned) {
      validIds.push(id)
      taskIds.add(owned.task.id)
    }
  }
  if (validIds.length > 0) {
    await db
      .delete(promptCards)
      .where(
        and(
          inArray(promptCards.id, validIds),
          eq(promptCards.enterpriseId, scope.enterpriseId),
        ),
      )
  }
  for (const tid of taskIds) await updateTaskCardCount(tid, scope.enterpriseId)
  revalidatePath("/workspace")
  return { ok: true, deletedIds: validIds, deletedCount: validIds.length }
}

/** 同步细化卡片提示词 */
export async function deepenCardPromptAction(
  cardId: string,
  input: { prompt: string; templateId: string },
): Promise<{ ok: boolean; error: string | null; newPrompt?: string }> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  try {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "deepen",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    const newPrompt = await deepenPrompt({
      config: tpl.chatApi,
      currentPrompt: input.prompt,
      template: tpl.content,
      templateType: "deepen",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      cardId,
      workspaceTaskId: owned.task.id,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    })
    await db
      .update(promptCards)
      .set({
        prompt: newPrompt,
        translationStatus: "outdated",
        updatedAt: new Date(),
      })
      .where(eq(promptCards.id, cardId))
    revalidatePath("/workspace")
    return { ok: true, error: null, newPrompt }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "细化失败" }
  }
}

/** 同步重新生成卡片提示词 */
export async function regenerateCardPromptAction(
  cardId: string,
  input: { prompt: string; templateId: string },
): Promise<{ ok: boolean; error: string | null; newPrompt?: string }> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  try {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "regenerate",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    const newPrompt = await deepenPrompt({
      config: tpl.chatApi,
      currentPrompt: input.prompt,
      template: tpl.content,
      templateType: "regenerate",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      cardId,
      workspaceTaskId: owned.task.id,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    })
    await db
      .update(promptCards)
      .set({
        prompt: newPrompt,
        translationStatus: "outdated",
        updatedAt: new Date(),
      })
      .where(eq(promptCards.id, cardId))
    revalidatePath("/workspace")
    return { ok: true, error: null, newPrompt }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "重新生成失败",
    }
  }
}

/** 同步翻译卡片提示词 */
export async function translateCardPromptAction(
  cardId: string,
  input: { templateId: string },
): Promise<{ ok: boolean; error: string | null; translatedPrompt?: string }> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  try {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "translate",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    const translatedPrompt = await translatePrompt({
      config: tpl.chatApi,
      currentPrompt: owned.card.prompt,
      template: tpl.content,
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      cardId,
      workspaceTaskId: owned.task.id,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    })
    await db
      .update(promptCards)
      .set({
        translatedPrompt,
        translationSourcePrompt: owned.card.prompt,
        translationStatus: "synced",
        translationTemplateId: tpl.id,
        updatedAt: new Date(),
      })
      .where(eq(promptCards.id, cardId))
    revalidatePath("/workspace")
    return { ok: true, error: null, translatedPrompt }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "翻译失败" }
  }
}

/** 单卡生图内部实现 */
async function generateCardImageInternal(opts: {
  ctx: UserContext
  enterpriseId: string
  card: { id: string; referenceImages: string[] }
  prompt: string
  apiId: string
  size: string
}): Promise<
  | { ok: true; cardImageId: string; generationTaskId: string }
  | { ok: false; error: string }
> {
  const { ctx, enterpriseId, card, prompt, apiId, size } = opts
  const ent = ctx.enterprise
  if (!ent) return { ok: false, error: "无企业归属" }
  // 空白卡片（无提示词）不可生图
  if (!prompt.trim()) return { ok: false, error: "提示词为空，请先填写提示词" }

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, apiId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInWorkspace) {
    return { ok: false, error: "模型不存在或不可用" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    return { ok: false, error: "无权使用该模型" }
  }
  // 平台预置模型按企业 visiblePresetModels 白名单校验（需求 2c）
  if (model.enterpriseId === null) {
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      return { ok: false, error: "该平台预置模型未对本企业开放" }
    }
  }
  const accessErr = checkModelAccess(ctx, apiId)
  if (accessErr) return { ok: false, error: accessErr }

  const cost = model.costPerImage
  if (ctx.user.creditsBalance < cost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${cost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 建图片行 + 任务 + 扣费 + 记账（单事务，任一步失败整体回滚）。此前
  // 分离提交，崩溃在中间窗口会出现「任务已建未扣费」（孤儿回收重新入队
  // = 免费生成）或「已扣费未记账」（失败退款按记账额少退）。
  let genTaskId: string
  let cardImageId: string
  try {
    const r = await db.transaction(async (tx) => {
      const [cardImage] = await tx
        .insert(cardImages)
        .values({
          enterpriseId,
          cardId: card.id,
          imageApiId: apiId,
          imageUrl: "",
          size,
          status: "pending",
          isSelected: false,
          generationPrompt: prompt,
          source: "generated",
        })
        .returning({ id: cardImages.id })

      const [genTask] = await tx
        .insert(generationTasks)
        .values({
          enterpriseId,
          userId: ctx.user.id,
          modelId: apiId,
          prompt,
          imageSize: size || "1024x1024",
          imageCount: 1,
          status: "queued",
          taskType: "workspace_single",
          source: "workspace",
          priority: ctx.group?.priority ?? 0,
          creditsCharged: 0,
          costPerImage: model.costPerImage, // 记录提交时单价（部分失败按张退款用）
          referenceImages:
            card.referenceImages.length > 0 ? card.referenceImages : null,
        })
        .returning({ id: generationTasks.id })

      await tx
        .update(cardImages)
        .set({ generationTaskId: genTask!.id, updatedAt: new Date() })
        .where(eq(cardImages.id, cardImage!.id))

      await deductUserCredits({
        enterpriseId,
        amount: cost,
        userId: ctx.user.id,
        taskId: genTask!.id,
        remark: `工作台生图 ${model.displayName} x1`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: cost })
        .where(eq(generationTasks.id, genTask!.id))
      return { cardImageId: cardImage!.id, genTaskId: genTask!.id }
    })
    cardImageId = r.cardImageId
    genTaskId = r.genTaskId
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  // 入队（Redis）。失败必须退款，否则用户积分已扣但任务永不处理。
  try {
    await enqueue({
      taskId: genTaskId,
      enterpriseId,
      modelId: apiId,
      prompt,
      imageSize: size || "1024x1024",
      imageCount: 1,
      referenceImages: card.referenceImages,
      priority: ctx.group?.priority ?? 0,
      costPerImage: model.costPerImage,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    // 入队失败（如 Redis 闪断）：退还积分并标记失败
    await refundFailedTask(genTaskId)
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "任务入队失败，积分已退还" })
      .where(eq(generationTasks.id, genTaskId))
    await db
      .update(cardImages)
      .set({
        status: "failed",
        errorMessage: "任务入队失败，积分已退还",
        updatedAt: new Date(),
      })
      .where(eq(cardImages.id, cardImageId))
    console.error(
      `[workspace] 任务 ${genTaskId} 入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return {
      ok: false,
      error: "任务入队失败，积分已退还，请稍后重试",
    }
  }

  return {
    ok: true,
    cardImageId,
    generationTaskId: genTaskId,
  }
}

/** 单卡生图 */
export async function generateCardImageAction(
  cardId: string,
  input: { prompt: string; apiId: string; size: string },
): Promise<{
  ok: boolean
  error: string | null
  cardImageId?: string
  generationTaskId?: string
}> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const res = await generateCardImageInternal({
    ctx,
    enterpriseId: scope.enterpriseId,
    card: { id: owned.card.id, referenceImages: owned.card.referenceImages },
    prompt: input.prompt,
    apiId: input.apiId,
    size: input.size,
  })
  if (!res.ok) return res
  revalidatePath("/workspace")
  return {
    ok: true,
    error: null,
    cardImageId: res.cardImageId,
    generationTaskId: res.generationTaskId,
  }
}

/** 重新生成卡片图片 */
export async function regenerateCardImageAction(
  cardId: string,
  input: { prompt: string; apiId: string; size: string },
): Promise<{
  ok: boolean
  error: string | null
  cardImageId?: string
  generationTaskId?: string
}> {
  return generateCardImageAction(cardId, input)
}

/** 获取卡片下所有图片 */
export async function getCardImagesAction(
  cardId: string,
): Promise<{ images: CardImageRow[]; referenceImages: string[] }> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { images: [], referenceImages: [] }
  const images = await db
    .select(cardImageSelectFields)
    .from(cardImages)
    .leftJoin(models, eq(cardImages.imageApiId, models.id))
    .leftJoin(
      generationTasks,
      eq(cardImages.generationTaskId, generationTasks.id),
    )
    .where(
      and(
        eq(cardImages.cardId, cardId),
        eq(cardImages.enterpriseId, scope.enterpriseId),
      ),
    )
    .orderBy(desc(cardImages.createdAt))
  return {
    images: images as CardImageRow[],
    referenceImages: owned.card.referenceImages,
  }
}

/** 选定图片（同卡其他取消选中） */
export async function selectCardImageAction(imageId: string) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const [img] = await db
    .select()
    .from(cardImages)
    .where(
      and(
        eq(cardImages.id, imageId),
        eq(cardImages.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!img) return { ok: false, error: "图片不存在" }

  const owned = await fetchOwnedCard(ctx, img.cardId)
  if (!owned) return { ok: false, error: "无权操作该卡片" }

  await db
    .update(cardImages)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(
      and(
        eq(cardImages.cardId, img.cardId),
        eq(cardImages.enterpriseId, scope.enterpriseId),
      ),
    )
  await db
    .update(cardImages)
    .set({ isSelected: true, updatedAt: new Date() })
    .where(eq(cardImages.id, imageId))
  await db
    .update(promptCards)
    .set({ selectedImageId: imageId, updatedAt: new Date() })
    .where(eq(promptCards.id, img.cardId))

  revalidatePath("/workspace")
  return { ok: true, error: null }
}

/** 更新卡片参考图（校验模型支持 + 数量上限） */
export async function updateCardReferenceImagesAction(
  cardId: string,
  input: { apiId: string; referenceImages: string[] },
) {
  const ctx = await requireUserContext()
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, input.apiId))
    .limit(1)
  if (!model) return { ok: false, error: "模型不存在" }
  if (!model.supportsReferenceImage) {
    return { ok: false, error: "该模型不支持参考图" }
  }
  const limit = getReferenceImageLimit(model)
  const normalized = normalizeReferenceImages(input.referenceImages)
  if (normalized.length > limit) {
    return { ok: false, error: `参考图数量超过上限（${limit}）` }
  }
  // 参考图归属校验（防跨租户引用 / 把上游 AI 当 SSRF 代理拉任意 URL）
  const refErr = await validateReferenceImageUrls(
    normalized,
    ctx.user.enterpriseId!,
  )
  if (refErr) return { ok: false, error: refErr }
  await db
    .update(promptCards)
    .set({ referenceImages: normalized, updatedAt: new Date() })
    .where(eq(promptCards.id, cardId))
  revalidatePath("/workspace")
  return { ok: true, error: null, referenceImages: normalized }
}

/** 添加上传图片记录 */
export async function addUploadedCardImageAction(
  cardId: string,
  input: { imageUrl: string },
) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const owned = await fetchOwnedCard(ctx, cardId)
  if (!owned) return { ok: false, error: "卡片不存在" }
  const imageUrl = input.imageUrl.trim()
  if (!imageUrl) return { ok: false, error: "图片地址无效" }
  // 图片归属校验：上传图 URL 会被参考图链路转给上游、被导出链路在服务端
  // 二次拉取，必须困在本企业上传的存储对象内（防 SSRF / 跨租户引用）
  const refErr = await validateReferenceImageUrls(
    [imageUrl],
    scope.enterpriseId,
  )
  if (refErr) return { ok: false, error: refErr }
  const [img] = await db
    .insert(cardImages)
    .values({
      enterpriseId: scope.enterpriseId,
      cardId,
      imageUrl,
      source: "uploaded",
      status: "completed",
      isSelected: false,
    })
    .returning()
  revalidatePath("/workspace")
  return { ok: true, error: null, imageId: img!.id }
}

// ═══════════════ 批量操作 ═══════════════

/** 批量生图 */
/**
 * 批量生图：模型校验 + 卡片归属校验各一次，总额一次扣费，
 * 批量 INSERT 任务/图片行 + pipeline 一次入队。
 * 相比逐卡串行（每卡 ~8 次 DB 往返 + 1 事务），100 卡从 ~800 次往返降到 ~8 次。
 * 扣费成功后的任一步失败：全额退款 + 已插入行批量置 failed（补偿语义）。
 */
export async function batchGenerateImageAction(
  cardIds: string[],
  input: {
    apiId: string
    size: string
    languagePreference?: BatchGenerationLanguage
  },
): Promise<{
  ok: boolean
  submitted: number
  tasks: Array<{
    cardId: string
    cardImageId: string
    generationTaskId: string
  }>
  errors: Array<{ cardId: string; error: string }>
}> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const enterpriseId = scope.enterpriseId
  const tasks: Array<{
    cardId: string
    cardImageId: string
    generationTaskId: string
  }> = []
  const errors: Array<{ cardId: string; error: string }> = []

  const uniqueIds = [...new Set(cardIds)]
  if (uniqueIds.length === 0) return { ok: true, submitted: 0, tasks, errors }

  // ── 模型查询 + 权限校验（整个批次只做一次，规则同 generateCardImageInternal）──
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, input.apiId))
    .limit(1)
  let modelError: string | null = null
  if (!model || !model.isActive || !model.visibleInWorkspace) {
    modelError = "模型不存在或不可用"
  } else if (model.enterpriseId !== null && model.enterpriseId !== enterpriseId) {
    modelError = "无权使用该模型"
  } else if (model.enterpriseId === null) {
    // 平台预置模型按企业 visiblePresetModels 白名单校验（需求 2c）
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      modelError = "该平台预置模型未对本企业开放"
    }
  }
  if (!modelError) modelError = checkModelAccess(ctx, input.apiId)
  if (modelError) {
    return {
      ok: true,
      submitted: 0,
      tasks,
      errors: uniqueIds.map((cardId) => ({ cardId, error: modelError! })),
    }
  }

  // ── 批量取归属卡片（一次查询复刻 fetchOwnedCard 的归属校验）──
  const ownedRows = await db
    .select({ card: promptCards })
    .from(promptCards)
    .innerJoin(workspaceTasks, eq(promptCards.taskId, workspaceTasks.id))
    .where(
      and(
        inArray(promptCards.id, uniqueIds),
        eq(promptCards.enterpriseId, enterpriseId),
        eq(workspaceTasks.userId, ctx.user.id),
      ),
    )
  const ownedMap = new Map(ownedRows.map((r) => [r.card.id, r.card]))

  // ── 内存中逐卡校验提示词 ──
  const valid: Array<{
    card: typeof promptCards.$inferSelect
    prompt: string
  }> = []
  for (const cardId of uniqueIds) {
    const card = ownedMap.get(cardId)
    if (!card) {
      errors.push({ cardId, error: "卡片不存在" })
      continue
    }
    const prompt = getGenerationPrompt(
      {
        prompt: card.prompt,
        translatedPrompt: card.translatedPrompt,
        displayLanguage: card.displayLanguage as "zh" | "en",
      },
      input.languagePreference,
    )
    if (!prompt.trim()) {
      errors.push({ cardId, error: "提示词为空，请先填写提示词" })
      continue
    }
    valid.push({ card, prompt })
  }
  if (valid.length === 0) return { ok: true, submitted: 0, tasks, errors }

  // ── 一次性总额扣费 + 建任务/图片行（单事务，任一步失败整体回滚）。
  // 此前先扣费提交、再插行：崩溃在中间窗口会出现「已扣费但无任务行」，
  // 退款与对账都无凭据。余额不足快速失败，什么都不写。
  const cost = model!.costPerImage
  const totalCost = cost * valid.length
  let insertedTaskIds: string[] = []
  let imageIdByCard = new Map<string, string>()
  try {
    const r = await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: null,
        remark: `工作台批量生图 ${model!.displayName} x${valid.length}`,
        tx,
      })

      // ── 批量 INSERT 任务行（creditsCharged 逐行记录，退款逻辑不变）──
      const insertedTasks = await tx
        .insert(generationTasks)
        .values(
          valid.map((v) => ({
            enterpriseId,
            userId: ctx.user.id,
            modelId: model!.id,
            prompt: v.prompt,
            imageSize: input.size || "1024x1024",
            imageCount: 1,
            status: "queued" as const,
            taskType: "workspace_single" as const,
            source: "workspace" as const,
            priority: ctx.group?.priority ?? 0,
            creditsCharged: cost,
            costPerImage: cost, // 记录提交时单价（部分失败按张退款用）
            referenceImages:
              v.card.referenceImages.length > 0 ? v.card.referenceImages : null,
          })),
        )
        .returning({ id: generationTasks.id })
      const taskIds = insertedTasks.map((t) => t.id)

      // ── 批量 INSERT 图片行，直接带 generationTaskId（省掉逐卡 UPDATE）──
      const insertedImages = await tx
        .insert(cardImages)
        .values(
          valid.map((v, i) => ({
            enterpriseId,
            cardId: v.card.id,
            generationTaskId: taskIds[i]!,
            imageApiId: model!.id,
            imageUrl: "",
            size: input.size,
            status: "pending" as const,
            isSelected: false,
            generationPrompt: v.prompt,
            source: "generated",
          })),
        )
        .returning({ id: cardImages.id, cardId: cardImages.cardId })

      return {
        taskIds,
        imageIdByCard: new Map(
          insertedImages.map((row) => [row.cardId, row.id] as const),
        ),
      }
    })
    insertedTaskIds = r.taskIds
    imageIdByCard = r.imageIdByCard
  } catch (err) {
    const msg = err instanceof Error ? err.message : "批量提交失败"
    console.error("[workspace] 批量生图扣费/建行失败（事务已回滚）:", msg)
    return {
      ok: true,
      submitted: 0,
      tasks: [],
      errors: valid.map((v) => ({ cardId: v.card.id, error: msg })),
    }
  }

  // ── pipeline 一次入队（事务外：Redis 不可用不能吞掉已落库的任务，
  // 失败走补偿——全额退款 + 已提交行批量置 failed）──
  try {
    await enqueueMany(
      valid.map((v, i) => ({
        taskId: insertedTaskIds[i]!,
        enterpriseId,
        modelId: model!.id,
        prompt: v.prompt,
        imageSize: input.size || "1024x1024",
        imageCount: 1,
        referenceImages: v.card.referenceImages,
        priority: ctx.group?.priority ?? 0,
        costPerImage: model!.costPerImage,
        apiTimeout: model!.apiTimeout,
        taskTimeout: model!.taskTimeout,
        maxRetries: model!.maxRetries,
      })),
    )

    const resultTasks = valid.map((v, i) => ({
      cardId: v.card.id,
      cardImageId: imageIdByCard.get(v.card.id)!,
      generationTaskId: insertedTaskIds[i]!,
    }))

    revalidatePath("/workspace")
    return { ok: true, submitted: valid.length, tasks: resultTasks, errors }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "批量提交失败"
    console.error("[workspace] 批量生图入队失败，执行补偿:", msg)
    // 全额退款 + 已插入行批量置 failed，保证积分与任务状态一致
    try {
      await refundUserCredits({
        enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: null,
        remark: `工作台批量生图失败退还 x${valid.length}`,
      })
    } catch (refundErr) {
      console.error(
        "[workspace] 批量生图退款失败（需人工对账）:",
        refundErr instanceof Error ? refundErr.message : refundErr,
      )
    }
    if (insertedTaskIds.length > 0) {
      await db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: `批量提交失败：${msg}` })
        .where(inArray(generationTasks.id, insertedTaskIds))
      await db
        .update(cardImages)
        .set({
          status: "failed",
          errorMessage: `批量提交失败：${msg}`,
          updatedAt: new Date(),
        })
        .where(inArray(cardImages.generationTaskId, insertedTaskIds))
    }
    return {
      ok: true,
      submitted: 0,
      tasks: [],
      errors: valid.map((v) => ({ cardId: v.card.id, error: msg })),
    }
  }
}

/** 批量细化（创建 chatTask，由 cron 处理） */
export async function batchDeepenAction(
  cardIds: string[],
  input: { templateId: string },
) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const submitted: string[] = []
  const errors: Array<{ cardId: string; error: string }> = []

  let tpl
  try {
    tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "deepen",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
  } catch (err) {
    return {
      ok: false,
      submitted: [] as string[],
      cardIds: [] as string[],
      errors: cardIds.map((cardId) => ({
        cardId,
        error: err instanceof Error ? err.message : "模板不可用",
      })),
    }
  }

  for (const cardId of cardIds) {
    const owned = await fetchOwnedCard(ctx, cardId)
    if (!owned) {
      errors.push({ cardId, error: "卡片不存在" })
      continue
    }
    await db.insert(chatTasks).values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      apiConfigId: tpl.chatApi.id ?? null,
      taskType: "deepen",
      cardId,
      workspaceTaskId: owned.task.id,
      templateId: tpl.id,
      originalPrompt: owned.card.prompt,
      status: "queued",
    })
    submitted.push(cardId)
  }

  revalidatePath("/workspace")
  return { ok: true, submitted, cardIds: submitted, errors }
}

/** 批量重生成提示词 */
export async function batchRegeneratePromptAction(
  cardIds: string[],
  input: { templateId: string },
) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const submitted: string[] = []
  const errors: Array<{ cardId: string; error: string }> = []

  let tpl
  try {
    tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "regenerate",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
  } catch (err) {
    return {
      ok: false,
      submitted: [] as string[],
      cardIds: [] as string[],
      errors: cardIds.map((cardId) => ({
        cardId,
        error: err instanceof Error ? err.message : "模板不可用",
      })),
    }
  }

  for (const cardId of cardIds) {
    const owned = await fetchOwnedCard(ctx, cardId)
    if (!owned) {
      errors.push({ cardId, error: "卡片不存在" })
      continue
    }
    await db.insert(chatTasks).values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      apiConfigId: tpl.chatApi.id ?? null,
      taskType: "regenerate",
      cardId,
      workspaceTaskId: owned.task.id,
      templateId: tpl.id,
      originalPrompt: owned.card.prompt,
      status: "queued",
    })
    submitted.push(cardId)
  }

  revalidatePath("/workspace")
  return { ok: true, submitted, cardIds: submitted, errors }
}

/** 批量翻译（跳过已有有效译文的卡片） */
export async function batchTranslatePromptAction(
  cardIds: string[],
  input: { templateId: string },
) {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const submitted: string[] = []
  const skippedCardIds: string[] = []
  const errors: Array<{ cardId: string; error: string }> = []

  let tpl
  try {
    tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "translate",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
  } catch (err) {
    return {
      ok: false,
      submitted: [] as string[],
      cardIds: [] as string[],
      skippedCardIds: [] as string[],
      errors: cardIds.map((cardId) => ({
        cardId,
        error: err instanceof Error ? err.message : "模板不可用",
      })),
    }
  }

  for (const cardId of cardIds) {
    const owned = await fetchOwnedCard(ctx, cardId)
    if (!owned) {
      errors.push({ cardId, error: "卡片不存在" })
      continue
    }
    const c = owned.card
    const hasValid =
      !!c.translatedPrompt &&
      c.translationSourcePrompt === c.prompt &&
      c.translationStatus === "synced"
    if (hasValid) {
      skippedCardIds.push(cardId)
      continue
    }
    await db.insert(chatTasks).values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      apiConfigId: tpl.chatApi.id ?? null,
      taskType: "translate",
      cardId,
      workspaceTaskId: owned.task.id,
      templateId: tpl.id,
      originalPrompt: c.prompt,
      status: "queued",
    })
    submitted.push(cardId)
  }

  revalidatePath("/workspace")
  return { ok: true, submitted, cardIds: submitted, skippedCardIds, errors }
}

/** 批量替换提示词 */
export async function batchReplacePromptsAction(
  taskId: string,
  input: {
    selectedCardIds: string[]
    items: Array<{ cardIndex: number; prompt: string }>
  },
): Promise<{
  ok: boolean
  updatedCount: number
  createdCount: number
  conflictCount: number
  cardCount: number
}> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) {
    return { ok: false, updatedCount: 0, createdCount: 0, conflictCount: 0, cardCount: 0 }
  }

  const allCards = await db
    .select({ id: promptCards.id, cardIndex: promptCards.cardIndex })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const selectedSet = new Set(input.selectedCardIds)
  const selectedIndexSet = new Set(
    allCards.filter((c) => selectedSet.has(c.id)).map((c) => c.cardIndex),
  )
  const allIndexSet = new Set(allCards.map((c) => c.cardIndex))

  let updatedCount = 0
  let createdCount = 0
  let conflictCount = 0

  for (const item of input.items) {
    const prompt = item.prompt.trim()
    if (!prompt) continue
    if (selectedIndexSet.has(item.cardIndex)) {
      const card = allCards.find(
        (c) => c.cardIndex === item.cardIndex && selectedSet.has(c.id),
      )
      if (card) {
        await db
          .update(promptCards)
          .set({
            prompt,
            translationStatus: "outdated",
            updatedAt: new Date(),
          })
          .where(eq(promptCards.id, card.id))
        updatedCount++
      }
    } else if (allIndexSet.has(item.cardIndex)) {
      conflictCount++
    } else {
      await db.insert(promptCards).values({
        enterpriseId: scope.enterpriseId,
        taskId,
        cardIndex: item.cardIndex,
        prompt,
      })
      createdCount++
      allIndexSet.add(item.cardIndex)
    }
  }

  const [countRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.taskId, taskId),
        eq(promptCards.enterpriseId, scope.enterpriseId),
      ),
    )
  const cardCount = Number(countRow?.c ?? 0)
  await db
    .update(workspaceTasks)
    .set({ cardCount, updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))

  revalidatePath("/workspace")
  return { ok: true, updatedCount, createdCount, conflictCount, cardCount }
}

/** 批量绑定上传图片到多张卡片（去重） */
export async function batchAttachUploadedImagesAction(
  cardIds: string[],
  imageUrls: string[],
): Promise<{
  ok: boolean
  updatedCardIds: string[]
  imagesByCard: Record<string, CardImageRow[]>
}> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const urls = normalizeReferenceImages(imageUrls)
  // 归属校验同 addUploadedCardImageAction：批量绑定前校验全部 URL，
  // 防止外域/跨租户 URL 借此落库（导出时会被服务端拉取，构成 SSRF）
  const refErr = await validateReferenceImageUrls(urls, scope.enterpriseId)
  if (refErr) return { ok: false, updatedCardIds: [], imagesByCard: {} }
  const updatedCardIds: string[] = []
  const imagesByCard: Record<string, CardImageRow[]> = {}

  for (const cardId of cardIds) {
    const owned = await fetchOwnedCard(ctx, cardId)
    if (!owned) continue
    const existing = await db
      .select({ imageUrl: cardImages.imageUrl })
      .from(cardImages)
      .where(
        and(
          eq(cardImages.cardId, cardId),
          eq(cardImages.enterpriseId, scope.enterpriseId),
          eq(cardImages.source, "uploaded"),
        ),
      )
    const existingSet = new Set(existing.map((e) => e.imageUrl))
    const toInsert = urls.filter((u) => !existingSet.has(u))
    if (toInsert.length === 0) continue
    const inserted = await db
      .insert(cardImages)
      .values(
        toInsert.map((url) => ({
          enterpriseId: scope.enterpriseId,
          cardId,
          imageUrl: url,
          source: "uploaded" as const,
          status: "completed" as const,
          isSelected: false,
        })),
      )
      .returning()
    updatedCardIds.push(cardId)
    imagesByCard[cardId] = inserted.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      generationTaskId: r.generationTaskId,
      generationPrompt: r.generationPrompt,
      imageApiId: r.imageApiId,
      imageUrl: r.imageUrl,
      modelName: null,
      size: r.size,
      format: r.format,
      status: r.status as CardImageRow["status"],
      errorMessage: r.errorMessage,
      isSelected: r.isSelected,
      source: r.source as CardImageRow["source"],
      generationStartedAt: null,
      generationCompletedAt: null,
      createdAt: r.createdAt,
    }))
  }

  revalidatePath("/workspace")
  return { ok: true, updatedCardIds, imagesByCard }
}

/** 提取编号提示词 */
export async function extractNumberedPromptsAction(
  taskId: string,
  input: { templateId: string; input: string },
): Promise<{
  ok: boolean
  error: string | null
  items: Array<{ cardIndex: number; prompt: string }>
}> {
  const ctx = await requireUserContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const task = await fetchOwnedTask(ctx, taskId)
  if (!task) return { ok: false, error: "任务不存在", items: [] }
  try {
    const tpl = await getExecutableTemplate({
      templateId: input.templateId,
      expectedType: "extract",
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      isAdmin: isEnterpriseAdmin(ctx),
    })
    const items = await extractNumberedPromptReplacements({
      config: tpl.chatApi,
      rawText: input.input,
      template: tpl.content,
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      workspaceTaskId: taskId,
      apiConfigId: tpl.chatApi.id,
      apiConfigName: tpl.chatApi.name,
    })
    return { ok: true, error: null, items }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "提取失败",
      items: [],
    }
  }
}

// ═══════════════ 模板管理 ═══════════════

/** 按类型查询模板（JOIN chatApiConfigs 获取 api_name） */
export async function listTemplatesAction(opts: {
  type: TemplateType
}): Promise<TemplateRow[]> {
  const ctx = await requireUserContext()
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
export async function listChatApisAction(): Promise<ChatApiOption[]> {
  const ctx = await requireUserContext()
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
    .orderBy(desc(chatApiConfigs.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    isPlatformPreset: r.enterpriseId === null,
  }))
}

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
export async function deleteTemplateAction(
  templateId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireUserContext()
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
export async function createExportTicketAction(
  taskId: string,
  input: { format: string; cardIds?: string[] },
): Promise<{ ok: boolean; error: string | null; downloadUrl?: string }> {
  const ctx = await requireUserContext()
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
export async function listChatApiConfigsAction() {
  const ctx = await requireUserContext()
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
export async function listPromptTemplatesAction(opts?: {
  type?: TemplateType
}) {
  const ctx = await requireUserContext()
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
export async function getQueueStatusAction(): Promise<{
  queued: number
  processing: number
}> {
  const ctx = await requireUserContext()
  if (!ctx.enterprise) return { queued: 0, processing: 0 }
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      status: generationTasks.status,
    })
    .from(generationTasks)
    .where(eq(generationTasks.enterpriseId, scope.enterpriseId))
  let queued = 0
  let processing = 0
  for (const r of rows) {
    if (r.status === "queued") queued++
    else if (r.status === "processing") processing++
  }
  return { queued, processing }
}
