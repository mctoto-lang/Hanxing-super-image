import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  apiCallLogs,
  generationTasks,
  mockupExternalAssets,
} from "@/db/schema"
import {
  cancelRenderJob,
  completeAsset,
  createAssetUploadUrl,
  createRenderJob,
  fetchResultBytes,
  getRenderJob,
  putUploadBytes,
  type ExternalRenderJob,
  type MockupApiConfig,
  type MockupUserContext,
} from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { parseMockupInfo } from "@/lib/mockup/task-info"
import { refundFailedTask } from "@/server/actions/create"
import { getStorage } from "@/lib/storage"

/**
 * 样机渲染同步服务
 *
 * mockup 任务不走 Redis 图像队列（外部服务自有队列/渲染机），生命周期：
 *   提交 action：建任务+扣费 → 外部 createRenderJob → processing(externalJobId)
 *   syncMockupJobs（worker 5s 循环 / cron 兜底）+ 前端轮询 action 双通道：
 *     SUCCEEDED → 下载结果转存本项目存储 → completed
 *     FAILED / CANCELLED / 超时 / 404 / 孤儿 → failed + refundFailedTask
 *
 * 所有终态落库用条件更新（status ∈ {queued, processing}）保证幂等，
 * 多通道并发触发不会双退款（refundFailedTask 内部亦有原子认领）。
 */

/** 外部任务卡死兜底：创建超 2 小时未终态按失败处理（jsxTimeout 上限 1h + 队列余量） */
const MAX_TASK_AGE_MS = 2 * 60 * 60 * 1000
/** 提交后一直没拿到 externalJobId 的宽限（素材中转/网络抖动） */
const ORPHAN_GRACE_MS = 10 * 60 * 1000

/* ─── 素材中转：本项目存储 URL → 外部 assetId（带缓存） ─── */

/**
 * 把本项目存储里的设计稿上传为外部渲染素材；同一企业同一图只传一次
 * （mockup_external_asset 缓存）。外部报 INVALID_INPUT_ASSET（素材过期清理）
 * 时由调用方 deleteExternalAssetCache 后重试一次。
 */
export async function getOrCreateExternalAsset(
  cfg: MockupApiConfig,
  enterpriseId: string,
  imageUrl: string,
): Promise<string> {
  const [hit] = await db
    .select({ assetId: mockupExternalAssets.assetId })
    .from(mockupExternalAssets)
    .where(
      and(
        eq(mockupExternalAssets.enterpriseId, enterpriseId),
        eq(mockupExternalAssets.imageUrl, imageUrl),
      ),
    )
    .limit(1)
  if (hit) return hit.assetId

  const assetId = await uploadExternalAsset(cfg, imageUrl)
  await db
    .insert(mockupExternalAssets)
    .values({ enterpriseId, imageUrl, assetId })
    .onConflictDoNothing()
  return assetId
}

/** 失效缓存（外部素材过期/失效时） */
export async function deleteExternalAssetCache(
  enterpriseId: string,
  imageUrl: string,
): Promise<void> {
  await db
    .delete(mockupExternalAssets)
    .where(
      and(
        eq(mockupExternalAssets.enterpriseId, enterpriseId),
        eq(mockupExternalAssets.imageUrl, imageUrl),
      ),
    )
}

async function uploadExternalAsset(
  cfg: MockupApiConfig,
  imageUrl: string,
): Promise<string> {
  // 从本项目存储拉取字节（URL 形态：绝对 https，本地存储或 COS）
  const res = await fetch(imageUrl, { cache: "no-store" })
  if (!res.ok) {
    throw new Error(`设计稿读取失败 HTTP ${res.status}`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error("设计稿内容为空")

  const ext = /\.(jpe?g|png)(?:[?#]|$)/i.exec(imageUrl)?.[1]?.toLowerCase()
  const safeExt = ext === "jpeg" ? "jpg" : (ext ?? "png")
  const mime = safeExt === "png" ? "image/png" : "image/jpeg"
  // 外部 fileName 仅允许 [a-zA-Z0-9._-]，不透传原始中文名
  const fileName = `mockup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`

  const ticket = await createAssetUploadUrl(cfg, {
    fileName,
    mimeType: mime,
    sizeBytes: bytes.length,
  })
  await putUploadBytes(cfg, ticket, bytes)
  const done = await completeAsset(cfg, ticket.assetId)
  return done.assetId
}

/* ─── 终态落库（幂等） ─── */

interface FinalizeOk {
  status: "completed"
  resultImages: string[]
}
interface FinalizeErr {
  status: "failed"
  errorMessage: string
}

/** 条件更新到终态（仅 queued/processing 可流转），失败自动退款 */
export async function finalizeMockupTask(
  taskId: string,
  outcome: FinalizeOk | FinalizeErr,
): Promise<boolean> {
  const patch =
    outcome.status === "completed"
      ? {
          status: "completed" as const,
          resultImages: outcome.resultImages,
          completedAt: new Date(),
        }
      : {
          status: "failed" as const,
          errorMessage: outcome.errorMessage,
          completedAt: new Date(),
        }
  const updated = await db
    .update(generationTasks)
    .set(patch)
    .where(
      and(
        eq(generationTasks.id, taskId),
        inArray(generationTasks.status, ["queued", "processing"]),
      ),
    )
    .returning({ id: generationTasks.id })
  if (updated.length === 0) return false // 已是终态（并发通道先处理）

  if (outcome.status === "failed") {
    await refundFailedTask(taskId)
  }
  return true
}

async function writeMockupApiLog(
  enterpriseId: string,
  taskId: string | null,
  responseSummary: string,
  errorMessage?: string,
): Promise<void> {
  try {
    await db.insert(apiCallLogs).values({
      enterpriseId,
      taskId,
      requestSummary: "mockup render",
      responseSummary,
      ...(errorMessage ? { errorMessage } : {}),
    })
  } catch {
    // 日志失败不影响主流程
  }
}

/* ─── 单任务同步 ─── */

/**
 * 查询外部任务并推进本地状态；返回是否仍在进行中。
 * terminal = false 表示已到终态（或判定失败）。
 */
export async function syncMockupTask(
  taskId: string,
  info: { externalJobId: string; enterpriseId: string },
): Promise<{ terminal: boolean; status: string }> {
  const [task] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, taskId))
    .limit(1)
  if (!task || task.status === "completed" || task.status === "failed") {
    return { terminal: true, status: task?.status ?? "unknown" }
  }

  const cfg = await loadMockupConfig(info.enterpriseId)
  if (!cfg) {
    // 配置被关闭/删除：宽限期后判失败退款
    if (Date.now() - task.createdAt.getTime() > ORPHAN_GRACE_MS) {
      await finalizeMockupTask(taskId, {
        status: "failed",
        errorMessage: "渲染服务配置已停用，任务终止（积分已退）",
      })
      return { terminal: true, status: "failed" }
    }
    return { terminal: false, status: task.status }
  }

  let job: ExternalRenderJob | null = null
  try {
    job = await getRenderJob(cfg, info.externalJobId)
  } catch (err) {
    const code = (err as { code?: string }).code
    const status = (err as { status?: number }).status
    // 任务不存在（外部数据被清理）：宽限后判失败
    if (code === "NOT_FOUND" || status === 404) {
      if (Date.now() - task.createdAt.getTime() > ORPHAN_GRACE_MS) {
        await finalizeMockupTask(taskId, {
          status: "failed",
          errorMessage: "渲染服务任务不存在（已退款）",
        })
        return { terminal: true, status: "failed" }
      }
      return { terminal: false, status: task.status }
    }
    // 网络/超时等瞬时错误：下轮再试；超龄兜底
    if (Date.now() - task.createdAt.getTime() > MAX_TASK_AGE_MS) {
      await finalizeMockupTask(taskId, {
        status: "failed",
        errorMessage: "渲染超时（积分已退）",
      })
      return { terminal: true, status: "failed" }
    }
    return { terminal: false, status: task.status }
  }

  return await applyExternalJob(taskId, task.enterpriseId, job)
}

/** 按外部任务状态推进本地任务（幂等） */
export async function applyExternalJob(
  taskId: string,
  enterpriseId: string,
  job: ExternalRenderJob,
): Promise<{ terminal: boolean; status: string }> {
  const [task] = await db
    .select({ templateInfo: generationTasks.templateInfo })
    .from(generationTasks)
    .where(eq(generationTasks.id, taskId))
    .limit(1)
  const info = parseMockupInfo(task?.templateInfo)

  // 进行中：合并最新 stage/progress（展示用，值变才写）
  const nonTerminal = ["QUEUED", "LEASED", "PROCESSING", "CANCELLING"]
  if (nonTerminal.includes(job.status)) {
    if (
      info &&
      (info.stage !== job.stage || info.progress !== job.progress) &&
      job.stage != null
    ) {
      await db
        .update(generationTasks)
        .set({
          templateInfo: {
            ...info,
            stage: job.stage,
            progress: job.progress,
          },
        })
        .where(eq(generationTasks.id, taskId))
    }
    return { terminal: false, status: "processing" }
  }

  if (job.status === "SUCCEEDED") {
    const cfg = await loadMockupConfig(enterpriseId)
    if (!cfg) {
      // 已成功但配置被停：下轮配置恢复后再转存
      return { terminal: false, status: "processing" }
    }
    try {
      const bytes = await fetchResultBytes(cfg, job)
      const ext = info?.outputFormat === "jpeg" ? "jpeg" : "png"
      const url = await (await getStorage()).saveFromBuffer(
        bytes,
        enterpriseId,
        ext,
        "generate",
      )
      await finalizeMockupTask(taskId, {
        status: "completed",
        resultImages: [url],
      })
      await writeMockupApiLog(enterpriseId, taskId, "SUCCEEDED")
      return { terminal: true, status: "completed" }
    } catch (err) {
      // 下载/转存失败：可重试（外部 resultUrl 有 3 天有效期），超龄兜底
      if (Date.now() - new Date(job.createdAt).getTime() > MAX_TASK_AGE_MS) {
        await finalizeMockupTask(taskId, {
          status: "failed",
          errorMessage: "渲染结果转存失败（积分已退）",
        })
        await writeMockupApiLog(
          enterpriseId,
          taskId,
          "RESULT_TRANSFER_FAILED",
          err instanceof Error ? err.message : String(err),
        )
        return { terminal: true, status: "failed" }
      }
      return { terminal: false, status: "processing" }
    }
  }

  // FAILED / CANCELLED
  const reason =
    job.status === "CANCELLED"
      ? "任务已取消（积分已退）"
      : (job.errorMessage ?? "渲染失败")
  await finalizeMockupTask(taskId, { status: "failed", errorMessage: reason })
  await writeMockupApiLog(
    enterpriseId,
    taskId,
    job.status,
    job.errorMessage ?? undefined,
  )
  return { terminal: true, status: "failed" }
}

/* ─── 批量同步（worker / cron 入口） ─── */

export async function syncMockupJobs(): Promise<{
  checked: number
  finalized: number
}> {
  // 1. 提交中断孤儿：queued 且无 externalJobId，超宽限期 → 失败退款
  const orphans = await db
    .select({ id: generationTasks.id })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        eq(generationTasks.status, "queued"),
        sql`${generationTasks.templateInfo}->>'externalJobId' IS NULL`,
        lt(generationTasks.createdAt, new Date(Date.now() - ORPHAN_GRACE_MS)),
      ),
    )
  for (const o of orphans) {
    await finalizeMockupTask(o.id, {
      status: "failed",
      errorMessage: "渲染任务提交中断（积分已退）",
    })
  }

  // 2. 在途任务：按 externalJobId 逐个查询推进
  const active = await db
    .select({
      id: generationTasks.id,
      enterpriseId: generationTasks.enterpriseId,
      templateInfo: generationTasks.templateInfo,
      createdAt: generationTasks.createdAt,
    })
    .from(generationTasks)
    .where(
      and(
        eq(generationTasks.taskType, "mockup"),
        inArray(generationTasks.status, ["queued", "processing"]),
        sql`${generationTasks.templateInfo}->>'externalJobId' IS NOT NULL`,
      ),
    )
    .limit(200)

  let finalized = orphans.length
  let checked = 0
  const cfgCache = new Map<string, MockupApiConfig | null>()
  for (const t of active) {
    checked++
    const info = parseMockupInfo(t.templateInfo)
    if (!info?.externalJobId) continue

    // 超龄兜底（外部侧卡死/状态机异常）
    if (Date.now() - t.createdAt.getTime() > MAX_TASK_AGE_MS) {
      await finalizeMockupTask(t.id, {
        status: "failed",
        errorMessage: "渲染超时（积分已退）",
      })
      finalized++
      continue
    }

    if (!cfgCache.has(t.enterpriseId)) {
      cfgCache.set(t.enterpriseId, await loadMockupConfig(t.enterpriseId))
    }
    const cfg = cfgCache.get(t.enterpriseId)
    if (!cfg) continue // 配置停用：宽限判定交给 syncMockupTask 的配置分支
    try {
      const job = await getRenderJob(cfg, info.externalJobId)
      const result = await applyExternalJob(t.id, t.enterpriseId, job)
      if (result.terminal) finalized++
    } catch {
      // 单任务异常跳过，下轮重试
    }
  }

  return { checked, finalized }
}

/** 取消在途渲染任务（用户侧）：外部取消 + 本地等待同步收敛 */
export async function cancelMockupRenderJob(
  enterpriseId: string,
  externalJobId: string,
): Promise<{ cancelled: boolean; message: string }> {
  const cfg = await loadMockupConfig(enterpriseId)
  if (!cfg) return { cancelled: false, message: "渲染服务未配置" }
  try {
    const res = await cancelRenderJob(cfg, externalJobId, "用户取消")
    return {
      cancelled: res.updated,
      message: res.updated ? "取消请求已发送" : "任务已处于终态",
    }
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 409) return { cancelled: false, message: "任务已处于终态" }
    return {
      cancelled: false,
      message: err instanceof Error ? err.message : "取消失败",
    }
  }
}

/* ─── 提交渲染（供 action 调用） ─── */

/**
 * 向外部服务提交渲染任务（素材中转 + createRenderJob）。
 * INVALID_INPUT_ASSET 时失效缓存重试一次。返回 externalJobId。
 */
export async function submitExternalRenderJob(
  cfg: MockupApiConfig,
  enterpriseId: string,
  opts: {
    templateVersionId: string
    /** 绑定 ID → 本项目图片 URL / 文本 */
    input: Record<string, { imageUrl?: string; text?: string }>
    idempotencyKey: string
    /** 终端用户（私有模板渲染权限校验） */
    user?: MockupUserContext
  },
): Promise<string> {
  const buildInput = async (
    invalidateCache: boolean,
  ): Promise<Record<string, { assetId?: string; text?: string }>> => {
    const input: Record<string, { assetId?: string; text?: string }> = {}
    for (const [bindingId, value] of Object.entries(opts.input)) {
      if (value.imageUrl) {
        if (invalidateCache) {
          await deleteExternalAssetCache(enterpriseId, value.imageUrl)
        }
        input[bindingId] = {
          assetId: await getOrCreateExternalAsset(
            cfg,
            enterpriseId,
            value.imageUrl,
          ),
        }
      } else if (value.text != null) {
        input[bindingId] = { text: value.text }
      }
    }
    return input
  }

  let input = await buildInput(false)
  try {
    const res = await createRenderJob(
      cfg,
      {
        templateVersionId: opts.templateVersionId,
        input,
        idempotencyKey: opts.idempotencyKey,
      },
      opts.user,
    )
    return res.jobId
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === "INVALID_INPUT_ASSET") {
      // 缓存的素材已被外部清理：失效重传一次
      input = await buildInput(true)
      const res = await createRenderJob(
        cfg,
        {
          templateVersionId: opts.templateVersionId,
          input,
          idempotencyKey: opts.idempotencyKey,
        },
        opts.user,
      )
      return res.jobId
    }
    throw err
  }
}
