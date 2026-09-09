"use server"

import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  conversations,
  generationTasks,
  models,
} from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import {
  checkModelAccess,
  checkModuleAccess,
  effectiveConcurrentLimit,
} from "@/lib/auth/permissions"
import { deductUserCredits, refundFailedTask } from "@/server/services/credits-service"
import { enqueue } from "@/lib/queue/task-queue"
import { validateReferenceImageUrls } from "@/lib/storage/reference-url"
import { submitTaskSchema } from "@/server/schemas/create"
import { createConversationAction } from "@/server/actions/conversations"
import { truncateConversationTitle } from "@/lib/conversation-title"
import { revalidatePath } from "next/cache"

/**
 * 创作页 Server Actions（手册 M3、§5.5）
 *
 * submitTask: 校验模型 ∈ group.allowedModels + 企业模块开关 → 扣积分 → 入队
 * retryTask: 失败任务重试（首次失败已按张退款，重试按未成功张数重新扣费）
 */

/** 查询用户可用的模型（受权限组限制） */
export async function listAvailableModelsAction() {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "create")
  if (denied) return []
  if (!ctx.enterprise) return []

  const scope = getCurrentEnterpriseScope(ctx)
  // 查询 visibleInCreate + isActive 的模型（平台预置 + 企业私有）
  const createVisible = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      costPerImage: models.costPerImage,
      description: models.description,
      badgeText: models.badgeText,
      badgeColor: models.badgeColor,
      sizePresets: models.sizePresets,
      supportsImageCount: models.supportsImageCount,
      supportsSmartSize: models.supportsSmartSize,
      supportsReferenceImage: models.supportsReferenceImage,
      maxReferenceImages: models.maxReferenceImages,
      apiFormat: models.apiFormat,
      extraConfig: models.extraConfig,
      iconUrl: models.iconUrl,
      enterpriseId: models.enterpriseId,
    })
    .from(models)
    .where(and(eq(models.isActive, true), eq(models.visibleInCreate, true)))

  // 平台 + 本企业私有模型
  const accessible = createVisible.filter(
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

  // 权限组 allowedModels 过滤（空 = 放行全部）
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    return filtered.filter((m) => ctx.group!.allowedModels.includes(m.id))
  }
  return filtered
}

/** 提交生图任务 */
export async function submitTaskAction(input: {
  modelId: string
  prompt: string
  imageSize: string
  imageCount?: number
  referenceImages?: string[]
  /** 所属会话；未传则自动创建新会话 */
  conversationId?: string
}) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "create")
  if (denied) return { ok: false, error: denied }
  if (!ctx.enterprise) {
    return { ok: false, error: "无企业归属，无法生图" }
  }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = submitTaskSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

  // 参考图归属校验（防跨租户引用 / 把上游 AI 当 SSRF 代理拉任意 URL）
  const refErr = await validateReferenceImageUrls(
    d.referenceImages ?? [],
    scope.enterpriseId,
  )
  if (refErr) return { ok: false, error: refErr }

  // 0. 会话归属：未传 conversationId → 自动创建新会话（标题取首个任务提示词）
  let conversationId = input.conversationId
  if (!conversationId) {
    const created = await createConversationAction(
      truncateConversationTitle(d.prompt),
    )
    conversationId = created.id
  } else {
    // 校验会话归属当前用户+企业
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.enterpriseId, scope.enterpriseId),
          eq(conversations.userId, ctx.user.id),
        ),
      )
      .limit(1)
    if (!conv) {
      return { ok: false, error: "会话不存在或无权操作" }
    }
  }

  // 1. 模型存在 + 企业可见
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, d.modelId))
    .limit(1)
  if (!model || !model.isActive || !model.visibleInCreate) {
    return { ok: false, error: "模型不存在或不可用" }
  }
  if (model.enterpriseId !== null && model.enterpriseId !== scope.enterpriseId) {
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

  // 2. 权限组 allowedModels 校验
  const accessErr = checkModelAccess(ctx, d.modelId)
  if (accessErr) return { ok: false, error: accessErr }

  // 3. 积分预估 + 扣减（个人配额，需求 3）
  // 即梦相乘语义：创作页选择为「次数」（1-4），每次产出模型配置的
  // jimengN 张（1-8，>4 由适配器自动拆分多次 API 请求，单次上游上限 4 张）；
  // 总张数 = 次数 × N，按张计费。jimengN 缺省 1 = 行为与旧版一致。
  // 32 = 4 次 × 8 张的防御性上限（页面 zod 与模型 zod 已分别限制）。
  const batches = Math.max(1, d.imageCount ?? 1)
  const perBatch =
    model.apiFormat === "jimeng"
      ? Math.min(
          8,
          Math.max(
            1,
            Number(
              (model.extraConfig as Record<string, unknown> | null)?.jimengN,
            ) || 1,
          ),
        )
      : 1
  const imageCount = Math.min(32, batches * perBatch)
  const totalCost = model.costPerImage * imageCount
  if (ctx.user.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${totalCost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 4+5. 创建任务 + 扣积分 + 回写实收金额（单事务，任一步失败整体回滚）。
  // 此前三步跨事务提交，崩溃在中间窗口会出现「任务已建未扣费」（孤儿
  // 回收重新入队 = 免费生成）或「已扣费但 creditsCharged=0」（refundFailedTask
  // 见 0 直接跳过 = 扣钱不退）。
  let taskId: string
  try {
    taskId = await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(generationTasks)
        .values({
          enterpriseId: scope.enterpriseId,
          userId: ctx.user.id,
          modelId: d.modelId,
          prompt: d.prompt,
          imageSize: d.imageSize,
          imageCount,
          status: "queued",
          taskType: "normal",
          source: "create",
          priority: ctx.group?.priority ?? 0,
          creditsCharged: 0, // 事务内扣减成功后直接写入实收金额
          costPerImage: model.costPerImage, // 记录提交时单价（部分失败按张退款用）
          referenceImages: d.referenceImages ?? null,
          conversationId,
        })
        .returning({ id: generationTasks.id })

      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: totalCost,
        userId: ctx.user.id,
        taskId: task!.id,
        remark: `生图 ${model.displayName} x${imageCount}`,
        tx,
      })

      await tx
        .update(generationTasks)
        .set({ creditsCharged: totalCost })
        .where(eq(generationTasks.id, task!.id))
      return task!.id
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  // 6. 入队（Redis）。失败必须退款，否则用户积分已扣但任务永不处理。
  const groupMax = ctx.group?.maxConcurrent ?? model.maxConcurrent
  const effectiveMax = effectiveConcurrentLimit({
    enterprise: ctx.enterprise.maxConcurrent,
    group: groupMax,
    model: model.maxConcurrent,
  })

  try {
    await enqueue({
      taskId,
      enterpriseId: scope.enterpriseId,
      modelId: d.modelId,
      prompt: d.prompt,
      imageSize: d.imageSize,
      imageCount,
      referenceImages: d.referenceImages ?? [],
      priority: ctx.group?.priority ?? 0,
      costPerImage: model.costPerImage,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
      conversationId,
    })
  } catch (err) {
    // 入队失败（如 Redis 闪断）：退还积分并标记任务失败，避免资金损失
    await refundFailedTask(taskId)
    await db
      .update(generationTasks)
      .set({
        status: "failed",
        errorMessage: "任务入队失败，积分已退还",
      })
      .where(eq(generationTasks.id, taskId))
    console.error(
      `[create] 任务 ${taskId} 入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return {
      ok: false,
      error: "任务入队失败，积分已退还，请稍后重试",
    }
  }

  // 更新会话时间戳（让左侧列表重排序）
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId!))

  revalidatePath("/create")
  return {
    ok: true,
    error: null,
    taskId,
    conversationId,
    cost: totalCost,
    effectiveMaxConcurrent: effectiveMax,
  }
}

/** 重试失败任务（首次失败已退款，重试按未成功张数重新扣费） */
export async function retryTaskAction(taskId: string) {
  const ctx = await requireUserContext()
  const denied = checkModuleAccess(ctx, "create")
  if (denied) return { ok: false, error: denied }
  const scope = getCurrentEnterpriseScope(ctx)

  const [task] = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.id, taskId),
        eq(generationTasks.enterpriseId, scope.enterpriseId),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, error: "任务不存在" }
  if (task.status !== "failed") {
    return { ok: false, error: "仅失败任务可重试" }
  }
  if (task.userId !== ctx.user.id) {
    return { ok: false, error: "只能重试自己的任务" }
  }
  // 样机渲染等无模型任务不走图像队列，不由此 action 重试
  if (!task.modelId) {
    return { ok: false, error: "该任务类型不支持在此重试" }
  }

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, task.modelId))
    .limit(1)
  if (!model || !model.isActive) {
    return { ok: false, error: "模型不存在或已下线，无法重试" }
  }

  // 部分失败任务：仅重试未成功的图片序号（已成功的保留不重复生成）
  const succeeded = task.succeededIndexes ?? []
  const pendingIndexes = Array.from(
    { length: task.imageCount },
    (_, i) => i,
  ).filter((i) => !succeeded.includes(i))
  if (pendingIndexes.length === 0) {
    return { ok: false, error: "所有图片均已生成，无需重试" }
  }

  // 重新扣费：任务失败时 refundFailedTask 已按张退款（creditsCharged 仅剩
  // 已成功张计费），重试必须对未成功张数重新计费，否则重试成功 = 免费出图
  const unitPrice = task.costPerImage ?? model.costPerImage
  const retryCost = unitPrice * pendingIndexes.length
  if (ctx.user.creditsBalance < retryCost) {
    return {
      ok: false,
      error: `个人配额不足，需要 ${retryCost}，当前 ${ctx.user.creditsBalance}`,
    }
  }

  // 重新扣费 + 翻转状态（单事务）：扣费与记账分离提交的崩溃窗口会造成
  // 「已扣费但 creditsCharged 未累加 → 失败退款按记账额少退」。
  // 先翻转 DB 状态再入队：消费端终态守卫读 DB status，若入队先于状态
  // 翻转，任务可能仍以 failed 被消费并直接丢弃（用户重试静默失效）
  try {
    await db.transaction(async (tx) => {
      await deductUserCredits({
        enterpriseId: scope.enterpriseId,
        amount: retryCost,
        userId: ctx.user.id,
        taskId: task.id,
        remark: `重试生图 ${model.displayName} x${pendingIndexes.length}`,
        tx,
      })
      await tx
        .update(generationTasks)
        .set({
          status: "queued",
          retryCount: task.retryCount + 1,
          errorMessage: null,
          creditsCharged: task.creditsCharged + retryCost, // 累加：保留已成功张计费
        })
        .where(eq(generationTasks.id, taskId))
    })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "积分扣减失败",
    }
  }

  try {
    await enqueue({
      taskId: task.id,
      enterpriseId: scope.enterpriseId,
      modelId: task.modelId,
      prompt: task.prompt,
      imageSize: task.imageSize ?? "1024x1024",
      imageCount: task.imageCount,
      pendingIndexes,
      referenceImages: (task.referenceImages as string[]) ?? [],
      priority: task.priority,
      costPerImage: unitPrice,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
    })
  } catch (err) {
    // 入队失败：退还重试扣费并标记失败，避免资金损失
    await refundFailedTask(task.id)
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "任务入队失败，积分已退还" })
      .where(eq(generationTasks.id, taskId))
    console.error(
      `[create] 任务 ${task.id} 重试入队失败，已退款:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false, error: "任务入队失败，积分已退还，请稍后重试" }
  }

  revalidatePath("/create")
  return { ok: true, error: null, taskId }
}

