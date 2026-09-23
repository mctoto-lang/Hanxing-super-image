"use server"

import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { db } from "@/db/client"
import { mockupCards, mockupGroupItems, mockupGroups, mockupTemplateExtras, type MockupBindingDef, users } from "@/db/schema"
import { getCurrentEnterpriseScope, requireEnterpriseContext, type UserContext } from "@/lib/auth/session"
import { isEnterpriseAdmin } from "@/lib/auth/permissions"
import { deleteExternalTemplate, getTemplate, listFonts, listTemplates, publishTemplate, regenerateTemplateThumbnail, saveLayerBindings, setExternalTemplateVisibility, type ExternalFont, type ExternalLayerNode } from "@/lib/mockup/client"
import { loadMockupConfig, type MockupEnterpriseConfig } from "@/lib/mockup/settings"
import { TEMPLATE_LIST_TTL_MS, invalidateTemplateListCache, templateListCache, templateListGeneration, templateListInflight } from "@/server/services/mockup-template-cache"
import type { MockupGroupManageView } from "@/lib/mockup/types"
import { createMockupGroupSchema, saveTemplateBindingsSchema, setMockupGroupVisibilitySchema, updateMockupGroupSchema } from "@/server/schemas/mockup"
import { apiErrMsg, groupVisibilityCondition, loadBackgroundBindingIds, loadTemplateVisibilityMap, mockupUser, moduleDenied, snapshotGroupItem, userNamesByIds } from "./shared"


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


