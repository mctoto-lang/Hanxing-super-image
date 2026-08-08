"use server"

import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  generationTasks,
  models,
} from "@/db/schema"
import {
  requireUserContext,
  getCurrentEnterpriseScope,
  type UserContext,
} from "@/lib/auth/session"
import { checkModelAccess, effectiveConcurrentLimit } from "@/lib/auth/permissions"
import { deductCredits, refundCredits } from "@/server/services/credits-service"
import { enqueue } from "@/lib/queue/task-queue"
import { submitTaskSchema } from "@/server/schemas/create"
import { revalidatePath } from "next/cache"

/**
 * 创作页 Server Actions（手册 M3、§5.5）
 *
 * submitTask: 校验模型 ∈ group.allowedModels + 企业模块开关 → 扣积分 → 入队
 * retryTask: 失败任务重试
 */

/** 查询用户可用的模型（受权限组限制） */
export async function listAvailableModelsAction() {
  const ctx = await requireUserContext()
  if (!ctx.enterprise) return []

  const scope = getCurrentEnterpriseScope(ctx)
  // 查询 visibleInCreate + isActive 的模型（平台预置 + 企业私有）
  const createVisible = await db
    .select({
      id: models.id,
      name: models.name,
      displayName: models.displayName,
      costPerImage: models.costPerImage,
      supportedSizes: models.supportedSizes,
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

  // 权限组 allowedModels 过滤（空 = 放行全部）
  if (ctx.group && ctx.group.allowedModels.length > 0) {
    return accessible.filter((m) =>
      ctx.group!.allowedModels.includes(m.id),
    )
  }
  return accessible
}

/** 提交生图任务 */
export async function submitTaskAction(input: {
  modelId: string
  prompt: string
  imageSize: string
  imageCount?: number
  referenceImages?: string[]
}) {
  const ctx = await requireUserContext()
  if (!ctx.enterprise) {
    return { ok: false, error: "无企业归属，无法生图" }
  }
  const scope = getCurrentEnterpriseScope(ctx)

  const parsed = submitTaskSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "参数错误" }
  }
  const d = parsed.data

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

  // 2. 权限组 allowedModels 校验
  const accessErr = checkModelAccess(ctx, d.modelId, [d.modelId])
  if (accessErr) return { ok: false, error: accessErr }

  // 3. 积分预估 + 扣减（行锁）
  const imageCount = Math.max(1, d.imageCount ?? 1)
  const totalCost = model.costPerImage * imageCount
  if (ctx.enterprise.creditsBalance < totalCost) {
    return {
      ok: false,
      error: `积分不足，需要 ${totalCost}，当前 ${ctx.enterprise.creditsBalance}`,
    }
  }

  // 4. 创建任务记录（先 queued）
  const [task] = await db
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
      creditsCharged: 0, // 扣减成功后更新
      referenceImages: d.referenceImages ?? null,
    })
    .returning()

  // 5. 扣积分（行锁事务）
  try {
    await deductCredits({
      enterpriseId: scope.enterpriseId,
      amount: totalCost,
      userId: ctx.user.id,
      taskId: task!.id,
      remark: `生图 ${model.displayName} x${imageCount}`,
    })
  } catch (err) {
    // 扣减失败：标记任务 failed
    await db
      .update(generationTasks)
      .set({ status: "failed", errorMessage: "积分扣减失败" })
      .where(eq(generationTasks.id, task!.id))
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "积分扣减失败",
    }
  }

  await db
    .update(generationTasks)
    .set({ creditsCharged: totalCost })
    .where(eq(generationTasks.id, task!.id))

  // 6. 入队（Redis）
  const groupMax = ctx.group?.maxConcurrent ?? model.maxConcurrent
  const effectiveMax = effectiveConcurrentLimit({
    enterprise: ctx.enterprise.maxConcurrent,
    group: groupMax,
    model: model.maxConcurrent,
  })

  await enqueue({
    taskId: task!.id,
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
  })

  revalidatePath("/create")
  return {
    ok: true,
    error: null,
    taskId: task!.id,
    cost: totalCost,
    effectiveMaxConcurrent: effectiveMax,
  }
}

/** 重试失败任务 */
export async function retryTaskAction(taskId: string) {
  const ctx = await requireUserContext()
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

  // 已扣过积分（task.creditsCharged），重试不重复扣
  await enqueue({
    taskId: task.id,
    enterpriseId: scope.enterpriseId,
    modelId: task.modelId,
    prompt: task.prompt,
    imageSize: task.imageSize ?? "1024x1024",
    imageCount: task.imageCount,
    referenceImages: (task.referenceImages as string[]) ?? [],
    priority: task.priority,
    costPerImage: 0, // 重试不再计费（首次已扣）
    apiTimeout: 120,
    taskTimeout: 300,
    maxRetries: 0,
  })

  await db
    .update(generationTasks)
    .set({
      status: "queued",
      retryCount: task.retryCount + 1,
      errorMessage: null,
    })
    .where(eq(generationTasks.id, taskId))

  revalidatePath("/create")
  return { ok: true, error: null, taskId }
}

/** 退款（任务失败时，由队列消费者调用） */
export async function refundFailedTask(
  taskId: string,
): Promise<void> {
  const [task] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, taskId))
    .limit(1)
  if (!task || task.creditsCharged <= 0) return

  await refundCredits({
    enterpriseId: task.enterpriseId,
    amount: task.creditsCharged,
    userId: task.userId,
    taskId: task.id,
    remark: "任务失败退还",
  })

  await db
    .update(generationTasks)
    .set({ creditsCharged: 0 })
    .where(eq(generationTasks.id, taskId))
}
