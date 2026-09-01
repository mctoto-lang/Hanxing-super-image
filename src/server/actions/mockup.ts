"use server"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { db } from "@/db/client"
import {
  generationTasks,
  mockupCards,
  mockupDesignAssets,
  mockupGroupItems,
  mockupGroups,
  type MockupBindingConfig,
  type MockupBindingDef,
} from "@/db/schema"
import {
  getCurrentEnterpriseScope,
  requireEnterpriseAdmin,
  requireEnterpriseContext,
  type UserContext,
} from "@/lib/auth/session"
import { checkModuleAccess } from "@/lib/auth/permissions"
import {
  MockupApiError,
  createTemplateUploadUrl,
  getTemplate,
  listTemplates,
  parsePsdTemplate,
  publishTemplate,
  putUploadBytes,
  regenerateTemplateThumbnail,
  saveLayerBindings,
  type ExternalLayerNode,
  type MockupUserContext,
} from "@/lib/mockup/client"
import { loadMockupConfig, type MockupEnterpriseConfig } from "@/lib/mockup/settings"
import { parseMockupInfo } from "@/lib/mockup/task-info"
import type {
  MockupCardItemView,
  MockupCardView,
  MockupGroupItemView,
  MockupGroupView,
  MockupHistoryBatch,
  MockupLibraryImage,
  MockupPageData,
  MockupStatusUpdate,
  RenderMockupResult,
} from "@/lib/mockup/types"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { refundFailedTask } from "@/server/actions/create"
import { deductUserCredits } from "@/server/services/credits-service"
import {
  cancelMockupRenderJob,
  submitExternalRenderJob,
  syncMockupTask,
} from "@/server/services/mockup-service"
import {
  addMockupDesignAssetSchema,
  createMockupCardSchema,
  createMockupGroupSchema,
  renameMockupCardSchema,
  renderMockupCardsSchema,
  saveCardBindingsSchema,
  saveTemplateBindingsSchema,
  updateMockupGroupSchema,
} from "@/server/schemas/mockup"

/**
 * 样机渲染 Server Actions
 *
 * 模板管理（外部 PSD 小模板 + 大模板套组）限企业管理员；
 * 卡片/图片库/渲染对全体成员开放（个人工作区）。
 * 渲染任务不走 Redis 图像队列：扣费后同步提交外部 createRenderJob，
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
    admin:
      ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin",
  }
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

/* ═══════════════ 页面初始数据 ═══════════════ */

export async function getMockupPageDataAction(): Promise<MockupPageData> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)

  const [groups, cards, designAssets] = await Promise.all([
    db
      .select()
      .from(mockupGroups)
      .where(eq(mockupGroups.enterpriseId, scope.enterpriseId))
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
      .limit(60),
  ])

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

  // 每张卡片最新批次的任务（按 batchTag 匹配）
  const batchTags = cards
    .map((c) => c.lastBatchTag)
    .filter((t): t is string => Boolean(t))
  const taskRows = batchTags.length
    ? await db
        .select()
        .from(generationTasks)
        .where(
          and(
            eq(generationTasks.taskType, "mockup"),
            eq(generationTasks.enterpriseId, scope.enterpriseId),
            eq(generationTasks.userId, ctx.user.id),
            inArray(
              sql`${generationTasks.templateInfo}->>'batchTag'`,
              batchTags,
            ),
          ),
        )
    : []

  const itemsByGroup = new Map<string, MockupGroupItemView[]>()
  for (const item of items) {
    const view: MockupGroupItemView = {
      id: item.id,
      displayName: item.displayName,
      templateVersionId: item.templateVersionId,
      externalTemplateId: item.externalTemplateId,
      canvasWidth: item.canvasWidth,
      canvasHeight: item.canvasHeight,
      bindings: (item.bindings ?? []) as MockupBindingDef[],
      sortOrder: item.sortOrder,
    }
    const list = itemsByGroup.get(item.groupId) ?? []
    list.push(view)
    itemsByGroup.set(item.groupId, list)
  }

  const taskByKey = new Map<string, (typeof taskRows)[number]>()
  for (const task of taskRows) {
    const info = parseMockupInfo(task.templateInfo)
    if (!info) continue
    taskByKey.set(`${info.cardId}:${info.groupItemId}:${info.batchTag}`, task)
  }

  const groupViews: MockupGroupView[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    items: itemsByGroup.get(g.id) ?? [],
  }))

  const cardViews: MockupCardView[] = cards.map((card) => {
    const groupItems = itemsByGroup.get(card.groupId) ?? []
    const config = (card.bindingConfig ?? {}) as MockupBindingConfig
    const cardItems: MockupCardItemView[] = groupItems.map((item) => {
      const task = taskByKey.get(`${card.id}:${item.id}:${card.lastBatchTag}`)
      return {
        ...item,
        configured: isItemConfigured(item.bindings, config[item.id]),
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
  }
}

/* ═══════════════ 模板管理 · 外部小模板（管理员） ═══════════════ */

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
    createdAt: string
  }>
}> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) {
    return { ok: false, error: "无权访问样机模块", templates: [] }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", templates: [] }
  try {
    const templates = await listTemplates(cfg, mockupUser(ctx))
    return {
      ok: true,
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
        visibility: t.visibility === "private" ? "private" : "public",
        createdAt: t.createdAt,
      })),
    }
  } catch (err) {
    return {
      ok: false,
      error: apiErrMsg(err, "模板列表获取失败"),
      templates: [],
    }
  }
}

/** 模板详情（图层树 + 绑定 + 画布），绑定编辑器数据源 */
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
    thumbnailObjectKey: string | null
  }
}> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) {
    return { ok: false, error: "无权访问样机模块", detail: null }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置", detail: null }
  try {
    const detail = await getTemplate(cfg, templateId, mockupUser(ctx))
    const v = detail.latestVersion
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
        bindings: (v?.layerSchema.bindings ?? []) as MockupBindingDef[],
        thumbnailObjectKey: v?.thumbnailObjectKey ?? null,
      },
    }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "模板详情获取失败"), detail: null }
  }
}

/** PSD 上传 + 解析（创建 DRAFT 模板，返回图层树供绑定编辑） */
export async function uploadPsdTemplateAction(formData: FormData): Promise<{
  ok: boolean
  error: string | null
  templateId: string | null
  templateVersionId: string | null
  canvasWidth: number | null
  canvasHeight: number | null
  layerTree: ExternalLayerNode[]
}> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) {
    return {
      ok: false,
      error: "无权访问样机模块",
      templateId: null,
      templateVersionId: null,
      canvasWidth: null,
      canvasHeight: null,
      layerTree: [],
    }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) {
    return {
      ok: false,
      error: "样机渲染服务未配置",
      templateId: null,
      templateVersionId: null,
      canvasWidth: null,
      canvasHeight: null,
      layerTree: [],
    }
  }

  const file = formData.get("file")
  const name = formData.get("name")
  const visibilityRaw = formData.get("visibility")
  const visibility: "public" | "private" =
    visibilityRaw === "private" ? "private" : "public"
  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      error: "请选择 PSD 文件",
      templateId: null,
      templateVersionId: null,
      canvasWidth: null,
      canvasHeight: null,
      layerTree: [],
    }
  }
  const templateName =
    typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : file.name.replace(/\.psd$/i, "")

  try {
    const bytes = Buffer.from(await file.arrayBuffer())
    const ticket = await createTemplateUploadUrl(cfg, {
      fileName: `template-${Date.now()}.psd`,
      sizeBytes: bytes.length,
    })
    await putUploadBytes(cfg, ticket, bytes)
    const parsed = await parsePsdTemplate(
      cfg,
      {
        objectKey: ticket.objectKey,
        name: templateName,
        visibility,
      },
      mockupUser(ctx),
    )
    return {
      ok: true,
      error: null,
      templateId: parsed.templateId,
      templateVersionId: parsed.templateVersionId,
      canvasWidth: parsed.canvas?.width ?? null,
      canvasHeight: parsed.canvas?.height ?? null,
      layerTree: parsed.layerTree ?? [],
    }
  } catch (err) {
    return {
      ok: false,
      error: apiErrMsg(err, "PSD 上传解析失败"),
      templateId: null,
      templateVersionId: null,
      canvasWidth: null,
      canvasHeight: null,
      layerTree: [],
    }
  }
}

/** 保存绑定配置（可选同时发布） */
export async function saveTemplateBindingsAction(input: {
  templateId: string
  bindings: unknown
  publish: boolean
}): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const parsed = saveTemplateBindingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }
  try {
    const user = mockupUser(ctx)
    await saveLayerBindings(
      cfg,
      parsed.data.templateId,
      parsed.data.bindings,
      user,
    )
    if (parsed.data.publish) {
      await publishTemplate(cfg, parsed.data.templateId, user)
    }
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "绑定保存失败") }
  }
}

/** 手动补生成模板缩略图（解析时未成功的兜底） */
export async function regenerateTemplateThumbnailAction(
  templateId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) {
    return { ok: false, error: "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }
  try {
    await regenerateTemplateThumbnail(cfg, templateId, mockupUser(ctx))
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: apiErrMsg(err, "缩略图生成失败") }
  }
}

/* ═══════════════ 大模板套组（分组 CRUD，管理员写 / 成员读） ═══════════════ */

/** 从外部模板详情快照成员信息（版本钉住 + 绑定定义抄录） */
async function snapshotGroupItem(
  cfg: MockupEnterpriseConfig,
  input: { templateId: string; displayName?: string; sortOrder: number },
): Promise<{ ok: true; item: typeof mockupGroupItems.$inferInsert } | { ok: false; error: string }> {
  const detail = await getTemplate(cfg, input.templateId)
  const version = detail.latestVersion
  if (!version || !version.published) {
    return { ok: false, error: `模板「${detail.name}」未发布，不能加入套组` }
  }
  return {
    ok: true,
    item: {
      groupId: "", // 由调用方回填
      templateVersionId: version.versionId,
      externalTemplateId: detail.templateId,
      displayName: input.displayName?.trim() || detail.name,
      canvasWidth: version.canvas?.width ?? null,
      canvasHeight: version.canvas?.height ?? null,
      bindings: (version.layerSchema.bindings ?? []).map((b) => ({
        bindingId: b.bindingId,
        layerId: b.layerId,
        layerPath: b.layerPath,
        type: b.type,
        required: b.required ?? true,
        label: b.label ?? b.bindingId,
        fit: b.fit ?? "stretch",
      })),
      sortOrder: input.sortOrder,
    },
  }
}

export async function createMockupGroupAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
  groupId: string | null
}> {
  const ctx = await requireEnterpriseAdmin()
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

  // 逐个模板取外部详情快照（失败即中止，不建半截套组）
  const snapshotResults: Array<typeof mockupGroupItems.$inferInsert> = []
  for (const itemInput of parsed.data.items) {
    try {
      const snap = await snapshotGroupItem(cfg, itemInput)
      if (!snap.ok) return { ok: false, error: snap.error, groupId: null }
      snapshotResults.push(snap.item)
    } catch (err) {
      return {
        ok: false,
        error: apiErrMsg(err, "模板信息获取失败"),
        groupId: null,
      }
    }
  }

  const [group] = await db
    .insert(mockupGroups)
    .values({
      enterpriseId: scope.enterpriseId,
      name: parsed.data.name,
      sortOrder: 0,
    })
    .returning({ id: mockupGroups.id })
  await db.insert(mockupGroupItems).values(
    snapshotResults.map((item) => ({ ...item, groupId: group!.id })),
  )

  revalidatePath("/mockup")
  return { ok: true, error: null, groupId: group!.id }
}

export async function updateMockupGroupAction(input: unknown): Promise<{
  ok: boolean
  error: string | null
}> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const parsed = updateMockupGroupSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const scope = getCurrentEnterpriseScope(ctx)
  const cfg = await loadMockupConfig(scope.enterpriseId)
  if (!cfg) return { ok: false, error: "样机渲染服务未配置" }

  const [group] = await db
    .select({ id: mockupGroups.id })
    .from(mockupGroups)
    .where(
      and(
        eq(mockupGroups.id, parsed.data.id),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!group) return { ok: false, error: "大模板不存在" }

  const snapshotResults: Array<typeof mockupGroupItems.$inferInsert> = []
  for (const itemInput of parsed.data.items) {
    try {
      const snap = await snapshotGroupItem(cfg, itemInput)
      if (!snap.ok) return { ok: false, error: snap.error }
      snapshotResults.push(snap.item)
    } catch (err) {
      return { ok: false, error: apiErrMsg(err, "模板信息获取失败") }
    }
  }

  await db
    .update(mockupGroups)
    .set({ name: parsed.data.name, updatedAt: new Date() })
    .where(eq(mockupGroups.id, group.id))
  // 重建成员（旧 groupItemId 变更后，卡片上失效项由 configured/渲染校验兜底）
  await db.delete(mockupGroupItems).where(eq(mockupGroupItems.groupId, group.id))
  await db.insert(mockupGroupItems).values(
    snapshotResults.map((item) => ({ ...item, groupId: group.id })),
  )

  revalidatePath("/mockup")
  return { ok: true, error: null }
}

export async function deleteMockupGroupAction(
  groupId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctx = await requireEnterpriseAdmin()
  if (moduleDenied(ctx)) return { ok: false, error: "无权访问样机模块" }
  const scope = getCurrentEnterpriseScope(ctx)

  // 套组下的卡片级联删除（FK cascade），历史渲染任务保留在资产页
  const deleted = await db
    .delete(mockupGroups)
    .where(
      and(
        eq(mockupGroups.id, groupId),
        eq(mockupGroups.enterpriseId, scope.enterpriseId),
      ),
    )
    .returning({ id: mockupGroups.id })
  if (deleted.length === 0) return { ok: false, error: "大模板不存在" }

  revalidatePath("/mockup")
  return { ok: true, error: null }
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
      ),
    )
    .limit(1)
  if (!group) return { ok: false, error: "大模板不存在", cardId: null }

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
    .returning({ id: mockupCards.id })
  if (deleted.length === 0) return { ok: false, error: "卡片不存在" }
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
      groupItemId: info.groupItemId,
      displayName:
        nameByItem.get(info.groupItemId) ?? info.templateName ?? "样机",
      status: task.status,
      resultImage: task.resultImages?.[0] ?? null,
      errorMessage: task.errorMessage,
      createdAt: task.createdAt.toISOString(),
    })
  }
  return { ok: true, error: null, batches: [...batchMap.values()] }
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

/** 生成图资产（最近的生图任务结果，图片库第二个 Tab） */
export async function listGeneratedAssetsAction(limit = 40): Promise<{
  ok: boolean
  images: MockupLibraryImage[]
}> {
  const ctx = await requireEnterpriseContext()
  const scope = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select({
      id: generationTasks.id,
      resultImages: generationTasks.resultImages,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.enterpriseId, scope.enterpriseId),
        eq(generationTasks.status, "completed"),
        sql`${generationTasks.resultImages} IS NOT NULL`,
      ),
    )
    .orderBy(desc(generationTasks.createdAt))
    .limit(Math.min(Math.max(limit, 1), 60))

  const images: MockupLibraryImage[] = []
  for (const row of rows) {
    for (const [idx, url] of (row.resultImages ?? []).entries()) {
      images.push({
        id: `${row.id}:${idx}`,
        imageUrl: url,
        fileName: null,
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
 */
async function renderInternal(
  ctx: UserContext,
  cardIds: string[],
  onlyGroupItemId?: string,
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

  // 逐项校验必填绑定
  const ready: ReadyItem[] = []
  const skipped: RenderMockupResult["skipped"] = []
  for (const card of cards) {
    const config = (card.bindingConfig ?? {}) as MockupBindingConfig
    for (const item of itemsByGroup.get(card.groupId) ?? []) {
      if (onlyGroupItemId && item.id !== onlyGroupItemId) continue
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

  // 建任务（status=queued，未提交外部前无 externalJobId）
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
  const createdTasks: Array<{ id: string; taskUuid: string; item: ReadyItem }> =
    []
  for (const item of ready) {
    const taskUuid = randomUUID().replace(/-/g, "")
    const [task] = await db
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
          outputFormat: "png",
        },
      })
      .returning({ id: generationTasks.id })
    createdTasks.push({ id: task!.id, taskUuid, item })
  }

  // 扣费（失败标 failed）
  try {
    await deductUserCredits({
      enterpriseId: scope.enterpriseId,
      amount: totalCost,
      userId: ctx.user.id,
      taskId: createdTasks[0]!.id,
      remark: `样机渲染 x${createdTasks.length}`,
    })
  } catch (err) {
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "积分扣减失败" })
      .where(
        inArray(
          generationTasks.id,
          createdTasks.map((t) => t.id),
        ),
      )
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
  for (const t of createdTasks) {
    await db
      .update(generationTasks)
      .set({ creditsCharged: cfg.costPerRender })
      .where(eq(generationTasks.id, t.id))
  }

  // 逐任务提交外部（素材中转 + createRenderJob）；单个失败即退款该张
  let submitted = 0
  const failedSubmits: RenderMockupResult["failedSubmits"] = []
  for (const t of createdTasks) {
    try {
      const externalJobId = await submitExternalRenderJob(cfg, scope.enterpriseId, {
        templateVersionId: t.item.templateVersionId,
        input: t.item.input,
        idempotencyKey: t.taskUuid,
        user: renderUser,
      })
      await db
        .update(generationTasks)
        .set({
          status: "processing",
          startedAt: new Date(),
          templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{externalJobId}', ${JSON.stringify(externalJobId)}::jsonb)`,
        })
        .where(eq(generationTasks.id, t.id))
      submitted++
    } catch (err) {
      const message = apiErrMsg(err, "提交渲染失败")
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
  const parsed = renderMockupCardsSchema.safeParse({ cardIds })
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
  return renderInternal(ctx, parsed.data.cardIds)
}

/** 仅渲染卡片上的一个小模板（图层替换弹窗内触发） */
export async function renderCardItemAction(
  cardId: string,
  groupItemId: string,
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
  return renderInternal(ctx, [cardId], groupItemId)
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

  // 双通道收敛：轮询时顺带推进（外部终态 → 落库 + 退款）
  for (const task of active) {
    const info = parseMockupInfo(task.templateInfo)
    if (info?.externalJobId) {
      try {
        await syncMockupTask(task.id, {
          externalJobId: info.externalJobId,
          enterpriseId: task.enterpriseId,
        })
      } catch {
        // 单任务同步失败不影响其余
      }
    }
  }

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

/** 取消在途渲染任务 */
export async function cancelMockupTaskAction(taskId: string): Promise<{
  ok: boolean
  error: string | null
  message: string | null
}> {
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
  if (!task) return { ok: false, error: "任务不存在", message: null }
  if (task.status !== "queued" && task.status !== "processing") {
    return { ok: false, error: "任务已结束", message: null }
  }
  const info = parseMockupInfo(task.templateInfo)
  if (!info?.externalJobId) {
    return { ok: false, error: "任务提交中，请稍候再取消", message: null }
  }
  const res = await cancelMockupRenderJob(scope.enterpriseId, info.externalJobId)
  return { ok: res.cancelled, error: null, message: res.message }
}
