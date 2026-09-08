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
  createRenderJobsBatch,
  fetchResultBytes,
  getRenderJob,
  getRenderJobs,
  importAssetFromUrl,
  putUploadBytes,
  type ExternalRenderJob,
  type MockupApiConfig,
  type MockupUserContext,
} from "@/lib/mockup/client"
import { loadMockupConfig } from "@/lib/mockup/settings"
import { parseMockupInfo } from "@/lib/mockup/task-info"
import { refundFailedTask } from "@/server/services/credits-service"
import { getStorage } from "@/lib/storage"
import { env } from "@/lib/env"

/**
 * 样机渲染同步服务
 *
 * mockup 任务不走 Redis 图像队列（外部服务自有队列/渲染机），生命周期：
 *   提交 action：建任务+扣费 → after() 后台 submitMockupTasksToExternal：
 *     素材中转 → 外部 createRenderJob(s) → processing(externalJobId)
 *   syncMockupJobs（worker 5s 循环 / cron 兜底）+ 前端轮询 action 双通道：
 *     SUCCEEDED → 下载结果转存本项目存储 → completed
 *     FAILED / CANCELLED / 超时 / 404 / 孤儿 → failed + refundFailedTask
 *
 * 所有终态落库用条件更新（status ∈ {queued, processing}）保证幂等，
 * 多通道并发触发不会双退款（refundFailedTask 内部亦有原子认领）。
 */

/** 外部任务卡死兜底：创建超 4 小时未终态按失败处理（jsxTimeout 上限 1h；
 * 单批次最多 100 任务在外部串行渲染，尾部任务排队可达数小时） */
const MAX_TASK_AGE_MS = 4 * 60 * 60 * 1000
/** 提交后一直没拿到 externalJobId 的宽限（素材中转/网络抖动） */
const ORPHAN_GRACE_MS = 10 * 60 * 1000

/**
 * 渲染终态 webhook 回调地址：企业已配 webhookSecret 且应用外部基址可用时
 * 才启用（PS-API 终态主动推送，轮询降为兜底）；否则 undefined（纯轮询）。
 */
export function mockupRenderWebhookUrl(
  cfg: { webhookSecret?: string },
  enterpriseId: string,
): string | undefined {
  if (!cfg.webhookSecret) return undefined
  const base = (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "")
  if (!base) return undefined
  return `${base}/api/mockup/render-webhook?ent=${encodeURIComponent(enterpriseId)}`
}

/* ─── 素材中转：本项目存储 URL → 外部 assetId（带缓存） ─── */

/** 有限并发逐项执行（保序返回；无第三方依赖） */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i]!)
      }
    }),
  )
  return results
}

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

/**
 * 预导入：把一批本项目存储图片提前转为外部渲染素材（填充 imageUrl→assetId
 * 缓存）。去重后有限并发，逐 url 独立 ok/失败互不影响。用于图片库上传后与
 * 批量替换选图时预热——正式提交只查缓存，不再串行等待外部拉图。
 */
export async function prewarmExternalAssets(
  cfg: MockupApiConfig,
  enterpriseId: string,
  imageUrls: string[],
  opts: { concurrency?: number } = {},
): Promise<Array<{ url: string; ok: boolean; error?: string }>> {
  const unique = [...new Set(imageUrls)]
  return mapLimit(unique, opts.concurrency ?? 4, async (url) => {
    try {
      await getOrCreateExternalAsset(cfg, enterpriseId, url)
      return { url, ok: true }
    } catch (err) {
      return {
        url,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })
}

async function uploadExternalAsset(
  cfg: MockupApiConfig,
  imageUrl: string,
): Promise<string> {
  // 存储侧允许 jpg/png/webp/gif；扩展名缺失按 png 兜底（保持既有行为）
  const ext = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(imageUrl)?.[1]?.toLowerCase()
  const safeExt = ext === "jpeg" ? "jpg" : (ext ?? "png")
  const mime =
    safeExt === "png"
      ? "image/png"
      : safeExt === "webp"
        ? "image/webp"
        : safeExt === "gif"
          ? "image/gif"
          : "image/jpeg"
  // 外部 fileName 仅允许 [a-zA-Z0-9._-]，不透传原始中文名
  const fileName = `mockup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`

  // 优先 URL 直传：PS-API 服务端拉取 + sha256 秒传，省去本服务「下载再上传」
  // 的双倍带宽中转；任何失败（旧版无此端点 / URL 对外部不可达如本地存储或
  // 内网地址 / SSRF 拒绝 / 上游超时）都回退三步中转上传
  try {
    const imported = await importAssetFromUrl(cfg, {
      url: imageUrl,
      fileName,
      mimeType: mime,
    })
    return imported.assetId
  } catch {
    // 回退三步中转（下方）
  }

  // 从本项目存储拉取字节（URL 形态：绝对 https，本地存储或 COS）；
  // 带超时防止无限阻塞串行提交链
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  let res: Response
  try {
    res = await fetch(imageUrl, { cache: "no-store", signal: controller.signal })
  } catch {
    throw new Error("设计稿读取超时或失败")
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`设计稿读取失败 HTTP ${res.status}`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error("设计稿内容为空")

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

/**
 * 批量推进在途任务：按企业分组一次批量查询外部状态（GET ?ids=），
 * 逐任务 applyExternalJob。旧版 PS-API 无批量查询（404）/瞬时错误时
 * 回退逐任务 syncMockupTask（含 404 宽限与配置停用判定）。
 */
export async function syncMockupTasks(
  tasks: Array<{
    id: string
    enterpriseId: string
    templateInfo: unknown
    createdAt: Date
  }>,
): Promise<{ checked: number; finalized: number }> {
  let checked = 0
  let finalized = 0
  const byEnterprise = new Map<string, typeof tasks>()
  for (const t of tasks) {
    const list = byEnterprise.get(t.enterpriseId) ?? []
    list.push(t)
    byEnterprise.set(t.enterpriseId, list)
  }
  for (const [enterpriseId, group] of byEnterprise) {
    const cfg = await loadMockupConfig(enterpriseId)
    const pending: Array<{
      id: string
      externalJobId: string
      createdAt: Date
    }> = []
    for (const t of group) {
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
      if (cfg) {
        pending.push({
          id: t.id,
          externalJobId: info.externalJobId,
          createdAt: t.createdAt,
        })
      }
    }
    if (!cfg || pending.length === 0) continue

    let jobs: Map<string, ExternalRenderJob> | null = null
    try {
      const res = await getRenderJobs(cfg, pending.map((p) => p.externalJobId))
      jobs = new Map()
      for (const j of res.jobs ?? []) {
        if (j && !("notFound" in j)) jobs.set(j.jobId, j)
      }
    } catch {
      jobs = null // 旧版无批量端点（404）或瞬时错误 → 逐任务回退
    }
    if (!jobs) {
      for (const p of pending) {
        try {
          const r = await syncMockupTask(p.id, {
            externalJobId: p.externalJobId,
            enterpriseId,
          })
          if (r.terminal) finalized++
        } catch {
          // 单任务同步失败不影响其余，下轮重试
        }
      }
      continue
    }

    for (const p of pending) {
      const job = jobs.get(p.externalJobId)
      if (job) {
        const r = await applyExternalJob(p.id, enterpriseId, job)
        if (r.terminal) finalized++
      } else if (Date.now() - p.createdAt.getTime() > ORPHAN_GRACE_MS) {
        // 外部任务不存在（数据被清理）：宽限后判失败退款
        await finalizeMockupTask(p.id, {
          status: "failed",
          errorMessage: "渲染服务任务不存在（已退款）",
        })
        finalized++
      }
    }
  }
  return { checked, finalized }
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
      // 扩展名与 mime 对齐外部实际格式（jpeg 落 .jpg；psd 保留图层源文件）
      const ext =
        info?.outputFormat === "psd"
          ? "psd"
          : info?.outputFormat === "jpeg"
            ? "jpg"
            : "png"
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

  // 2. 在途任务：一次批量查询外部状态逐任务推进（旧版服务自动回退逐个）
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

  const syncResult = await syncMockupTasks(active)
  return {
    checked: syncResult.checked,
    finalized: orphans.length + syncResult.finalized,
  }
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

/** 构建外部提交 input：图片绑定解析为 assetId（带缓存），文字绑定透传 */
async function buildExternalInput(
  cfg: MockupApiConfig,
  enterpriseId: string,
  input: Record<string, { imageUrl?: string; text?: string }>,
  invalidateCache: boolean,
): Promise<Record<string, { assetId?: string; text?: string }>> {
  const externalInput: Record<string, { assetId?: string; text?: string }> = {}
  for (const [bindingId, value] of Object.entries(input)) {
    if (value.imageUrl) {
      if (invalidateCache) {
        await deleteExternalAssetCache(enterpriseId, value.imageUrl)
      }
      externalInput[bindingId] = {
        assetId: await getOrCreateExternalAsset(cfg, enterpriseId, value.imageUrl),
      }
    } else if (value.text != null) {
      externalInput[bindingId] = { text: value.text }
    }
  }
  return externalInput
}

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
    /** 导出格式（缺省 png，与外部端点默认一致） */
    outputFormat?: "png" | "jpeg" | "psd"
    /** 终端用户（私有模板渲染权限校验） */
    user?: MockupUserContext
  },
): Promise<string> {
  let input = await buildExternalInput(cfg, enterpriseId, opts.input, false)
  try {
    const res = await createRenderJob(
      cfg,
      {
        templateVersionId: opts.templateVersionId,
        input,
        idempotencyKey: opts.idempotencyKey,
        outputFormat: opts.outputFormat,
      },
      opts.user,
    )
    return res.jobId
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === "INVALID_INPUT_ASSET") {
      // 缓存的素材已被外部清理：失效重传一次
      input = await buildExternalInput(cfg, enterpriseId, opts.input, true)
      const res = await createRenderJob(
        cfg,
        {
          templateVersionId: opts.templateVersionId,
          input,
          idempotencyKey: opts.idempotencyKey,
          outputFormat: opts.outputFormat,
        },
        opts.user,
      )
      return res.jobId
    }
    throw err
  }
}

/**
 * 批量向外部服务提交渲染任务（优先 POST /v1/render-jobs/batch 一次 HTTP）。
 *
 * - 素材预解析：跨任务按 url 去重后并发导入（选图时已预热的直接命中缓存）；
 *   个别素材导入失败只回退该项逐个提交，其余仍走批量端点。
 * - 批量端点不可用（旧版 PS-API 404 / 网关异常 / 超时）→ 整体回退逐个提交；
 *   单项失败（含 INVALID_INPUT_ASSET 素材被清理）→ 该项回退逐个提交
 *   （submitExternalRenderJob 内含失效重传重试）。
 * - 本函数不抛错：结果与 items 位置对齐，逐项 ok/失败原因。
 */
export async function submitExternalRenderJobsBatch(
  cfg: MockupApiConfig,
  enterpriseId: string,
  opts: {
    items: Array<{
      templateVersionId: string
      input: Record<string, { imageUrl?: string; text?: string }>
      idempotencyKey: string
      /** 导出格式（缺省 png，与外部端点默认一致） */
      outputFormat?: "png" | "jpeg" | "psd"
    }>
    /** 终端用户（私有模板渲染权限校验） */
    user?: MockupUserContext
    /** 终态 webhook 回调地址（未配置则不启用推送，轮询兜底） */
    webhookUrl?: string
  },
): Promise<
  Array<{ ok: true; externalJobId: string } | { ok: false; message: string }>
> {
  const submitOne = async (
    item: {
      templateVersionId: string
      input: Record<string, { imageUrl?: string; text?: string }>
      idempotencyKey: string
      outputFormat?: "png" | "jpeg" | "psd"
    },
  ): Promise<{ ok: true; externalJobId: string } | { ok: false; message: string }> => {
    try {
      return {
        ok: true,
        externalJobId: await submitExternalRenderJob(
          cfg,
          enterpriseId,
          { ...item, user: opts.user },
        ),
      }
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  try {
    // 素材预解析：跨任务按 url 去重后并发导入（选图时已预热的直接命中缓存）；
    // 个别 url 导入失败只回退该项逐个提交，不拖垮整批批量端点
    const urlSet = new Set<string>()
    for (const item of opts.items) {
      for (const v of Object.values(item.input)) {
        if (v.imageUrl) urlSet.add(v.imageUrl)
      }
    }
    const assetByUrl = new Map<string, string>()
    const brokenUrls = new Set<string>()
    const prewarmed = await mapLimit([...urlSet], 4, async (url) => {
      try {
        return { url, assetId: await getOrCreateExternalAsset(cfg, enterpriseId, url) }
      } catch {
        return { url, assetId: null as string | null }
      }
    })
    for (const p of prewarmed) {
      if (p.assetId) assetByUrl.set(p.url, p.assetId)
      else brokenUrls.add(p.url)
    }
    const inputs = opts.items.map((item) => {
      const external: Record<string, { assetId?: string; text?: string }> = {}
      for (const [bindingId, value] of Object.entries(item.input)) {
        if (value.imageUrl) {
          const assetId = assetByUrl.get(value.imageUrl)
          if (assetId) external[bindingId] = { assetId }
        } else if (value.text != null) {
          external[bindingId] = { text: value.text }
        }
      }
      return external
    })
    const fallbackIndexes = new Set<number>()
    opts.items.forEach((item, i) => {
      const broken = Object.values(item.input).some(
        (v) => v.imageUrl && brokenUrls.has(v.imageUrl),
      )
      if (broken) fallbackIndexes.add(i)
    })
    const batchIndexes = opts.items.map((_, i) => i).filter((i) => !fallbackIndexes.has(i))

    const out: Array<{ ok: true; externalJobId: string } | { ok: false; message: string }> =
      opts.items.map(() => ({ ok: false, message: "批量提交未返回该项结果" }))
    const resolved = new Set<number>()
    // 外部批量端点单次上限 50：分块顺序提交后合并结果；
    // 某块整体失败（旧版远端无端点/超时）只回退该块未决项，不影响已成功块
    const BATCH_CHUNK = 50
    for (let c = 0; c < batchIndexes.length; c += BATCH_CHUNK) {
      const chunk = batchIndexes.slice(c, c + BATCH_CHUNK)
      try {
        const res = await createRenderJobsBatch(
          cfg,
          {
            jobs: chunk.map((i) => ({
              idempotencyKey: opts.items[i]!.idempotencyKey,
              templateVersionId: opts.items[i]!.templateVersionId,
              input: inputs[i]!,
              outputFormat: opts.items[i]!.outputFormat,
            })),
            webhookUrl: opts.webhookUrl,
          },
          opts.user,
        )
        for (const r of res.results ?? []) {
          // r.index 为该块 jobs 数组内的下标
          const itemIdx = chunk[r.index]
          if (itemIdx == null) continue
          resolved.add(itemIdx)
          // 兼容旧版远端：ok 项的任务编号可能在 jobId 或 jobCode 字段上
          const jobId = r.ok ? (r.jobId ?? r.jobCode) : undefined
          if (jobId) {
            out[itemIdx] = { ok: true, externalJobId: jobId }
          } else if (r.error === "INVALID_INPUT_ASSET") {
            // 缓存素材被外部清理：单项回退逐个提交（内含失效重传重试）
            fallbackIndexes.add(itemIdx)
          } else if (r.ok) {
            // ok=true 但任务编号缺失（旧版远端批量结果误用 jobCode 且被响应
            // schema 序列化剥掉）：任务实际已创建，按同一幂等键单发重取——
            // 单任务端点幂等命中会返回已有任务的 jobId，不会重复创建
            fallbackIndexes.add(itemIdx)
          } else {
            out[itemIdx] = {
              ok: false,
              message:
                r.message ??
                r.error ??
                `提交渲染失败（外部原始返回：${JSON.stringify(r).slice(0, 160)}）`,
            }
          }
        }
      } catch {
        for (const i of chunk) {
          if (!resolved.has(i)) fallbackIndexes.add(i)
        }
      }
    }
    // 串行重试：INVALID_INPUT_ASSET 的失效重传会为共享素材（如各任务相同的
    // 固定图）逐个新建 asset，并行会互相竞争占用导致再次失败
    for (const i of fallbackIndexes) {
      out[i] = await submitOne(opts.items[i]!)
    }
    return out
  } catch {
    // 批量端点异常（旧版无此端点 / 超时 / 网关错误）：逐个提交兜底
    return Promise.all(opts.items.map(submitOne))
  }
}

/**
 * 后台提交批量任务到外部渲染服务（submitMockupBatchAction 经 after() 调度，
 * 不阻塞 HTTP 响应）：素材中转 + 批量创建 + 逐任务落 externalJobId / 失败退款。
 *
 * - 幂等键 = taskUuid：若与清扫/重试通道并发重复提交，外部端点按幂等键
 *   返回同一任务，不会重复渲染。
 * - 落库用条件更新（仅 queued/processing 可流转）：提交耗时超过孤儿宽限
 *   被清扫判失败退款的任务不会被这里复活成 processing。
 * - 单任务提交失败：条件更新到 failed + refundFailedTask（内部原子认领）。
 */
export async function submitMockupTasksToExternal(
  cfg: MockupApiConfig,
  enterpriseId: string,
  opts: {
    tasks: Array<{
      id: string
      /** 幂等键（taskUuid） */
      idempotencyKey: string
      /** 绑定 ID → 本项目图片 URL / 文本 */
      input: Record<string, { imageUrl?: string; text?: string }>
    }>
    templateVersionId: string
    /** 导出格式（缺省 png，与外部端点默认一致） */
    outputFormat?: "png" | "jpeg" | "psd"
    /** 终端用户（私有模板渲染权限校验） */
    user?: MockupUserContext
    /** 终态 webhook 回调地址（未配置则不启用推送，轮询兜底） */
    webhookUrl?: string
    /** 失败任务的展示标签（与 tasks 位置对齐；缺省用序号） */
    labels?: string[]
  },
): Promise<{
  submitted: number
  failed: Array<{ id: string; label: string; message: string }>
}> {
  const submitResults = await submitExternalRenderJobsBatch(cfg, enterpriseId, {
    items: opts.tasks.map((t) => ({
      templateVersionId: opts.templateVersionId,
      input: t.input,
      idempotencyKey: t.idempotencyKey,
      outputFormat: opts.outputFormat,
    })),
    user: opts.user,
    webhookUrl: opts.webhookUrl,
  })

  let submitted = 0
  const failed: Array<{ id: string; label: string; message: string }> = []
  for (let i = 0; i < opts.tasks.length; i++) {
    const t = opts.tasks[i]!
    const result = submitResults[i]!
    const label = opts.labels?.[i] ?? `第 ${i + 1} 张`
    if (result.ok) {
      const updated = await db
        .update(generationTasks)
        .set({
          status: "processing",
          startedAt: new Date(),
          templateInfo: sql`jsonb_set(coalesce(${generationTasks.templateInfo}, '{}'::jsonb), '{externalJobId}', ${JSON.stringify(result.externalJobId)}::jsonb)`,
        })
        .where(
          and(
            eq(generationTasks.id, t.id),
            inArray(generationTasks.status, ["queued", "processing"]),
          ),
        )
        .returning({ id: generationTasks.id })
      if (updated.length > 0) submitted++
    } else {
      // result.message 已是可读字符串（service 层产出的具体原因），直接透传
      const message = result.message || "提交渲染失败"
      const updated = await db
        .update(generationTasks)
        .set({ status: "failed", errorMessage: message, completedAt: new Date() })
        .where(
          and(
            eq(generationTasks.id, t.id),
            inArray(generationTasks.status, ["queued", "processing"]),
          ),
        )
        .returning({ id: generationTasks.id })
      if (updated.length > 0) {
        await refundFailedTask(t.id)
        await writeMockupApiLog(enterpriseId, t.id, "SUBMIT_FAILED", message)
        failed.push({ id: t.id, label, message })
      }
    }
  }
  return { submitted, failed }
}
