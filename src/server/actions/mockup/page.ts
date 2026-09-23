"use server"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { generationTasks, mockupCards, mockupDesignAssets, mockupGroupItems, mockupGroups, mockupTemplateExtras, type MockupBindingConfig, type MockupBindingDef, users } from "@/db/schema"
import { getCurrentEnterpriseScope, requireEnterpriseContext } from "@/lib/auth/session"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { parseMockupAiInfo, parseMockupInfo } from "@/lib/mockup/task-info"
import type { MockupAiImageView, MockupCardItemView, MockupCardView, MockupGroupItemView, MockupGroupView, MockupPageData } from "@/lib/mockup/types"
import { firstRenderedImageUrlAfter, groupVisibilityCondition, isItemConfigured, latestRenderedImageUrl, overlayBackgroundRole } from "./shared"


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


