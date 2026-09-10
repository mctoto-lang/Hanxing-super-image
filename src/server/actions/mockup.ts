"use server"

import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { after } from "next/server"
import { db } from "@/db/client"
import {
  generationTasks,
  mockupBatches,
  mockupCards,
  mockupDesignAssets,
  mockupGroupItems,
  mockupGroups,
  mockupTemplateExtras,
  models,
  productPromptTemplates,
  users,
  type MockupBindingConfig,
  type MockupBindingDef,
} from "@/db/schema"
import {
  getCurrentEnterpriseScope,
  requireEnterpriseContext,
  type UserContext,
} from "@/lib/auth/session"
import { checkModelAccess, checkModuleAccess, isEnterpriseAdmin } from "@/lib/auth/permissions"
import {
  MockupApiError,
  deleteExternalTemplate,
  getTemplate,
  listFonts,
  listTemplates,
  publishTemplate,
  regenerateTemplateThumbnail,
  saveLayerBindings,
  setExternalTemplateVisibility,
  type ExternalBindingDef,
  type ExternalFont,
  type ExternalLayerNode,
  type MockupUserContext,
} from "@/lib/mockup/client"
import { loadMockupConfig, type MockupEnterpriseConfig } from "@/lib/mockup/settings"
import { MOCKUP_DEFAULT_PROMPT_TEMPLATES } from "@/lib/mockup/prompt-defaults"
import {
  TEMPLATE_LIST_TTL_MS,
  invalidateTemplateListCache,
  templateListCache,
  templateListGeneration,
  templateListInflight,
} from "@/server/services/mockup-template-cache"
import { parseMockupAiInfo, parseMockupInfo, type MockupTaskInfo } from "@/lib/mockup/task-info"
import type {
  MockupAiImageView,
  MockupBackgroundTaskView,
  MockupBatchDetail,
  MockupBatchTaskView,
  MockupBatchView,
  MockupCardItemView,
  MockupCardView,
  MockupGroupItemView,
  MockupGroupManageView,
  MockupGroupView,
  MockupHistoryBatch,
  MockupCardHistoryView,
  MockupLibraryImage,
  MockupPageData,
  MockupStatusUpdate,
  RenderMockupResult,
} from "@/lib/mockup/types"
import { enqueue } from "@/lib/queue/task-queue"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { deductUserCredits, refundFailedTask } from "@/server/services/credits-service"
import {
  mockupRenderWebhookUrl,
  prewarmExternalAssets,
  submitExternalRenderJobsBatch,
  submitMockupTasksToExternal,
  syncMockupTasks,
} from "@/server/services/mockup-service"
import {
  addMockupDesignAssetSchema,
  applyMockupAiBackgroundSchema,
  createCardFromTemplateSchema,
  createMockupCardSchema,
  createMockupGroupSchema,
  MOCKUP_BATCH_MAX_TASKS,
  prewarmMockupAssetsSchema,
  renameMockupCardSchema,
  renderMockupCardsSchema,
  saveCardBindingsSchema,
  saveTemplateBindingsSchema,
  setMockupGroupVisibilitySchema,
  submitMockupBackgroundSchema,
  submitMockupBatchSchema,
  updateMockupGroupSchema,
} from "@/server/schemas/mockup"

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

function apiErrMsg(err: unknown, fallback: string): string {
  if (err instanceof MockupApiError) return err.message
  return err instanceof Error && err.message ? err.message : fallback
}

function moduleDenied(ctx: UserContext): string | null {
  return checkModuleAccess(ctx, "mockup")
}

/** 终端用户透传上下文（模板归属/私有可见性/渲染权限） */
function mockupUser(ctx: UserContext): MockupUserContext {
  return {
    id: ctx.user.id,
    admin: isEnterpriseAdmin(ctx),
  }
}

/** 用户 id → 显示名（昵称缺失回退登录账号） */
async function userNamesByIds(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(inArray(users.id, unique))
  return new Map(rows.map((r) => [r.id, r.name || r.username]))
}

/** 小模板本地扩展（背景绑定标记） */
async function loadBackgroundBindingIds(
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
async function toBindingSnapshot(
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
function overlayBackgroundRole(
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
function isItemConfigured(
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
async function loadMockupAiBackgroundPrompt(): Promise<string> {
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
async function latestRenderedImageUrl(
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
async function firstRenderedImageUrlAfter(
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
function groupVisibilityCondition(ctx: UserContext) {
  if (isEnterpriseAdmin(ctx)) return undefined
  return or(
    eq(mockupGroups.visibility, "public"),
    eq(mockupGroups.ownerUserId, ctx.user.id),
  )
}

export async function getMockupPageDataAction(): Promise<MockupPageData> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)

  const [groupRows, cards, designAssets] = await Promise.all([
    db
      .select({
        group: mockupGroups,
        ownerName: users.name,
        ownerUsername: users.username,
      })
      .from(mockupGroups)
      .leftJoin(users, eq(users.id, mockupGroups.ownerUserId))
      .where(
        and(
          eq(mockupGroups.enterpriseId, scope.enterpriseId),
          groupVisibilityCondition(ctx),
        ),
      )
      .orderBy(asc(mockupGroups.sortOrder), asc(mockupGroups.createdAt)),
    db
      .select()
      .from(mockupCards)
      .where(
        and(
          eq(mockupCards.enterpriseId, scope.enterpriseId),
          eq(mockupCards.userId, ctx.user.id),
        ),
      )
      .orderBy(desc(mockupCards.updatedAt)),
    db
      .select()
      .from(mockupDesignAssets)
      .where(
        and(
          eq(mockupDesignAssets.enterpriseId, scope.enterpriseId),
          eq(mockupDesignAssets.userId, ctx.user.id),
        ),
      )
      .orderBy(desc(mockupDesignAssets.createdAt))
      .limit(200),
  ])

  const groups = groupRows.map((r) => r.group)
  const items = groups.length
    ? await db
        .select()
        .from(mockupGroupItems)
        .where(
          inArray(
            mockupGroupItems.groupId,
            groups.map((g) => g.id),
          ),
        )
        .orderBy(asc(mockupGroupItems.sortOrder), asc(mockupGroupItems.createdAt))
    : []

  // 每方块的渲染任务（跨全部批次）：单方块渲染（含 AI背景落地重渲染）
  // 会更换整卡 lastBatchTag，按批次匹配会让其它方块退回占位态；按方块取
  // 最近一次任务 + 是否曾成功出图（hasRendered），支撑「仅首次渲染」判定
  const cardIds = cards.map((c) => c.id)
  const taskRows = cardIds.length
    ? await db
        .select()
        .from(generationTasks)
        .where(
          and(
            eq(generationTasks.taskType, "mockup"),
            eq(generationTasks.enterpriseId, scope.enterpriseId),
            eq(generationTasks.userId, ctx.user.id),
            inArray(sql`${generationTasks.templateInfo}->>'cardId'`, cardIds),
          ),
        )
        .orderBy(desc(generationTasks.createdAt))
        .limit(2000)
    : []

  // 批量取回各模板的背景标记，读取时校正快照（标记保存后不回写旧快照）
  const bgByTemplate = new Map<string, Set<string>>()
  const templateIds = [
    ...new Set(
      items
        .map((i) => i.externalTemplateId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  if (templateIds.length) {
    const extraRows = await db
      .select({
        templateId: mockupTemplateExtras.externalTemplateId,
        ids: mockupTemplateExtras.backgroundBindingIds,
      })
      .from(mockupTemplateExtras)
      .where(
        and(
          eq(mockupTemplateExtras.enterpriseId, scope.enterpriseId),
          inArray(mockupTemplateExtras.externalTemplateId, templateIds),
        ),
      )
    for (const row of extraRows) {
      bgByTemplate.set(row.templateId, new Set(row.ids ?? []))
    }
  }

  const itemsByGroup = new Map<string, MockupGroupItemView[]>()
  for (const item of items) {
    const bg = item.externalTemplateId
      ? bgByTemplate.get(item.externalTemplateId)
      : undefined
    const view: MockupGroupItemView = {
      id: item.id,
      displayName: item.displayName,
      templateVersionId: item.templateVersionId,
      externalTemplateId: item.externalTemplateId,
      canvasWidth: item.canvasWidth,
      canvasHeight: item.canvasHeight,
      bindings: bg
        ? overlayBackgroundRole(
            (item.bindings ?? []) as MockupBindingDef[],
            bg,
          )
        : ((item.bindings ?? []) as MockupBindingDef[]),
      sortOrder: item.sortOrder,
    }
    const list = itemsByGroup.get(item.groupId) ?? []
    list.push(view)
    itemsByGroup.set(item.groupId, list)
  }

  // 按方块聚合：最近一次任务（rows 已按 createdAt 倒序，首见即最新）+
  // 历史曾成功出图（仅首次渲染规则的判定基准）
  const latestTaskByItem = new Map<string, (typeof taskRows)[number]>()
  const renderedItems = new Set<string>()
  for (const task of taskRows) {
    const info = parseMockupInfo(task.templateInfo)
    if (!info) continue
    const key = `${info.cardId}:${info.groupItemId}`
    if (!latestTaskByItem.has(key)) latestTaskByItem.set(key, task)
    if (task.status === "completed" && task.resultImages?.[0]) {
      renderedItems.add(key)
    }
  }

  // 方块 AI 生成结果（AI背景/AI渲染 最近 8 张/方块）+ 未落地 AI背景兜底清单
  const aiRows = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "normal"),
        eq(generationTasks.source, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'kind' = 'mockup-ai'`,
        inArray(generationTasks.status, ["completed", "processing", "queued"]),
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(200)
  const aiImagesByItem = new Map<string, MockupAiImageView[]>()
  const aiGeneratingKeys = new Set<string>()
  const pendingAiApplies: MockupPageData["pendingAiApplies"] = []
  // 在途 AI 任务播种清单（页面刷新后前端恢复轮询；限 24h 内，防历史卡死任务永久轮询）
  const pendingAiTasks: MockupPageData["pendingAiTasks"] = []
  const aiSeedCutoff = Date.now() - 24 * 60 * 60 * 1000
  // 对比视图补充素材：每方块首个 AI背景落地时间（定位纯套版基准图）+
  // 已落地条目的落地时间（定位落地后首张重套样机渲染图）
  const firstAppliedByItem = new Map<
    string,
    { cardId: string; groupItemId: string; appliedAt: string }
  >()
  const appliedLookups: Array<{
    view: MockupAiImageView
    cardId: string
    groupItemId: string
    appliedAt: string
  }> = []
  for (const row of aiRows) {
    const info = parseMockupAiInfo(row.templateInfo)
    if (!info) continue
    const key = `${info.cardId}:${info.groupItemId}`
    // 进行中的 AI 生图任务 → 方块显示纯加载动画（页面刷新后仍可见）
    if (row.status === "queued" || row.status === "processing") {
      aiGeneratingKeys.add(key)
      // 下发在途任务播种前端轮询：队列重试窗口内刷新页面，重试成功仍能自动套版
      if (
        cards.some((c) => c.id === info.cardId) &&
        row.createdAt.getTime() >= aiSeedCutoff
      ) {
        pendingAiTasks.push({
          taskId: row.id,
          aiKind: info.aiKind,
          cardId: info.cardId,
          groupItemId: info.groupItemId,
        })
      }
      continue
    }
    const image = row.resultImages?.[0]
    if (row.status !== "completed" || !image) continue
    const list = aiImagesByItem.get(key) ?? []
    if (list.length < 8) {
      const view: MockupAiImageView = {
        taskId: row.id,
        aiKind: info.aiKind,
        imageUrl: image,
        refImageUrl: info.refImageUrl,
        prompt: row.prompt,
        createdAt: row.createdAt.toISOString(),
      }
      list.push(view)
      aiImagesByItem.set(key, list)
      if (info.aiKind === "background" && info.appliedAt) {
        appliedLookups.push({
          view,
          cardId: info.cardId,
          groupItemId: info.groupItemId,
          appliedAt: info.appliedAt,
        })
        const prev = firstAppliedByItem.get(key)
        if (!prev || info.appliedAt < prev.appliedAt) {
          firstAppliedByItem.set(key, {
            cardId: info.cardId,
            groupItemId: info.groupItemId,
            appliedAt: info.appliedAt,
          })
        }
      }
    }
    // AI背景已完成但未落地（浏览器中途关闭）→ 页面加载时续做
    if (
      info.aiKind === "background" &&
      !info.appliedAt &&
      cards.some((c) => c.id === info.cardId)
    ) {
      pendingAiApplies.push({
        taskId: row.id,
        cardId: info.cardId,
        groupItemId: info.groupItemId,
      })
    }
  }

  // 对比视图补充（仅当前卡片涉及的方块）：
  // 1) baselineUrl = 首个落地前最后一张完成渲染（纯样机套版，落地触发的
  //    重渲染 createdAt 恒晚于 appliedAt，天然被排除；后续手动渲染因背景
  //    绑定已填入 AI 图同样不纯，也一并排除）——refImageUrl 快照是提交时
  //    最新渲染，二次 AI背景迭代会带上前次 AI 结果，不能作左侧基准；
  // 2) appliedImageUrl = 落地后第一张完成渲染（重套样机效果比对项）
  for (const [key, first] of firstAppliedByItem) {
    if (!cards.some((c) => c.id === first.cardId)) continue
    const baseline = await latestRenderedImageUrl(
      scope.enterpriseId,
      ctx.user.id,
      first.cardId,
      first.groupItemId,
      new Date(first.appliedAt),
    )
    if (!baseline) continue
    for (const view of aiImagesByItem.get(key) ?? []) {
      view.baselineUrl = baseline
    }
  }
  const appliedQueried = new Set<string>()
  for (const lookup of appliedLookups) {
    if (!cards.some((c) => c.id === lookup.cardId)) continue
    const dedupe = `${lookup.cardId}:${lookup.groupItemId}:${lookup.appliedAt}`
    if (appliedQueried.has(dedupe)) continue
    appliedQueried.add(dedupe)
    const appliedImage = await firstRenderedImageUrlAfter(
      scope.enterpriseId,
      ctx.user.id,
      lookup.cardId,
      lookup.groupItemId,
      new Date(lookup.appliedAt),
    )
    if (appliedImage) lookup.view.appliedImageUrl = appliedImage
  }

  const groupViews: MockupGroupView[] = groupRows.map((row) => ({
    id: row.group.id,
    name: row.group.name,
    ownerUserId: row.group.ownerUserId,
    ownerName: row.ownerName || row.ownerUsername || "",
    visibility: row.group.visibility === "public" ? "public" : "private",
    autoGenerated: row.group.autoGenerated,
    items: itemsByGroup.get(row.group.id) ?? [],
  }))

  const cardViews: MockupCardView[] = cards.map((card) => {
    const groupItems = itemsByGroup.get(card.groupId) ?? []
    const config = (card.bindingConfig ?? {}) as MockupBindingConfig
    const cardItems: MockupCardItemView[] = groupItems.map((item) => {
      const task = latestTaskByItem.get(`${card.id}:${item.id}`)
      return {
        ...item,
        configured: isItemConfigured(item.bindings, config[item.id]),
        hasRendered: renderedItems.has(`${card.id}:${item.id}`),
        aiImages: aiImagesByItem.get(`${card.id}:${item.id}`) ?? [],
        aiGenerating: aiGeneratingKeys.has(`${card.id}:${item.id}`),
        task: task
          ? {
              taskId: task.id,
              status: task.status,
              progress: parseMockupInfo(task.templateInfo)?.progress ?? 0,
              stage: parseMockupInfo(task.templateInfo)?.stage ?? null,
              errorMessage: task.errorMessage,
              resultImage: task.resultImages?.[0] ?? null,
              batchTag: parseMockupInfo(task.templateInfo)?.batchTag ?? "",
              createdAt: task.createdAt.toISOString(),
            }
          : null,
      }
    })
    return {
      id: card.id,
      title: card.title,
      groupId: card.groupId,
      groupName: groups.find((g) => g.id === card.groupId)?.name ?? "",
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString(),
      bindingConfig: config,
      items: cardItems,
    }
  })

  return {
    available: cfg != null,
    costPerRender: cfg?.costPerRender ?? 0,
    groups: groupViews,
    cards: cardViews,
    designAssets: designAssets.map((a) => ({
      id: a.id,
      imageUrl: a.imageUrl,
      fileName: a.fileName,
    })),
    creditsBalance: ctx.user.creditsBalance,
    pendingAiApplies,
    pendingAiTasks,
  }
}

/* ═══════════════ 模板管理 · 外部小模板 ═══════════════ */

/**
 * 模板列表进程内短缓存：弹窗高频打开，避免每次实时回源渲染服务。
 * 按企业+查看者身份分区（成员=公开+自己的、管理员=全部，缓存不能串身份），
 * 管理员可见范围相同共享一桶；模板增删改后由变更 action 主动失效，
 * 失效时递增代际计数——在途回源若跨过失效点则不回写（防旧数据续命）。
 * 缓存实体在 services/mockup-template-cache.ts（PSD 上传路由也要失效同一份）。
 */

export async function listExternalTemplatesAction(): Promise<{
  ok: boolean
  error: string | null
  templates: Array<{
    templateId: string
    name: string
    code: string
    status: string
    statusLabel: string
    published: boolean
    latestVersion: number
    hasThumbnail: boolean
    visibility: "public" | "private"
    ownerUserId: string | null
    ownerName: string | null
    createdAt: string
  }>
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) {
    return { ok: false, error: "无权访问样机模块", templates: [] }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", templates: [] }

  const user = mockupUser(ctx)
  // 缓存键按企业+查看者身份分区：成员各一桶（公开+自己的），管理员共享一桶
  const key = `${scope.enterpriseId}:${user.admin ? "admin" : user.id}`
  const cached = templateListCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const pending = templateListInflight.get(key)
  if (pending) return pending

  const genAtStart = templateListGeneration.get(scope.enterpriseId) ?? 0
  const load = (async () => {
    try {
      // X-User-Id/X-User-Admin 透传：外部按归属过滤（成员=公开+自己的，管理员=全部）
      const templates = await listTemplates(cfg, user)
      const nameMap = await userNamesByIds(templates.map((t) => t.ownerUserId))
      const value = {
        ok: true as const,
        error: null,
        templates: templates.map((t) => ({
          templateId: t.templateId,
          name: t.name,
          code: t.code,
          status: t.status,
          statusLabel: t.statusLabel,
          published: t.published,
          latestVersion: t.latestVersion,
          hasThumbnail: Boolean(t.thumbnailObjectKey),
          // 缩略图预签名直链：local 模式为相对地址，按 apiBaseUrl 绝对化
          //（与渲染结果 resultUrl 同模式）；旧版 PS-API 无此字段时为 undefined，
          // 前端回退鉴权代理路由
          thumbnailUrl: t.thumbnailUrl
            ? t.thumbnailUrl.startsWith("/")
              ? `${cfg.apiBaseUrl}${t.thumbnailUrl}`
              : t.thumbnailUrl
            : null,
          visibility: t.visibility === "private" ? ("private" as const) : ("public" as const),
          ownerUserId: t.ownerUserId,
          ownerName: t.ownerUserId ? (nameMap.get(t.ownerUserId) ?? null) : null,
          createdAt: t.createdAt,
        })),
      }
      // 回源期间发生模板变更（代际已变）则不回写，避免旧列表再活一个 TTL
      if ((templateListGeneration.get(scope.enterpriseId) ?? 0) === genAtStart) {
        templateListCache.set(key, {
          expiresAt: Date.now() + TEMPLATE_LIST_TTL_MS,
          value,
        })
      }
      return value
    } catch (err) {
      return {
        ok: false as const,
        error: apiErrMsg(err, "模板列表获取失败"),
        templates: [],
      }
    } finally {
      templateListInflight.delete(key)
    }
  })()
  templateListInflight.set(key, load)
  return load
}

/**
 * 模板详情（图层树 + 绑定 + 画布 + 背景标记），绑定编辑器/批量替换数据源。
 * 可查看 = 外部可见（公开或归属人或管理员，外部按 X-User 透传过滤）。
 */
export async function getExternalTemplateDetailAction(
  templateId: string,
): Promise<{
  ok: boolean
  error: string | null
  detail: null | {
    templateId: string
    name: string
    status: string
    versionId: string | null
    published: boolean
    canvasWidth: number | null
    canvasHeight: number | null
    layerTree: ExternalLayerNode[]
    bindings: MockupBindingDef[]
    backgroundBindingIds: string[]
  }
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) {
    return { ok: false, error: "无权访问样机模块", detail: null }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", detail: null }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) {
    return { ok: false, error: "参数错误", detail: null }
  }
  try {
    const user = mockupUser(ctx)
    const detail = await getTemplate(cfg, templateId, user)
    const v = detail.latestVersion
    const background = await loadBackgroundBindingIds(
      scope.enterpriseId,
      templateId,
    )
    return {
      ok: true,
      error: null,
      detail: {
        templateId: detail.templateId,
        name: detail.name,
        status: detail.status,
        versionId: v?.versionId ?? null,
        published: v?.published ?? false,
        canvasWidth: v?.canvas.width ?? null,
        canvasHeight: v?.canvas.height ?? null,
        layerTree: v?.layerTree ?? [],
        bindings: (v?.layerSchema.bindings ?? []).map((b) => ({
          bindingId: b.bindingId,
          layerId: b.layerId,
          layerPath: b.layerPath,
          type: b.type,
          required: b.required ?? true,
          label: b.label ?? b.bindingId,
          fit: b.fit ?? "stretch",
          ...(background.includes(b.bindingId)
            ? { role: "background" as const }
            : {}),
        })),
        backgroundBindingIds: background,
      },
    }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板详情获取失败"), detail: null }
  }
}

/** 校验当前用户可管理该小模板（归属人或企业管理员；平台共享模板仅管理员） */
async function requireTemplateManageable(
  cfg: MockupEnterpriseConfig,
  ctx: UserContext,
  templateId: string,
): Promise<string | null> {
  if (isEnterpriseAdmin(ctx)) return null
  const templates = await listTemplates(cfg, mockupUser(ctx))
  const hit = templates.find((t) => t.templateId === templateId)
  if (!hit) return "模板不存在或无权访问"
  if (hit.ownerUserId === ctx.user.id) return null
  return "仅模板归属人或企业管理员可操作"
}

/** PSD 上传 + 解析（创建 DRAFT 模板，返回图层树供绑定编辑） */
/** 保存绑定配置（可选同时发布）；背景标记存本地扩展表 */
/** 绑定结构归一化（顺序无关，仅比较编辑器可写字段）：判断是否只改了
 * 本地背景标记而未动绑定结构（已发布版本的结构外部 API 不可修改） */
function normalizeBindingsForCompare(
  bindings: Array<{
    bindingId: string
    layerId: number
    layerPath: string
    type: string
    required: boolean
    label?: string
    fit: string
    defaultFontVersionId?: string
  }>,
): string {
  return JSON.stringify(
    bindings
      .map((b) => ({
        bindingId: b.bindingId,
        layerId: b.layerId,
        layerPath: b.layerPath,
        type: b.type,
        required: b.required,
        label: b.label ?? "",
        fit: b.fit,
        defaultFontVersionId: b.defaultFontVersionId ?? "",
      }))
      .sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
  )
}

export async function saveTemplateBindingsAction(input: {
  templateId: string
  bindings: unknown
  publish: boolean
  backgroundBindingIds?: string[]
}): Promise<{ ok: boolean; error: string | null; unchanged?: boolean }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const parsed = saveTemplateBindingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }

  const denied = await requireTemplateManageable(
    cfg,
    ctx,
    parsed.data.templateId,
  )
  if (denied) return { ok: false, error: denied }

  // 背景标记必须在绑定列表内
  const bindingIds = new Set(parsed.data.bindings.map((b) => b.bindingId))
  const background = parsed.data.backgroundBindingIds.filter((id) =>
    bindingIds.has(id),
  )

  try {
    const user = mockupUser(ctx)
    // 已发布版本的绑定结构外部 API 不可改：仅调整本地背景标记（结构未变）
    // 时跳过外部保存与发布；结构有变且已发布则直接给出明确指引
    const detail = await getTemplate(cfg, parsed.data.templateId, user)
    const currentBindings = detail.latestVersion?.layerSchema.bindings ?? []
    const published = detail.latestVersion?.published ?? false
    const unchanged =
      normalizeBindingsForCompare(currentBindings) ===
      normalizeBindingsForCompare(parsed.data.bindings)
    if (published) {
      if (!unchanged) {
        return {
          ok: false,
          error:
            "模板已发布，不能修改绑定结构；如需调整请重新上传 PSD 生成新版本（仅调整背景标记可直接保存）",
        }
      }
    } else {
      await saveLayerBindings(
        cfg,
        parsed.data.templateId,
        parsed.data.bindings,
        user,
      )
      if (parsed.data.publish) {
        await publishTemplate(cfg, parsed.data.templateId, user)
      }
    }
    await db
      .insert(mockupTemplateExtras)
      .values({
        enterpriseId: scope.enterpriseId,
        externalTemplateId: parsed.data.templateId,
        backgroundBindingIds: background,
      })
      .onConflictDoUpdate({
        target: [
          mockupTemplateExtras.enterpriseId,
          mockupTemplateExtras.externalTemplateId,
        ],
        set: {
          backgroundBindingIds: background,
          updatedAt: new Date(),
        },
      })
    // unchanged=true 表示外部已发布版本未动，仅保存了本地背景标记
    invalidateTemplateListCache(scope.enterpriseId)
    return { ok: true, error: null, unchanged: published && unchanged }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "绑定保存失败") }
  }
}

/** 手动补生成模板缩略图（解析时未成功的兜底） */
export async function regenerateTemplateThumbnailAction(
  templateId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) {
    return { ok: false, error: "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }
  const denied = await requireTemplateManageable(cfg, ctx, templateId)
  if (denied) return { ok: false, error: denied }
  try {
    await regenerateTemplateThumbnail(cfg, templateId, mockupUser(ctx))
    invalidateTemplateListCache(scope.enterpriseId)
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "缩略图生成失败") }
  }
}

/** 删除小模板（外部软删除；本地清套组成员与卡片，历史渲染任务/批次保留） */
export async function deleteExternalTemplateAction(
  templateId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) {
    return { ok: false, error: "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }
  const denied = await requireTemplateManageable(cfg, ctx, templateId)
  if (denied) return { ok: false, error: denied }

  try {
    await deleteExternalTemplate(cfg, templateId, mockupUser(ctx))
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板删除失败") }
  }

  // 本地关联清理：该模板的套组成员（按企业范围内的套组限定；卡片是套组级
  // 实例，bindingConfig 残留 key 无害——渲染按套组当前成员迭代）与模板扩展表；
  // 历史渲染任务/批次保留
  await db
    .delete(mockupGroupItems)
    .where(
      and(
        eq(mockupGroupItems.externalTemplateId, templateId),
        inArray(
          mockupGroupItems.groupId,
          db
            .select({ id: mockupGroups.id })
            .from(mockupGroups)
            .where(eq(mockupGroups.enterpriseId, scope.enterpriseId)),
        ),
      ),
    )
  await db
    .delete(mockupTemplateExtras)
    .where(
      and(
        eq(mockupTemplateExtras.externalTemplateId, templateId),
        eq(mockupTemplateExtras.enterpriseId, scope.enterpriseId),
      ),
    )

  invalidateTemplateListCache(scope.enterpriseId)
  revalidatePath("/mockup")
  return { ok: true, error: null }
}

/** 修改小模板可见性（编辑绑定弹窗内即时生效） */
export async function setExternalTemplateVisibilityAction(input: {
  templateId: string
  visibility: "public" | "private"
}): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.templateId)) {
    return { ok: false, error: "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }
  const denied = await requireTemplateManageable(cfg, ctx, input.templateId)
  if (denied) return { ok: false, error: denied }
  try {
    await setExternalTemplateVisibility(
      cfg,
      input.templateId,
      input.visibility,
      mockupUser(ctx),
    )
    invalidateTemplateListCache(scope.enterpriseId)
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "可见性设置失败") }
  }
}

/* ═══════════════ 大模板套组（分组 CRUD，归属人写 / 成员读） ═══════════════ */

/** 字体库列表（全局共享；文字绑定选择 defaultFontVersionId 用） */
export async function listMockupFontsAction(): Promise<{
  ok: boolean
  error: string | null
  fonts: ExternalFont[]
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块", fonts: [] }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", fonts: [] }
  try {
    return { ok: true, error: null, fonts: await listFonts(cfg) }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "字体列表获取失败"), fonts: [] }
  }
}

/** 从外部模板详情快照成员信息（版本钉住 + 绑定定义抄录 + 背景角色合并） */
async function snapshotGroupItem(
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
async function loadTemplateVisibilityMap(
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
function validateGroupMembers(
  visibilityMap: Map<string, { visibility: "public" | "private"; ownerUserId: string | null }>,
  templateIds: string[],
  visibility: "public" | "private",
): string | null {
  for (const id of templateIds) {
    const t = visibilityMap.get(id)
    if (!t) return `所选小模板不存在或无权使用（${id}）`
    if (visibility === "public" && t.visibility !== "public") {
      return "公开大模板要求所有成员小模板均为公开，请先将成员设为公开或改用私有"
    }
  }
  return null
}

export async function createMockupGroupAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
  groupId: string | null
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块", groupId: null }
  const parsed = createMockupGroupSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "参数错误",
      groupId: null,
    }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", groupId: null }

  const user = mockupUser(ctx)
  try {
    const visibilityMap = await loadTemplateVisibilityMap(cfg, user)
    const templateIds = parsed.data.items.map((i) => i.templateId)
    const denied = validateGroupMembers(
      visibilityMap,
      templateIds,
      parsed.data.visibility,
    )
    if (denied) return { ok: false, error: denied, groupId: null }

    // 逐个模板取外部详情快照（失败即中止，不建半截套组）
    const snapshotResults: Array<typeof mockupGroupItems.$inferInsert> = []
    for (const itemInput of parsed.data.items) {
      const snap = await snapshotGroupItem(cfg, scope.enterpriseId, itemInput, user)
      if (!snap.ok) return { ok: false, error: snap.error, groupId: null }
      snapshotResults.push(snap.item)
    }

    const [group] = await db
      .insert(mockupGroups)
      .values({
        enterpriseId: scope.enterpriseId,
        ownerUserId: ctx.user.id,
        name: parsed.data.name,
        visibility: parsed.data.visibility,
        sortOrder: 0,
      })
      .returning({ id: mockupGroups.id })
    await db.insert(mockupGroupItems).values(
      snapshotResults.map((item) => ({ ...item, groupId: group!.id })),
    )

    revalidatePath("/mockup")
    return { ok: true, error: null, groupId: group!.id }
  } catch (err) {
    return {
      ok: false,
      error: apiErrMsg(err, "模板信息获取失败"),
      groupId: null,
    }
  }
}

export async function updateMockupGroupAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const parsed = updateMockupGroupSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }

  const [group] = await db
    .select()
    .from(mockupGroups)
    .where(
      and(
        eq(mockupGroups.id, parsed.data.id),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!group) return { ok: false, error: "大模板不存在" }
  if (!isEnterpriseAdmin(ctx) && group.ownerUserId !== ctx.user.id) {
    return { ok: false, error: "仅归属人或企业管理员可编辑" }
  }

  const user = mockupUser(ctx)
  try {
    const visibilityMap = await loadTemplateVisibilityMap(cfg, user)
    const templateIds = parsed.data.items.map((i) => i.templateId)
    const denied = validateGroupMembers(
      visibilityMap,
      templateIds,
      parsed.data.visibility,
    )
    if (denied) return { ok: false, error: denied }

    const snapshotResults: Array<typeof mockupGroupItems.$inferInsert> = []
    for (const itemInput of parsed.data.items) {
      const snap = await snapshotGroupItem(cfg, scope.enterpriseId, itemInput, user)
      if (!snap.ok) return { ok: false, error: snap.error }
      snapshotResults.push(snap.item)
    }

    await db
      .update(mockupGroups)
      .set({
        name: parsed.data.name,
        visibility: parsed.data.visibility,
        updatedAt: new Date(),
      })
      .where(eq(mockupGroups.id, group.id))
    // 重建成员（旧 groupItemId 变更后，卡片上失效项由 configured/渲染校验兜底）
    await db.delete(mockupGroupItems).where(eq(mockupGroupItems.groupId, group.id))
    await db.insert(mockupGroupItems).values(
      snapshotResults.map((item) => ({ ...item, groupId: group.id })),
    )

    revalidatePath("/mockup")
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板信息获取失败") }
  }
}

/** 切换大模板可见性（公开需成员小模板全部公开） */
export async function setMockupGroupVisibilityAction(
  input: unknown,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const parsed = setMockupGroupVisibilitySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }

  const [group] = await db
    .select({ id: mockupGroups.id, ownerUserId: mockupGroups.ownerUserId })
    .from(mockupGroups)
    .where(
      and(
        eq(mockupGroups.id, parsed.data.groupId),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!group) return { ok: false, error: "大模板不存在" }
  if (!isEnterpriseAdmin(ctx) && group.ownerUserId !== ctx.user.id) {
    return { ok: false, error: "仅归属人或企业管理员可修改" }
  }

  if (parsed.data.visibility === "public") {
    const items = await db
      .select({ externalTemplateId: mockupGroupItems.externalTemplateId })
      .from(mockupGroupItems)
      .where(eq(mockupGroupItems.groupId, group.id))
    try {
      const visibilityMap = await loadTemplateVisibilityMap(cfg, mockupUser(ctx))
      const denied = validateGroupMembers(
        visibilityMap,
        items.map((i) => i.externalTemplateId),
        "public",
      )
      if (denied) return { ok: false, error: denied }
    } catch (err) {
      return { ok: false, error: apiErrMsg(err, "模板信息获取失败") }
    }
  }

  await db
    .update(mockupGroups)
    .set({ visibility: parsed.data.visibility, updatedAt: new Date() })
    .where(eq(mockupGroups.id, group.id))
  revalidatePath("/mockup")
  return { ok: true, error: null }
}

export async function deleteMockupGroupAction(
  groupId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const scope = getCurrentEnterpriseScope(ctx)

  const [group] = await db
    .select({ id: mockupGroups.id, ownerUserId: mockupGroups.ownerUserId })
    .from(mockupGroups)
    .where(
      and(
        eq(mockupGroups.id, groupId),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!group) return { ok: false, error: "大模板不存在" }
  if (!isEnterpriseAdmin(ctx) && group.ownerUserId !== ctx.user.id) {
    return { ok: false, error: "仅归属人或企业管理员可删除" }
  }

  // 套组下的卡片级联删除（FK cascade），历史渲染任务保留在资产页
  await db.delete(mockupGroups).where(eq(mockupGroups.id, group.id))

  revalidatePath("/mockup")
  return { ok: true, error: null }
}

/** 模板管理-大模板列表（搜索 + 归属人 + 可见性 + 卡片数） */
export async function listMockupGroupsManageAction(
  q?: string,
): Promise<{
  ok: boolean
  error: string | null
  groups: MockupGroupManageView[]
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块", groups: [] }
  const scope = getCurrentEnterpriseScope(ctx)

  const keyword = q?.trim()
  const rows = await db
    .select({
      group: mockupGroups,
      ownerName: users.name,
      ownerUsername: users.username,
    })
    .from(mockupGroups)
    .leftJoin(users, eq(users.id, mockupGroups.ownerUserId))
    .where(
      and(
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
        groupVisibilityCondition(ctx),
        keyword ? ilike(mockupGroups.name, `%${keyword}%`) : undefined,
      ),
    )
    .orderBy(desc(mockupGroups.updatedAt))
    .limit(100)

  if (rows.length === 0) return { ok: true, error: null, groups: [] }

  const groupIds = rows.map((r) => r.group.id)
  const [items, cardCounts] = await Promise.all([
    db
      .select()
      .from(mockupGroupItems)
      .where(inArray(mockupGroupItems.groupId, groupIds))
      .orderBy(asc(mockupGroupItems.sortOrder), asc(mockupGroupItems.createdAt)),
    db
      .select({
        groupId: mockupCards.groupId,
        count: sql<number>`count(*)::int`,
      })
      .from(mockupCards)
      .where(
        and(
          eq(mockupCards.enterpriseId, scope.enterpriseId),
          inArray(mockupCards.groupId, groupIds),
        ),
      )
      .groupBy(mockupCards.groupId),
  ])
  const countByGroup = new Map(cardCounts.map((c) => [c.groupId, c.count]))

  return {
    ok: true,
    error: null,
    groups: rows.map((row) => ({
      id: row.group.id,
      name: row.group.name,
      visibility: row.group.visibility === "public" ? "public" : "private",
      autoGenerated: row.group.autoGenerated,
      ownerUserId: row.group.ownerUserId,
      ownerName: row.ownerName || row.ownerUsername || "",
      updatedAt: row.group.updatedAt.toISOString(),
      cardCount: countByGroup.get(row.group.id) ?? 0,
      items: items
        .filter((i) => i.groupId === row.group.id)
        .map((i) => ({
          id: i.id,
          displayName: i.displayName,
          externalTemplateId: i.externalTemplateId,
          templateVersionId: i.templateVersionId,
        })),
    })),
  }
}

/* ═══════════════ 渲染卡片（个人工作区） ═══════════════ */

export async function createMockupCardAction(groupId: string): Promise<{
  ok: boolean
  error: string | null
  cardId: string | null
}> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块", cardId: null }
  const parsed = createMockupCardSchema.safeParse({ groupId })
  if (!parsed.success) {
    return { ok: false, error: "参数错误", cardId: null }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", cardId: null }

  const [group] = await db
    .select({ id: mockupGroups.id, name: mockupGroups.name })
    .from(mockupGroups)
    .where(
      and(
        eq(mockupGroups.id, parsed.data.groupId),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
        groupVisibilityCondition(ctx),
      ),
    )
    .limit(1)
  if (!group) return { ok: false, error: "大模板不存在或不可见", cardId: null }

  const [card] = await db
    .insert(mockupCards)
    .values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      groupId: group.id,
      title: group.name,
    })
    .returning({ id: mockupCards.id })

  revalidatePath("/mockup")
  return { ok: true, error: null, cardId: card!.id }
}

/**
 * 从小模板直接建卡：复用（同人同模板的）自动建组，否则创建单成员套组
 * （autoGenerated=true，可见性随小模板），再建卡片。
 */
export async function createCardFromTemplateAction(input: {
  templateId: string
  title?: string
}): Promise<{ ok: boolean; error: string | null; cardId: string | null }> {
  const ctx = await requireEnterpriseContext()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块", cardId: null }
  const parsed = createCardFromTemplateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误", cardId: null }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", cardId: null }

  const user = mockupUser(ctx)
  let templateName = ""
  let visibility: "public" | "private" = "public"
  try {
    const detail = await getTemplate(cfg, parsed.data.templateId, user)
    const version = detail.latestVersion
    if (!version || !version.published) {
      return { ok: false, error: "该小模板未发布，不能创建卡片", cardId: null }
    }
    templateName = detail.name
    const visibilityMap = await loadTemplateVisibilityMap(cfg, user)
    visibility = visibilityMap.get(parsed.data.templateId)?.visibility ?? "public"
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板信息获取失败"), cardId: null }
  }

  // 复用本人同模板的自动建组
  const existing = await db
    .select({ groupId: mockupGroups.id })
    .from(mockupGroupItems)
    .innerJoin(mockupGroups, eq(mockupGroups.id, mockupGroupItems.groupId))
    .where(
      and(
        eq(mockupGroupItems.externalTemplateId, parsed.data.templateId),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
        eq(mockupGroups.ownerUserId, ctx.user.id),
        eq(mockupGroups.autoGenerated, true),
      ),
    )
    .limit(1)

  let groupId = existing[0]?.groupId
  if (!groupId) {
    const snap = await snapshotGroupItem(
      cfg,
      scope.enterpriseId,
      { templateId: parsed.data.templateId, sortOrder: 0 },
      user,
    )
    if (!snap.ok) return { ok: false, error: snap.error, cardId: null }
    const [group] = await db
      .insert(mockupGroups)
      .values({
        enterpriseId: scope.enterpriseId,
        ownerUserId: ctx.user.id,
        name: templateName,
        visibility,
        autoGenerated: true,
        sortOrder: 0,
      })
      .returning({ id: mockupGroups.id })
    groupId = group!.id
    await db
      .insert(mockupGroupItems)
      .values({ ...snap.item, groupId })
  }

  const [card] = await db
    .insert(mockupCards)
    .values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      groupId,
      title: parsed.data.title?.trim() || templateName,
    })
    .returning({ id: mockupCards.id })

  revalidatePath("/mockup")
  return { ok: true, error: null, cardId: card!.id }
}

export async function deleteMockupCardAction(
  cardId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const deleted = await db
    .delete(mockupCards)
    .where(
      and(
        eq(mockupCards.id, cardId),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
    .returning({ id: mockupCards.id, groupId: mockupCards.groupId })
  if (deleted.length === 0) return { ok: false, error: "卡片不存在" }

  // 自动建组：最后一张卡片删除后清理空组（历史任务保留）
  const [group] = await db
    .select({ autoGenerated: mockupGroups.autoGenerated })
    .from(mockupGroups)
    .where(eq(mockupGroups.id, deleted[0]!.groupId))
    .limit(1)
  if (group?.autoGenerated) {
    const [left] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mockupCards)
      .where(eq(mockupCards.groupId, deleted[0]!.groupId))
    if ((left?.count ?? 0) === 0) {
      await db.delete(mockupGroups).where(eq(mockupGroups.id, deleted[0]!.groupId))
    }
  }

  revalidatePath("/mockup")
  return { ok: true, error: null }
}

export async function renameMockupCardAction(input: {
  cardId: string
  title: string
}): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  const parsed = renameMockupCardSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const updated = await db
    .update(mockupCards)
    .set({ title: parsed.data.title, updatedAt: new Date() })
    .where(
      and(
        eq(mockupCards.id, parsed.data.cardId),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
    .returning({ id: mockupCards.id })
  if (updated.length === 0) return { ok: false, error: "卡片不存在" }
  revalidatePath("/mockup")
  return { ok: true, error: null }
}

/** 保存卡片上某小模板的绑定配置 */
export async function saveCardBindingsAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
}> {
  const ctx = await requireEnterpriseContext()
  const parsed = saveCardBindingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)

  const [card] = await db
    .select()
    .from(mockupCards)
    .where(
      and(
        eq(mockupCards.id, parsed.data.cardId),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!card) return { ok: false, error: "卡片不存在" }

  // 图片 URL 归属校验（防跨租户引用 / SSRF）
  const imageUrls = Object.values(parsed.data.bindings)
    .map((b) => b.imageUrl)
    .filter((u): u is string => Boolean(u))
  if (imageUrls.length > 0) {
    const err = await validateReferenceImageUrls(
      imageUrls,
      scope.enterpriseId,
    )
    if (err) return { ok: false, error: err }
  }

  const config = { ...((card.bindingConfig ?? {}) as MockupBindingConfig) }
  config[parsed.data.groupItemId] = parsed.data.bindings
  await db
    .update(mockupCards)
    .set({ bindingConfig: config, updatedAt: new Date() })
    .where(eq(mockupCards.id, card.id))

  revalidatePath("/mockup")
  return { ok: true, error: null }
}

/** 卡片历史批次（弹窗数据） */
export async function listCardHistoryAction(cardId: string): Promise<{
  ok: boolean
  error: string | null
  batches: MockupHistoryBatch[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [card] = await db
    .select({ id: mockupCards.id, groupId: mockupCards.groupId })
    .from(mockupCards)
    .where(
      and(
        eq(mockupCards.id, cardId),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!card) return { ok: false, error: "卡片不存在", batches: [] }

  const [items, tasks] = await Promise.all([
    db
      .select()
      .from(mockupGroupItems)
      .where(eq(mockupGroupItems.groupId, card.groupId))
      .orderBy(asc(mockupGroupItems.sortOrder)),
    db
      .select()
      .from(generationTasks)
      .where(
        and(
          eq(generationTasks.taskType, "mockup"),
          eq(generationTasks.enterpriseId, scope.enterpriseId),
          eq(generationTasks.userId, ctx.user.id),
          sql`${generationTasks.templateInfo}->>'cardId' = ${cardId}`,
        ),
      )
      .orderBy(desc(generationTasks.createdAt))
      .limit(120),
  ])
  const nameByItem = new Map(items.map((i) => [i.id, i.displayName]))

  const batchMap = new Map<string, MockupHistoryBatch>()
  for (const task of tasks) {
    const info = parseMockupInfo(task.templateInfo)
    if (!info) continue
    let batch = batchMap.get(info.batchTag)
    if (!batch) {
      batch = {
        batchTag: info.batchTag,
        createdAt: task.createdAt.toISOString(),
        tasks: [],
      }
      batchMap.set(info.batchTag, batch)
    }
    batch.tasks.push({
      taskId: task.id,
      groupItemId: info.groupItemId ?? "",
      displayName:
        nameByItem.get(info.groupItemId ?? "") ?? info.templateName ?? "样机",
      status: task.status,
      resultImage: task.resultImages?.[0] ?? null,
      errorMessage: task.errorMessage,
      createdAt: task.createdAt.toISOString(),
    })
  }
  return { ok: true, error: null, batches: [...batchMap.values()] }
}

/** 生成历史：按渲染卡片聚合当前用户全部生成图片（不含批量替换），按最近出图倒序 */
export async function listAllCardHistoryAction(): Promise<{
  ok: boolean
  error: string | null
  cards: MockupCardHistoryView[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const taskRows = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'cardId' IS NOT NULL`,
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(500)

  const entries = taskRows
    .map((task) => ({ task, info: parseMockupInfo(task.templateInfo) }))
    .filter((e): e is { task: (typeof taskRows)[number]; info: NonNullable<ReturnType<typeof parseMockupInfo>> } =>
      e.info !== null && typeof e.info.cardId === "string",
    )

  const cardIds = [
    ...new Set(entries.map((e) => e.info.cardId as string)),
  ]
  const itemIds = [
    ...new Set(
      entries
        .map((e) => e.info.groupItemId)
        .filter((v): v is string => typeof v === "string"),
    ),
  ]
  const cardRows = cardIds.length
    ? await db
        .select({ id: mockupCards.id, groupId: mockupCards.groupId })
        .from(mockupCards)
        .where(inArray(mockupCards.id, cardIds))
    : []
  const groupRows = cardRows.length
    ? await db
        .select({ id: mockupGroups.id, name: mockupGroups.name })
        .from(mockupGroups)
        .where(
          inArray(
            mockupGroups.id,
            [...new Set(cardRows.map((c) => c.groupId))],
          ),
        )
    : []
  const itemRows = itemIds.length
    ? await db
        .select({ id: mockupGroupItems.id, displayName: mockupGroupItems.displayName })
        .from(mockupGroupItems)
        .where(inArray(mockupGroupItems.id, itemIds))
    : []

  const groupByCard = new Map(cardRows.map((c) => [c.id, c.groupId]))
  const nameByGroup = new Map(groupRows.map((g) => [g.id, g.name]))
  const nameByItem = new Map(itemRows.map((i) => [i.id, i.displayName]))

  const cardMap = new Map<string, MockupCardHistoryView>()
  for (const { task, info } of entries) {
    let card = cardMap.get(info.cardId!)
    if (!card) {
      const groupId = groupByCard.get(info.cardId!)
      card = {
        cardId: info.cardId!,
        groupName: groupId ? (nameByGroup.get(groupId) ?? "") : "",
        images: [],
        latestAt: task.createdAt.toISOString(),
        processing: false,
      }
      cardMap.set(info.cardId!, card)
    }
    if (task.status === "queued" || task.status === "processing") {
      card.processing = true
      continue
    }
    const resultImage = task.resultImages?.[0]
    if (task.status === "completed" && resultImage) {
      card.images.push({
        taskId: task.id,
        displayName:
          nameByItem.get(info.groupItemId ?? "") ?? info.templateName ?? "样机",
        resultImage,
        createdAt: task.createdAt.toISOString(),
      })
    }
  }

  // 过滤没有成功出图的卡片；latestAt 取最新一张出图时间（任务本身倒序，首张即最新）
  const cards = [...cardMap.values()]
    .filter((c) => c.images.length > 0)
    .map((c) => ({ ...c, latestAt: c.images[0]!.createdAt }))
  return { ok: true, error: null, cards }
}

/* ═══════════════ 图片库 ═══════════════ */

export async function addMockupDesignAssetAction(input: {
  imageUrl: string
  fileName?: string
}): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseContext()
  const parsed = addMockupDesignAssetSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const err = await validateReferenceImageUrls(
    [parsed.data.imageUrl],
    scope.enterpriseId,
  )
  if (err) return { ok: false, error: err }

  await db
    .insert(mockupDesignAssets)
    .values({
      enterpriseId: scope.enterpriseId,
      userId: ctx.user.id,
      imageUrl: parsed.data.imageUrl,
      fileName: parsed.data.fileName ?? null,
    })
    .onConflictDoNothing()
  return { ok: true, error: null }
}

export async function deleteMockupDesignAssetAction(id: string): Promise<{
  ok: boolean
  error: string | null
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const deleted = await db
    .delete(mockupDesignAssets)
    .where(
      and(
        eq(mockupDesignAssets.id, id),
        eq(mockupDesignAssets.enterpriseId, scope.enterpriseId),
        eq(mockupDesignAssets.userId, ctx.user.id),
      ),
    )
    .returning({ id: mockupDesignAssets.id })
  if (deleted.length === 0) return { ok: false, error: "图片不存在" }
  return { ok: true, error: null }
}

/**
 * 素材预导入：把本项目存储图片提前转为外部渲染素材（填充 assetId 缓存）。
 * 图片库上传后与批量替换选图时调用，提交渲染时即免外部拉图等待；失败静默
 * 由调用方处理（提交路径仍有懒导入兜底）。
 */
export async function prewarmMockupAssetsAction(input: {
  imageUrls: string[]
}): Promise<{
  ok: boolean
  error: string | null
  results: Array<{ url: string; ok: boolean; error?: string }>
}> {
  const ctx = await requireEnterpriseContext()
  const parsed = prewarmMockupAssetsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误", results: [] }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) {
    return { ok: false, error: "样机渲染服务未配置", results: [] }
  }
  const err = await validateReferenceImageUrls(parsed.data.imageUrls, scope.enterpriseId)
  if (err) return { ok: false, error: err, results: [] }
  const results = await prewarmExternalAssets(cfg, scope.enterpriseId, parsed.data.imageUrls)
  return { ok: true, error: null, results }
}

/** 「我的上传」图片库列表（批量替换页选固定图用） */
export async function listMockupDesignAssetsAction(limit = 200): Promise<{
  ok: boolean
  images: MockupLibraryImage[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select()
    .from(mockupDesignAssets)
    .where(
      and(
        eq(mockupDesignAssets.enterpriseId, scope.enterpriseId),
        eq(mockupDesignAssets.userId, ctx.user.id),
      ),
    )
    .orderBy(desc(mockupDesignAssets.createdAt))
    .limit(Math.min(Math.max(limit, 1), 300))
  return {
    ok: true,
    images: rows.map((r) => ({
      id: r.id,
      imageUrl: r.imageUrl,
      fileName: r.fileName,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

/** 生成图资产（本人最近生图任务结果，图片库第二个 Tab；个人维度，与 /assets 口径一致） */
export async function listGeneratedAssetsAction(limit = 200): Promise<{
  ok: boolean
  images: MockupLibraryImage[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: generationTasks.id,
      resultImages: generationTasks.resultImages,
      createdAt: generationTasks.createdAt,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        eq(generationTasks.status, "completed"),
        isNull(generationTasks.deletedAt),
        sql`${generationTasks.resultImages} IS NOT NULL`,
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(Math.min(Math.max(limit, 1), 300))

  const images: MockupLibraryImage[] = []
  for (const row of rows) {
    for (const [idx, url] of (row.resultImages ?? []).entries()) {
      images.push({
        id: `${row.id}:${idx}`,
        imageUrl: url,
        fileName: null,
        createdAt: row.createdAt.toISOString(),
        taskId: row.id,
      })
      if (images.length >= limit) break
    }
    if (images.length >= limit) break
  }
  return { ok: true, images }
}

/* ═══════════════ 渲染提交与状态 ═══════════════ */

interface ReadyItem {
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
async function renderInternal(
  ctx: UserContext,
  cardIds: string[],
  onlyGroupItemId?: string,
  opts?: {
    allowCompleted?: boolean
    outputFormat?: MockupTaskInfo["outputFormat"]
  },
): Promise<RenderMockupResult> {
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  const renderUser = mockupUser(ctx)
  if (!cfg) {
    return {
      ok: false,
      error: "样机渲染服务未配置，请联系平台管理员",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }

  const cards = await db
    .select()
    .from(mockupCards)
    .where(
      and(
        inArray(mockupCards.id, cardIds),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
  if (cards.length === 0) {
    return {
      ok: false,
      error: "卡片不存在",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }

  const items = await db
    .select()
    .from(mockupGroupItems)
    .where(
      inArray(
        mockupGroupItems.groupId,
        cards.map((c) => c.groupId),
      ),
    )
    .orderBy(asc(mockupGroupItems.sortOrder))
  const itemsByGroup = new Map<string, typeof items>()
  for (const item of items) {
    const list = itemsByGroup.get(item.groupId) ?? []
    list.push(item)
    itemsByGroup.set(item.groupId, list)
  }

  // 「仅首次渲染」过滤基准：曾成功出图 / 渲染中的方块集合（跨全部批次）
  const renderedKeys = new Set<string>()
  const busyKeys = new Set<string>()
  if (!opts?.allowCompleted) {
    const historyRows = await db
      .select({
        status: generationTasks.status,
        resultImages: generationTasks.resultImages,
        templateInfo: generationTasks.templateInfo,
      })
      .from(generationTasks)
      .where(
        and(
          eq(generationTasks.taskType, "mockup"),
          eq(generationTasks.enterpriseId, scope.enterpriseId),
          eq(generationTasks.userId, ctx.user.id),
          inArray(
            sql`${generationTasks.templateInfo}->>'cardId'`,
            cards.map((c) => c.id),
          ),
        ),
      )
      .orderBy(desc(generationTasks.createdAt))
      .limit(2000)
    for (const row of historyRows) {
      const info = parseMockupInfo(row.templateInfo)
      if (!info) continue
      const key = `${info.cardId}:${info.groupItemId}`
      if (row.status === "completed" && row.resultImages?.[0]) {
        renderedKeys.add(key)
      } else if (row.status === "queued" || row.status === "processing") {
        busyKeys.add(key)
      }
    }
  }

  // 逐项校验必填绑定
  const ready: ReadyItem[] = []
  const skipped: RenderMockupResult["skipped"] = []
  for (const card of cards) {
    const config = (card.bindingConfig ?? {}) as MockupBindingConfig
    for (const item of itemsByGroup.get(card.groupId) ?? []) {
      if (onlyGroupItemId && item.id !== onlyGroupItemId) continue
      if (!opts?.allowCompleted) {
        if (renderedKeys.has(`${card.id}:${item.id}`)) {
          skipped.push({
            cardId: card.id,
            displayName: item.displayName,
            reason: "已渲染出图，不可重复渲染",
          })
          continue
        }
        if (busyKeys.has(`${card.id}:${item.id}`)) {
          skipped.push({
            cardId: card.id,
            displayName: item.displayName,
            reason: "渲染中，请等待完成",
          })
          continue
        }
      }
      const defs = (item.bindings ?? []) as MockupBindingDef[]
      const settings = config[item.id] ?? {}
      const input: ReadyItem["input"] = {}
      const missing: string[] = []
      for (const def of defs) {
        const value = settings[def.bindingId]
        if (def.type === "text") {
          const text = value?.text?.trim()
          if (text) input[def.bindingId] = { text }
          else if (def.required) missing.push(def.label || def.bindingId)
        } else {
          const imageUrl = value?.imageUrl
          if (imageUrl) input[def.bindingId] = { imageUrl }
          else if (def.required) missing.push(def.label || def.bindingId)
        }
      }
      if (missing.length > 0) {
        skipped.push({
          cardId: card.id,
          displayName: item.displayName,
          reason: `缺少：${missing.join("、")}`,
        })
        continue
      }
      ready.push({
        cardId: card.id,
        groupItemId: item.id,
        displayName: item.displayName,
        templateVersionId: item.templateVersionId,
        canvasWidth: item.canvasWidth,
        canvasHeight: item.canvasHeight,
        input,
      })
    }
  }

  if (ready.length === 0) {
    return {
      ok: true,
      error: null,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped,
      cost: 0,
    }
  }

  const totalCost = ready.length * cfg.costPerRender
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped,
      cost: totalCost,
    }
  }

  // 建任务 + 扣费 + 记账（单事务，任一步失败整体回滚）。此前三步分离
  // 提交，崩溃在中间窗口会出现「任务已建未扣费」（孤儿回收/双通道同步
  // 判失败退款时无费可退 = 免费渲染）或「已扣费未记账」（退款按记账额
  // 少退）。（status=queued，未提交外部前无 externalJobId）
  const batchTag = randomUUID().replace(/-/g, "").slice(0, 16)
  const imageUrls = [
    ...new Set(
      ready.flatMap((r) =>
        Object.values(r.input)
          .map((v) => v.imageUrl)
          .filter((u): u is string => Boolean(u)),
      ),
    ),
  ]
  let createdTasks: Array<{ id: string; taskUuid: string; item: ReadyItem }>
  try {
    createdTasks = await db.transaction(async (tx) => {
      const rows: Array<{ id: string; taskUuid: string; item: ReadyItem }> = []
      for (const item of ready) {
        const taskUuid = randomUUID().replace(/-/g, "")
        const [task] = await tx
          .insert(generationTasks)
          .values({
            enterpriseId: scope.enterpriseId,
            userId: ctx.user.id,
            prompt: `样机渲染 · ${item.displayName}`,
            imageSize:
              item.canvasWidth && item.canvasHeight
                ? `${item.canvasWidth}x${item.canvasHeight}`
                : null,
            imageCount: 1,
            status: "queued",
            taskType: "mockup",
            source: "mockup",
            priority: ctx.group?.priority ?? 0,
            creditsCharged: 0,
            costPerImage: cfg.costPerRender,
            referenceImages: imageUrls.length > 0 ? imageUrls : null,
            taskUuid,
            templateInfo: {
              kind: "mockup",
              cardId: item.cardId,
              groupItemId: item.groupItemId,
              templateVersionId: item.templateVersionId,
              templateName: item.displayName,
              batchTag,
              input: item.input,
              outputFormat: opts?.outputFormat ?? "png",
            },
          })
          .returning({ id: generationTasks.id })
        rows.push({ id: task!.id, taskUuid, item })
      }

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: rows[0]!.id,
        remark: `样机渲染 x${rows.length}`,
        tx,
      })

      for (const r of rows) {
        await tx
          .update(generationTasks)
          .set({ creditsCharged: cfg.costPerRender })
          .where(eq(generationTasks.id, r.id))
      }
      return rows
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped,
      cost: totalCost,
    }
  }

  // 批量提交外部（一次 HTTP；旧版服务/单项素材失效自动回退逐个）；单个失败即退款该张
  let submitted = 0
  const failedSubmits: RenderMockupResult["failedSubmits"] = []
  const submitResults = await submitExternalRenderJobsBatch(
    cfg,
    scope.enterpriseId,
    {
      items: createdTasks.map((t) => ({
        templateVersionId: t.item.templateVersionId,
        input: t.item.input,
        idempotencyKey: t.taskUuid,
        outputFormat: opts?.outputFormat,
      })),
      user: renderUser,
      webhookUrl: mockupRenderWebhookUrl(cfg, scope.enterpriseId),
    },
  )
  for (let i = 0; i < createdTasks.length; i++) {
    const t = createdTasks[i]!
    const result = submitResults[i]!
    if (result.ok) {
      await db
        .update(generationTasks)
        .set({
          status: "processing",
          startedAt: new Date(),
          templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{externalJobId}', ${JSON.stringify(result.externalJobId)}::jsonb)`,
        })
        .where(eq(generationTasks.id, t.id))
      submitted++
    } else {
      // result.message 已是可读字符串（service 层产出的具体原因），直接透传；
      // 勿过 apiErrMsg（它只认 Error 实例，传字符串会恒回落兜底文案）
      const message = result.message || "提交渲染失败"
      await db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: message, completedAt: new Date() })
        .where(eq(generationTasks.id, t.id))
      await refundFailedTask(t.id)
      failedSubmits.push({ displayName: t.item.displayName, message })
    }
  }

  // 更新涉及卡片最近批次
  const cardIdsTouched = [...new Set(createdTasks.map((t) => t.item.cardId))]
  await db
    .update(mockupCards)
    .set({ lastBatchTag: batchTag, updatedAt: new Date() })
    .where(inArray(mockupCards.id, cardIdsTouched))

  revalidatePath("/mockup")
  return {
    ok: true,
    error: null,
    batchTag,
    submitted,
    failedSubmits,
    skipped,
    cost: totalCost,
  }
}

/** 渲染一张/多张卡片（顶部「渲染」= 传入全部卡片 ID） */
export async function renderMockupCardsAction(
  cardIds: string[],
  outputFormat?: MockupTaskInfo["outputFormat"],
): Promise<RenderMockupResult> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) {
    return {
      ok: false,
      error: denied,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }
  const parsed = renderMockupCardsSchema.safeParse({ cardIds, outputFormat })
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "参数错误",
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }
  return renderInternal(ctx, parsed.data.cardIds, undefined, {
    outputFormat: parsed.data.outputFormat,
  })
}

/** 仅渲染卡片上的一个小模板（图层替换弹窗内触发） */
export async function renderCardItemAction(
  cardId: string,
  groupItemId: string,
  outputFormat?: MockupTaskInfo["outputFormat"],
): Promise<RenderMockupResult> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) {
    return {
      ok: false,
      error: denied,
      batchTag: null,
      submitted: 0,
      failedSubmits: [],
      skipped: [],
      cost: 0,
    }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  // 最近一次渲染失败（如 AI背景落地后的自动重渲染失败）→ 放行重试，
  // 否则会被「仅首次渲染」规则以「已渲染出图」为由跳过
  const [latest] = await db
    .select({ status: generationTasks.status })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'cardId' = ${cardId}`,
        sql`${generationTasks.templateInfo}->>'groupItemId' = ${groupItemId}`,
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(1)
  return renderInternal(ctx, [cardId], groupItemId, {
    outputFormat,
    allowCompleted: latest?.status === "failed",
  })
}

/** 轮询：我在途任务实时状态（透传外部进度，终态即时收敛） */
export async function getMockupStatusAction(): Promise<{
  ok: boolean
  updates: MockupStatusUpdate[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const active = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        inArray(generationTasks.status, ["queued", "processing"]),
      ),
    )
    .limit(60)

  // 双通道收敛：轮询时顺带推进（外部终态 → 落库 + 退款）；
  // 一次批量查询外部状态（旧版服务自动回退逐个）
  await syncMockupTasks(active)

  const ids = active.map((t) => t.id)
  const rows = ids.length
    ? await db
        .select()
        .from(generationTasks)
        .where(inArray(generationTasks.id, ids))
    : []

  const updates: MockupStatusUpdate[] = []
  for (const task of rows) {
    const info = parseMockupInfo(task.templateInfo)
    if (!info) continue
    updates.push({
      taskId: task.id,
      cardId: info.cardId,
      groupItemId: info.groupItemId,
      batchTag: info.batchTag,
      status: task.status,
      progress: info.progress ?? 0,
      stage: info.stage ?? null,
      errorMessage: task.errorMessage,
      resultImage: task.resultImages?.[0] ?? null,
    })
  }
  return { ok: true, updates }
}

/* ═══════════════ 批量替换（小模板级） ═══════════════ */

/** 批量替换页初始数据 */
export async function getMockupBatchPageDataAction(): Promise<{
  available: boolean
  costPerRender: number
  creditsBalance: number
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  return {
    available: cfg != null,
    costPerRender: cfg?.costPerRender ?? 0,
    creditsBalance: ctx.user.creditsBalance,
  }
}

/**
 * 提交批量替换批次：
 * 固定绑定（背景图/固定文字）+ 逐任务轮换的图片/文字（第 i 张图 + 第 i 行文字）
 * → 建批次 + N 个 mockup 任务 → 整批扣费 → after() 后台提交外部
 * （素材中转 + createRenderJob 不占用户请求；失败任务条件更新 failed+退款，
 * 进度与失败明细经生成历史/批次详情轮询可见）。
 */
export async function submitMockupBatchAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
  batchId: string | null
  submitted: number
  failedSubmits: Array<{ displayName: string; message: string }>
  cost: number
}> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) {
    return { ok: false, error: denied, batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }
  const parsed = submitMockupBatchSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "参数错误",
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: 0,
    }
  }
  const d = parsed.data
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) {
    return { ok: false, error: "样机渲染服务未配置", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }

  // 任务数 = 轮换图片数（未配图片则以文字行数为准）；多组图片必须等长
  const imageEntries = Object.entries(d.batchImages)
  const textEntries = Object.entries(d.batchTexts)
  let count = 0
  if (imageEntries.length > 0) {
    count = imageEntries[0]![1].length
    if (imageEntries.some(([, urls]) => urls.length !== count)) {
      return { ok: false, error: "多个轮换图片绑定的文件数不一致", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
  } else {
    count = textEntries[0]![1].length
    if (textEntries.some(([, texts]) => texts.length !== count)) {
      return { ok: false, error: "多个轮换文字绑定的行数不一致", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
  }
  if (count === 0 || count > MOCKUP_BATCH_MAX_TASKS) {
    return {
      ok: false,
      error: `单批次任务数须在 1~${MOCKUP_BATCH_MAX_TASKS} 之间（当前 ${count}）`,
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: 0,
    }
  }
  if (d.labels && d.labels.length !== count) {
    return { ok: false, error: "任务标签数与任务数不一致", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }

  // 模板可见 + 已发布，快照绑定（含背景角色）
  const user = mockupUser(ctx)
  let displayName = ""
  let templateVersionId = ""
  let defs: MockupBindingDef[] = []
  try {
    const detail = await getTemplate(cfg, d.templateId, user)
    const version = detail.latestVersion
    if (!version || !version.published) {
      return { ok: false, error: "该小模板未发布，不能批量替换", batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
    displayName = detail.name
    templateVersionId = version.versionId
    defs = await toBindingSnapshot(scope.enterpriseId, d.templateId, version.layerSchema.bindings)
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板信息获取失败"), batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
  }

  // 组装每个任务的 input 并校验绑定/必填
  const defMap = new Map(defs.map((b) => [b.bindingId, b]))
  const knownBindingIds = new Set(
    [...Object.keys(d.fixed), ...Object.keys(d.batchImages), ...Object.keys(d.batchTexts)].filter((id) => defMap.has(id)),
  )
  for (const id of [...Object.keys(d.fixed), ...Object.keys(d.batchImages), ...Object.keys(d.batchTexts)]) {
    if (!defMap.has(id)) {
      return { ok: false, error: `绑定 ${id} 不存在于该模板`, batchId: null, submitted: 0, failedSubmits: [], cost: 0 }
    }
  }

  const imageUrls = [
    ...new Set([
      ...Object.values(d.fixed).flatMap((v) => (v.imageUrl ? [v.imageUrl] : [])),
      ...imageEntries.flatMap(([, urls]) => urls),
    ]),
  ]
  const urlErr = await validateReferenceImageUrls(imageUrls, scope.enterpriseId)
  if (urlErr) return { ok: false, error: urlErr, batchId: null, submitted: 0, failedSubmits: [], cost: 0 }

  const taskInputs: Array<{ input: Record<string, { imageUrl?: string; text?: string }>; label: string }> = []
  for (let i = 0; i < count; i++) {
    const input: Record<string, { imageUrl?: string; text?: string }> = {}
    for (const [bindingId, value] of Object.entries(d.fixed)) {
      if (!knownBindingIds.has(bindingId)) continue
      if (value.imageUrl) input[bindingId] = { imageUrl: value.imageUrl }
      else if (value.text?.trim()) input[bindingId] = { text: value.text.trim() }
    }
    for (const [bindingId, urls] of imageEntries) {
      if (urls[i]) input[bindingId] = { imageUrl: urls[i] }
    }
    for (const [bindingId, texts] of textEntries) {
      const text = texts[i]?.trim()
      if (text) input[bindingId] = { text }
    }
    // 必填校验（第 i 张）
    const missing = defs
      .filter((def) => {
        if (!def.required) return false
        const value = input[def.bindingId]
        if (def.type === "text") return !value?.text
        return !value?.imageUrl
      })
      .map((def) => def.label || def.bindingId)
    if (missing.length > 0) {
      return {
        ok: false,
        error: `第 ${i + 1} 张缺少必填绑定：${missing.join("、")}`,
        batchId: null,
        submitted: 0,
        failedSubmits: [],
        cost: 0,
      }
    }
    taskInputs.push({ input, label: d.labels?.[i] ?? `第 ${i + 1} 张` })
  }

  const totalCost = count * cfg.costPerRender
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: totalCost,
    }
  }

  // 建批次 + 任务 + 扣费 + 记账（单事务，任一步失败整体回滚，批次行也
  // 一并回滚，无需手工清理）。此前分离提交，崩溃在中间窗口会出现「任务
  // 已建未扣费」（孤儿清扫判失败时无费可退 = 免费渲染）或「已扣费未记
  // 账」（退款按记账额少退）。
  const taskUuids = taskInputs.map(() => randomUUID().replace(/-/g, ""))
  let batchId: string
  let createdTasks: Array<{
    id: string
    taskUuid: string
    input: Record<string, { imageUrl?: string; text?: string }>
  }>
  try {
    const r = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(mockupBatches)
        .values({
          enterpriseId: scope.enterpriseId,
          userId: ctx.user.id,
          externalTemplateId: d.templateId,
          templateVersionId,
          displayName,
          bindings: defs,
          fixedConfig: d.fixed,
          totalCount: count,
        })
        .returning({ id: mockupBatches.id })
      const bid = batch!.id
      const batchTag = bid.replace(/-/g, "").slice(0, 32)

      // 一次多行 INSERT 建全部任务（按 taskUuid 映射回填 id）
      const inserted = await tx
        .insert(generationTasks)
        .values(
          taskInputs.map((t, i) => ({
            enterpriseId: scope.enterpriseId,
            userId: ctx.user.id,
            prompt: `样机批量替换 · ${displayName} · ${t.label}`,
            imageCount: 1,
            status: "queued" as const,
            taskType: "mockup" as const,
            source: "mockup" as const,
            priority: ctx.group?.priority ?? 0,
            creditsCharged: 0,
            costPerImage: cfg.costPerRender,
            referenceImages: imageUrls.length > 0 ? imageUrls : null,
            taskUuid: taskUuids[i]!,
            templateInfo: {
              kind: "mockup",
              batchId: bid,
              batchIndex: i + 1,
              batchLabel: t.label,
              templateVersionId,
              templateName: displayName,
              batchTag,
              input: t.input,
              outputFormat: parsed.data.outputFormat,
            },
          })),
        )
        .returning({ id: generationTasks.id, taskUuid: generationTasks.taskUuid })
      const idByUuid = new Map(inserted.map((row) => [row.taskUuid, row.id]))
      const rows = taskInputs.map((t, i) => ({
        id: idByUuid.get(taskUuids[i]!)!,
        taskUuid: taskUuids[i]!,
        input: t.input,
      }))

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: rows[0]!.id,
        remark: `样机批量替换 x${count}`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: cfg.costPerRender })
        .where(inArray(generationTasks.id, rows.map((row) => row.id)))
      return { batchId: bid, createdTasks: rows }
    })
    batchId = r.batchId
    createdTasks = r.createdTasks
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
      batchId: null,
      submitted: 0,
      failedSubmits: [],
      cost: totalCost,
    }
  }

  // 后台提交外部（after()：响应返回后执行，素材中转/批量创建不再占住用户
  // 请求——大批量素材导入可达数分钟）。失败任务由 service 条件更新到
  // failed+退款并写 api 日志；提交中断（进程退出等）由孤儿清扫 10 分钟
  // 宽限兜底判失败退款；幂等键 = taskUuid，重复提交不会重复渲染。
  after(async () => {
    try {
      await submitMockupTasksToExternal(cfg, scope.enterpriseId, {
        tasks: createdTasks.map((t) => ({
          id: t.id,
          idempotencyKey: t.taskUuid,
          input: t.input,
        })),
        templateVersionId,
        outputFormat: parsed.data.outputFormat,
        user,
        webhookUrl: mockupRenderWebhookUrl(cfg, scope.enterpriseId),
        labels: taskInputs.map((t) => t.label),
      })
    } catch (err) {
      // 整批提交异常（网络全断/DB 故障等）：任务留在 queued，孤儿清扫宽限
      // 后判失败退款；这里只记日志便于排查
      console.error("[mockup] 批量任务后台提交异常:", err)
    }
  })

  revalidatePath("/mockup/batch")
  return {
    ok: true,
    error: null,
    batchId,
    submitted: createdTasks.length,
    failedSubmits: [],
    cost: totalCost,
  }
}

/** 批次任务行 → 视图（计数聚合共用） */
function toBatchTaskView(
  task: typeof generationTasks.$inferSelect,
): MockupBatchTaskView {
  const info = parseMockupInfo(task.templateInfo)
  return {
    taskId: task.id,
    batchIndex: info?.batchIndex ?? 0,
    label: info?.batchLabel ?? `第 ${(info?.batchIndex ?? 0)} 张`,
    status: task.status,
    progress: info?.progress ?? 0,
    stage: info?.stage ?? null,
    errorMessage: task.errorMessage,
    resultImage: task.resultImages?.[0] ?? null,
  }
}

/** 我的批次列表（任务计数实时聚合） */
export async function listMockupBatchesAction(): Promise<{
  ok: boolean
  error: string | null
  batches: MockupBatchView[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const rows = await db
    .select()
    .from(mockupBatches)
    .where(
      and(
        eq(mockupBatches.enterpriseId, scope.enterpriseId),
        eq(mockupBatches.userId, ctx.user.id),
      ),
    )
    .orderBy(desc(mockupBatches.createdAt))
    .limit(30)
  if (rows.length === 0) return { ok: true, error: null, batches: [] }

  const tags = rows.map((b) => b.id.replace(/-/g, "").slice(0, 32))
  const tasks = await db
    .select({
      status: generationTasks.status,
      batchTag: sql<string>`${generationTasks.templateInfo}->>'batchTag'`,
      resultImages: generationTasks.resultImages,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        inArray(sql`${generationTasks.templateInfo}->>'batchTag'`, tags),
      ),
    )
  const countsByTag = new Map<string, { succeeded: number; failed: number; processing: number; cover: string | null }>()
  for (const t of tasks) {
    const c = countsByTag.get(t.batchTag) ?? { succeeded: 0, failed: 0, processing: 0, cover: null }
    if (t.status === "completed") {
      c.succeeded++
      if (!c.cover && t.resultImages?.[0]) c.cover = t.resultImages[0]
    } else if (t.status === "failed") c.failed++
    else c.processing++
    countsByTag.set(t.batchTag, c)
  }

  return {
    ok: true,
    error: null,
    batches: rows.map((b) => {
      const tag = b.id.replace(/-/g, "").slice(0, 32)
      const c = countsByTag.get(tag) ?? { succeeded: 0, failed: 0, processing: 0, cover: null }
      return {
        id: b.id,
        displayName: b.displayName,
        totalCount: b.totalCount,
        succeededCount: c.succeeded,
        failedCount: c.failed,
        processingCount: c.processing,
        createdAt: b.createdAt.toISOString(),
        coverImage: c.cover,
      }
    }),
  }
}

/** 批次详情（含任务明细；顺带推进在途任务与主页面轮询一致） */
export async function getMockupBatchStatusAction(
  batchId: string,
): Promise<{
  ok: boolean
  error: string | null
  batch: MockupBatchDetail | null
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [row] = await db
    .select()
    .from(mockupBatches)
    .where(
      and(
        eq(mockupBatches.id, batchId),
        eq(mockupBatches.enterpriseId, scope.enterpriseId),
        eq(mockupBatches.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!row) return { ok: false, error: "批次不存在", batch: null }

  const batchTag = row.id.replace(/-/g, "").slice(0, 32)
  const active = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'batchTag' = ${batchTag}`,
        inArray(generationTasks.status, ["queued", "processing"]),
      ),
    )
  // 双通道收敛：轮询时顺带推进（一次批量查询外部状态，旧版服务回退逐个）
  await syncMockupTasks(active)

  const tasks = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
        sql`${generationTasks.templateInfo}->>'batchTag' = ${batchTag}`,
      ),
    )
    .orderBy(asc(generationTasks.createdAt))
    .limit(MOCKUP_BATCH_MAX_TASKS * 4)

  const views = tasks.map(toBatchTaskView).sort((a, b) => a.batchIndex - b.batchIndex)
  const succeeded = views.filter((t) => t.status === "completed").length
  const failed = views.filter((t) => t.status === "failed").length
  const processing = views.filter(
    (t) => t.status === "queued" || t.status === "processing",
  ).length

  return {
    ok: true,
    error: null,
    batch: {
      id: row.id,
      displayName: row.displayName,
      totalCount: row.totalCount,
      succeededCount: succeeded,
      failedCount: failed,
      processingCount: processing,
      createdAt: row.createdAt.toISOString(),
      externalTemplateId: row.externalTemplateId,
      tasks: views,
    },
  }
}

/** 重试批次中失败的单个任务（重新扣费 + 新幂等键提交） */
export async function retryBatchTaskAction(taskId: string): Promise<{
  ok: boolean
  error: string | null
}> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) return { ok: false, error: denied }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, error: "任务不存在" }
  const info = parseMockupInfo(task.templateInfo)
  if (!info?.batchId) return { ok: false, error: "非批量替换任务" }
  if (task.status !== "failed") return { ok: false, error: "仅失败任务可重试" }

  const cost = cfg.costPerRender
  if (ctx.user.creditsBalance < cost) {
    return { ok: false, error: `个人配额不足，需要 ${cost}，当前 ${ctx.user.creditsBalance}` }
  }
  // 重新扣费 + 记账（单事务）：扣费与记账分离提交的崩溃窗口会造成
  // 「已扣费未记账 → 提交失败退款按记账额少退」。提交失败时
  // refundFailedTask 仍按 creditsCharged 原子退款
  try {
    await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: cost,
        userId: ctx.user.id,
        taskId: task.id,
        remark: `样机批量重试 · ${info.batchLabel ?? info.templateName}`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({ creditsCharged: task.creditsCharged + cost })
        .where(eq(generationTasks.id, task.id))
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "积分扣减失败" }
  }

  // 新幂等键（旧键可能命中外部已失败任务的幂等记录）
  const taskUuid = randomUUID().replace(/-/g, "")
  try {
    // 单任务提交走批量函数（内部自动回退逐个 + 带 webhook 地址）
    const [result] = await submitExternalRenderJobsBatch(
      cfg,
      scope.enterpriseId,
      {
        items: [
          {
            templateVersionId: info.templateVersionId,
            input: info.input,
            idempotencyKey: taskUuid,
            outputFormat: info.outputFormat,
          },
        ],
        user: mockupUser(ctx),
        webhookUrl: mockupRenderWebhookUrl(cfg, scope.enterpriseId),
      },
    )
    if (!result || !result.ok) {
      throw new Error(result?.message ?? "提交渲染失败")
    }
    const externalJobId = result.externalJobId
    await db
      .update(generationTasks)
      .set({
        status: "processing",
        startedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        retryCount: task.retryCount + 1,
        taskUuid,
        templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{externalJobId}', ${JSON.stringify(externalJobId)}::jsonb)`,
      })
      .where(eq(generationTasks.id, task.id))
    return { ok: true, error: null }
  } catch (err) {
    const message = apiErrMsg(err, "提交渲染失败")
    await db
      .update(generationTasks)
      .set({ errorMessage: message })
      .where(eq(generationTasks.id, task.id))
    await refundFailedTask(task.id)
    return { ok: false, error: message }
  }
}

/* ═══════════════ AI 生图（背景等固定图绑定 / 方块 AI背景 / AI渲染） ═══════════════ */

/** 样机页可用生图模型（isActive + visibleInMockup → 企业归属/白名单 → 权限组） */
export async function listMockupModelsAction(): Promise<
  Array<{
    id: string
    name: string
    displayName: string
    costPerImage: number
    sizePresets: Array<{ label: string; width: number; height: number; enabled?: boolean }> | null
    supportsReferenceImage: boolean
    maxReferenceImages: number
  }>
> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const rows = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      costPerImage: models.costPerImage,
      sizePresets: models.sizePresets,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(
      and(eq(models.isActive, true), eq(models.visibleInMockup, true)),
    )
    .orderBy(asc(models.sortOrder), asc(models.createdAt))

  const accessible = rows.filter(
    (m) => m.enterpriseId === null || m.enterpriseId === scope.enterpriseId,
  )
  const visiblePreset =
    (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
  const filtered =
    visiblePreset.length === 0
      ? accessible
      : accessible.filter(
          (m) => m.enterpriseId !== null || visiblePreset.includes(m.id),
        )
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    return filtered.filter((m) =>
      ctx.group!.allowedModels.includes(m.id),
    )
  }
  return filtered
}

/**
 * 提交 AI 生图任务（统一生图链路：Redis 队列/并发槽/转存 COS）：
 * - 无方块上下文：绑定弹窗/批量页手动生成（prompt=用户输入）；
 * - aiKind=background：菜单一键 AI背景（prompt=平台提示词模板，参考图=方块渲染原图）；
 * - aiKind=render：菜单 AI渲染（prompt=用户输入，参考图=方块渲染原图）。
 */
export async function submitMockupBackgroundAction(input: {
  modelId: string
  prompt: string
  imageSize: string
  referenceImages?: string[]
  cardId?: string
  groupItemId?: string
  aiKind?: "background" | "render"
}): Promise<{ ok: boolean; error: string | null; taskId: string | null; cost: number }> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) return { ok: false, error: denied, taskId: null, cost: 0 }
  const parsed = submitMockupBackgroundSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误", taskId: null, cost: 0 }
  }
  const d = parsed.data
  const scope = getCurrentEnterpriseScope(ctx)

  // 方块上下文：参考图固定为该方块渲染原图（服务端自查，不信任前端）
  let refImageUrl: string | null = null
  if (d.cardId && d.groupItemId && d.aiKind) {
    refImageUrl = await latestRenderedImageUrl(
      scope.enterpriseId,
      ctx.user.id,
      d.cardId,
      d.groupItemId,
    )
    if (!refImageUrl) {
      return { ok: false, error: "请先完成一次样机渲染，再使用 AI 功能", taskId: null, cost: 0 }
    }
  }

  const referenceImages = refImageUrl ? [refImageUrl] : (d.referenceImages ?? [])
  const refErr = await validateReferenceImageUrls(referenceImages, scope.enterpriseId)
  if (refErr) return { ok: false, error: refErr, taskId: null, cost: 0 }

  // 模型可见性链（isActive + visibleInMockup → 企业/白名单 → 权限组）
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, d.modelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInMockup) {
    return { ok: false, error: "模型不存在或未在样机渲染页开放", taskId: null, cost: 0 }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== scope.enterpriseId) {
    return { ok: false, error: "无权使用该模型", taskId: null, cost: 0 }
  }
  if (model.enterpriseId === null) {
    const visiblePreset =
      (ctx.enterprise?.visiblePresetModels as string[] | null) ?? []
    if (visiblePreset.length > 0 && !visiblePreset.includes(model.id)) {
      return { ok: false, error: "该平台预置模型未对本企业开放", taskId: null, cost: 0 }
    }
  }
  const accessErr = checkModelAccess(ctx, d.modelId)
  if (accessErr) return { ok: false, error: accessErr, taskId: null, cost: 0 }
  if (refImageUrl && !model.supportsReferenceImage) {
    return { ok: false, error: `模型 ${model.displayName} 不支持参考图`, taskId: null, cost: 0 }
  }

  const cost = model.costPerImage
  if (ctx.user.creditsBalance < cost) {
    return { ok: false, error: `个人配额不足，需要 ${cost}，当前 ${ctx.user.creditsBalance}`, taskId: null, cost }
  }

  // prompt：AI背景=平台提示词模板；AI渲染/手动=用户输入
  const prompt = (
    d.aiKind === "background" && d.cardId
      ? await loadMockupAiBackgroundPrompt()
      : d.prompt.trim()
  ).slice(0, 4000)
  // 建任务 + 扣费 + 记账（单事务，任一步失败整体回滚）：分离提交的崩溃
  // 窗口会造成「任务已建未扣费」（孤儿回收重新入队 = 免费生成）或「已扣
  // 费未记账」（失败退款按记账额少退）
  let taskId: string
  try {
    taskId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(generationTasks)
        .values({
          enterpriseId: scope.enterpriseId,
          userId: ctx.user.id,
          modelId: d.modelId,
          prompt,
          imageSize: d.imageSize,
          imageCount: 1,
          status: "queued",
          taskType: "normal",
          source: "mockup",
          priority: ctx.group?.priority ?? 0,
          creditsCharged: 0,
          costPerImage: model.costPerImage,
          referenceImages: referenceImages.length > 0 ? referenceImages : null,
          templateInfo:
            d.cardId && d.groupItemId && d.aiKind
              ? {
                  kind: "mockup-ai",
                  aiKind: d.aiKind,
                  cardId: d.cardId,
                  groupItemId: d.groupItemId,
                  refImageUrl: refImageUrl ?? "",
                }
              : undefined,
        })
        .returning({ id: generationTasks.id })

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: cost,
        userId: ctx.user.id,
        taskId: row!.id,
        remark: `样机AI生图 ${model.displayName} x1`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: cost })
        .where(eq(generationTasks.id, row!.id))
      return row!.id
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "积分扣减失败", taskId: null, cost }
  }

  try {
    await enqueue({
      taskId,
      enterpriseId: scope.enterpriseId,
      modelId: d.modelId,
      prompt,
      imageSize: d.imageSize,
      imageCount: 1,
      referenceImages,
      priority: ctx.group?.priority ?? 0,
      costPerImage: model.costPerImage,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    await refundFailedTask(taskId)
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "任务入队失败，积分已退还" })
      .where(eq(generationTasks.id, taskId))
    console.error(
      `[mockup] AI 生图任务 ${taskId} 入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还", taskId: null, cost }
  }

  return { ok: true, error: null, taskId, cost }
}

/**
 * AI背景落地：生成完成的 AI 背景图 → 填入卡片背景绑定 → 自动重渲染该样机。
 * appliedAt 原子认领保证幂等（页面兜底续做与在线轮询并发不会双落地/双渲染）。
 */
export async function applyMockupAiBackgroundAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
  render?: RenderMockupResult
}> {
  const ctx = await requireEnterpriseContext()
  const denied = moduleDenied(ctx)
  if (denied) return { ok: false, error: denied }
  const parsed = applyMockupAiBackgroundSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, parsed.data.taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  const info = parseMockupAiInfo(task?.templateInfo)
  const imageUrl = task?.resultImages?.[0]
  if (!task || !info || info.aiKind !== "background") {
    return { ok: false, error: "AI背景任务不存在" }
  }
  if (task.status !== "completed" || !imageUrl) {
    return { ok: false, error: "AI背景图尚未生成完成" }
  }

  // 校验卡片与小模板仍在，且存在背景绑定（先于认领：校验失败不烧掉 appliedAt，
  // 修复卡片/小模板/背景图层后仍可重新落地）
  const [card] = await db
    .select()
    .from(mockupCards)
    .where(
      and(
        eq(mockupCards.id, info.cardId),
        eq(mockupCards.enterpriseId, scope.enterpriseId),
        eq(mockupCards.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!card) return { ok: false, error: "卡片已删除，AI背景图保留在生成记录中" }
  const [item] = await db
    .select()
    .from(mockupGroupItems)
    .where(eq(mockupGroupItems.id, info.groupItemId))
    .limit(1)
  if (!item || item.groupId !== card.groupId) {
    return { ok: false, error: "小模板已变更，无法应用 AI 背景" }
  }
  const defs = overlayBackgroundRole(
    (item.bindings ?? []) as MockupBindingDef[],
    new Set(
      await loadBackgroundBindingIds(scope.enterpriseId, item.externalTemplateId),
    ),
  )
  const bgDef = defs.find((b) => b.role === "background" && b.type !== "text")
  if (!bgDef) {
    return { ok: false, error: "该小模板没有标记为「背景」的图片图层，请先在模板管理中编辑绑定" }
  }

  // 幂等认领：仅当未落地时继续（并发/重复调用直接短路）
  const claimed = await db
    .update(generationTasks)
    .set({
      templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{appliedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb)`,
    })
    .where(
      and(
        eq(generationTasks.id, task.id),
        sql`${generationTasks.templateInfo}->>'appliedAt' IS NULL`,
      ),
    )
    .returning({ id: generationTasks.id })
  if (claimed.length === 0) {
    return { ok: true, error: null }
  }

  // 填入背景绑定并保存
  const config = { ...((card.bindingConfig ?? {}) as MockupBindingConfig) }
  const itemConfig = { ...(config[info.groupItemId] ?? {}) }
  itemConfig[bgDef.bindingId] = { imageUrl }
  config[info.groupItemId] = itemConfig
  await db
    .update(mockupCards)
    .set({ bindingConfig: config, updatedAt: new Date() })
    .where(eq(mockupCards.id, card.id))

  // 自动重渲染该样机（计费 costPerRender；失败仅提示，配置已保存）
  // allowCompleted：AI背景落地重渲染是「仅首次渲染」规则的唯一例外
  const render = await renderInternal(ctx, [card.id], info.groupItemId, {
    allowCompleted: true,
  })
  revalidatePath("/mockup")
  return { ok: true, error: null, render }
}

/** AI 生图任务状态轮询（弹窗内驱动到终态） */
export async function getMockupBackgroundStatusAction(
  taskId: string,
): Promise<{ ok: boolean; task: MockupBackgroundTaskView | null }> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.userId, ctx.user.id),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, task: null }
  return {
    ok: true,
    task: {
      taskId: task.id,
      status: task.status,
      resultImage: task.resultImages?.[0] ?? null,
      errorMessage: task.errorMessage,
    },
  }
}
