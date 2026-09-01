import { and, desc, eq, inArray, lt, ne } from "drizzle-orm"
import { db } from "@/db/client"
import {
  apiCallLogs,
  cardImages,
  conversations,
  enterprises,
  generationTasks,
  models,
  permissionGroups,
  promptCards,
  users,
} from "@/db/schema"
import {
  listEnterprisesWithPendingTasks,
  dequeueNext,
  completeTask,
  failTask,
  setTaskPendingIndexes,
  acquireImageSlot,
  releaseImageSlot,
  enqueue,
  isTaskInQueue,
  getTaskStatus,
  type QueueTaskInput,
} from "@/lib/queue/task-queue"
import { callImageApi } from "@/lib/ai"
import { mergeImageResults } from "@/lib/ai/image-model-config"
import { env } from "@/lib/env"
import { getStorage } from "@/lib/storage"
import { refundFailedTask } from "@/server/actions/create"

/**
 * 队列消费核心逻辑（手册 §5.4）
 *
 * 与触发方式解耦：既被 `/api/cron/process-queue` 路由调用（手动 curl / 外部
 * cron 兜底），也被独立 worker 进程（scripts/worker.ts）调用。两者共用同一
 * 份消费逻辑，避免行为漂移。
 *
 * 每次调用：扫描有待处理任务的企业 → 各 dequeue 一批（受企业图片并发上限约束）
 * → 调 AI 适配器（OpenAI 逐张占用图片槽位，并发受企业+模型上限约束）→ 写回结果。
 *
 * 部分失败语义：单张失败不影响其他张；已成功图片持久保留，重试仅补失败张；
 * 重试用尽后按最终失败张数退积分、任务标记 completed（附失败说明）。
 */

export interface ProcessResult {
  enterpriseId: string
  processed: number
  failed: number
}

/** 部分图片生成失败（已持久化成功部分并记日志，由 handleTaskFailure 决策） */
class PartialImageFailureError extends Error {
  constructor(
    public failedCount: number,
    public totalCount: number,
    /** 每张失败图的具体原因（如「第 1 张: OpenAI 生图 API 错误 404: …」） */
    public details?: string,
  ) {
    super(
      `${failedCount}/${totalCount} 张图片生成失败${details ? `（${details}）` : ""}`,
    )
    this.name = "PartialImageFailureError"
  }
}

/**
 * 工作台生图回写：任务终态时同步关联的 card_image 行（status/imageUrl/errorMessage）。
 * 翻卡轮询（getTaskCardImagesAction）读的是 card_image.status，不回写则卡片
 * 永久显示加载中。按 generationTaskId 反查；非工作台任务无关联行，更新 0 行即空操作。
 *
 * 一次生成可能返回多张图（如即梦固定出 4 张）：首张写回原 pending 行，
 * 其余追加为新的 completed 行（按 generationTaskId+imageUrl 去重，重试幂等）。
 */
async function syncCardImagesOnTerminal(opts: {
  generationTaskId: string
  status: "completed" | "failed"
  imageUrls?: string[]
  errorMessage?: string | null
}): Promise<void> {
  const rows = await db
    .select()
    .from(cardImages)
    .where(eq(cardImages.generationTaskId, opts.generationTaskId))
  if (rows.length === 0) return

  const urls = (opts.imageUrls ?? []).filter(Boolean)
  if (opts.status === "failed" || urls.length === 0) {
    await db
      .update(cardImages)
      .set({
        status: opts.status,
        errorMessage: opts.errorMessage ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cardImages.generationTaskId, opts.generationTaskId))
    return
  }

  // 成功：首张写回首个关联行（保持 pending 行 -> completed），其余按需追加
  const first = rows[0]!
  await db
    .update(cardImages)
    .set({
      status: "completed",
      imageUrl: urls[0]!,
      errorMessage: opts.errorMessage ?? null,
      updatedAt: new Date(),
    })
    .where(eq(cardImages.id, first.id))

  const existingUrls = new Set(rows.map((r) => r.imageUrl))
  const toInsert = urls.slice(1).filter((u) => !existingUrls.has(u))
  if (toInsert.length > 0) {
    await db.insert(cardImages).values(
      toInsert.map((url) => ({
        enterpriseId: first.enterpriseId,
        cardId: first.cardId,
        generationTaskId: opts.generationTaskId,
        imageApiId: first.imageApiId,
        imageUrl: url,
        size: first.size,
        status: "completed" as const,
        isSelected: false,
        generationPrompt: first.generationPrompt,
        source: first.source,
      })),
    )
  }

  // 兜底选图：卡片从未显式选图时自动指向一张已完成图，保证 selImgUrl /
  // 导出（ZIP/逐张）始终可用（不覆盖用户显式选择）
  await ensureCardSelection(
    first.enterpriseId,
    [...new Set(rows.map((r) => r.cardId))],
  )
}

/**
 * 卡片选图兜底（终态自动选中）：selectedImageId 为空的卡片按
 * 「isSelected 命中 → 最新已完成（createdAt 降序）」自动指向一张图，
 * 并维护 isSelected 互斥（与 selectCardImageAction 语义一致）。
 */
async function ensureCardSelection(
  enterpriseId: string,
  cardIds: string[],
): Promise<void> {
  if (cardIds.length === 0) return
  const cards = await db
    .select({ id: promptCards.id, selectedImageId: promptCards.selectedImageId })
    .from(promptCards)
    .where(
      and(
        eq(promptCards.enterpriseId, enterpriseId),
        inArray(promptCards.id, cardIds),
      ),
    )
  const unresolved = cards.filter((c) => !c.selectedImageId).map((c) => c.id)
  if (unresolved.length === 0) return

  const imgs = await db
    .select({
      id: cardImages.id,
      cardId: cardImages.cardId,
      isSelected: cardImages.isSelected,
    })
    .from(cardImages)
    .where(
      and(
        eq(cardImages.enterpriseId, enterpriseId),
        inArray(cardImages.cardId, unresolved),
        eq(cardImages.status, "completed"),
      ),
    )
    .orderBy(desc(cardImages.createdAt))

  // 每卡取一张：isSelected 命中优先，否则首个（最新）
  const pickByCard = new Map<string, { id: string; isSelected: boolean }>()
  for (const img of imgs) {
    const cur = pickByCard.get(img.cardId)
    if (!cur || (img.isSelected && !cur.isSelected)) {
      pickByCard.set(img.cardId, { id: img.id, isSelected: img.isSelected })
    }
  }

  for (const [cardId, pick] of pickByCard) {
    const now = new Date()
    await db
      .update(cardImages)
      .set({ isSelected: false, updatedAt: now })
      .where(
        and(
          eq(cardImages.cardId, cardId),
          eq(cardImages.enterpriseId, enterpriseId),
        ),
      )
    await db
      .update(cardImages)
      .set({ isSelected: true, updatedAt: now })
      .where(eq(cardImages.id, pick.id))
    await db
      .update(promptCards)
      .set({ selectedImageId: pick.id, updatedAt: now })
      .where(eq(promptCards.id, cardId))
  }
}

/**
 * 处理单个任务并兜底失败路径（含重试判断；部分失败时仅重试失败张）。
 * 单任务失败不影响其他任务；返回是否成功。供 processQueueOnce（cron 兜底）
 * 与 processQueueContinuous（常驻 worker）共用，避免两种消费模式行为漂移。
 */
async function runTaskSafely(
  task: QueueTaskInput,
  enterpriseMaxConcurrent: number,
): Promise<boolean> {
  try {
    await processOneTask(task, enterpriseMaxConcurrent)
    return true
  } catch (err) {
    console.error(
      `[queue] 任务 ${task.taskId} 失败:`,
      err instanceof Error ? err.message : err,
    )
    try {
      await handleTaskFailure(task, err)
    } catch (failErr) {
      console.error(
        `[queue] 任务 ${task.taskId} 失败后续处理异常:`,
        failErr instanceof Error ? failErr.message : failErr,
      )
    }
    return false
  }
}

/**
 * 执行一轮队列消费：扫描全部有待处理任务的企业，各消费一批任务并行处理。
 *
 * 一轮内每个企业最多取 min(企业并发上限, WORKER_TASK_CONCURRENCY) 个任务，
 * 用 Promise.allSettled 并行执行（单任务失败不影响其他任务）。跨进程总并发
 * 仍由 acquireImageSlot 的企业+模型 Redis 槽位约束；超出的任务在适配器
 * waitForSlot 里按 500ms 轮询自然排队。进程内上限用于保护 DB 连接池。
 *
 * 注意：本函数会等整批任务全部结束才返回（批间队头阻塞），适合 cron 单次
 * 兜底触发；常驻 worker 应使用 processQueueContinuous（完成即补位）。
 */
export async function processQueueOnce(): Promise<ProcessResult[]> {
  const enterprisesWithTasks = await listEnterprisesWithPendingTasks()
  const results: ProcessResult[] = []

  for (const enterpriseId of enterprisesWithTasks) {
    const [ent] = await db
      .select()
      .from(enterprises)
      .where(eq(enterprises.id, enterpriseId))
      .limit(1)
    if (!ent || ent.status !== "active") continue

    const maxInFlight = Math.min(
      Math.max(1, ent.maxConcurrent),
      env.WORKER_TASK_CONCURRENCY,
    )

    const batch: QueueTaskInput[] = []
    for (let i = 0; i < maxInFlight; i++) {
      const task = await dequeueNext({
        enterpriseId,
        enterpriseMaxConcurrent: ent.maxConcurrent,
      })
      if (!task) break
      batch.push(task)
    }

    const settled = await Promise.allSettled(
      batch.map((task) => runTaskSafely(task, ent.maxConcurrent)),
    )
    const processed = settled.filter(
      (s) => s.status === "fulfilled" && s.value,
    ).length
    const failed = settled.length - processed

    results.push({ enterpriseId, processed, failed })
  }

  return results
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 孤儿任务回收（worker 崩溃 / tsx watch 重启丢失在途任务的兜底）。
 *
 * 出队是 ZREM 原子弹出：任务一旦出队就脱离了队列，若 worker 进程随后死亡
 * （开发期 tsx watch 每次保存文件都会重启 worker；生产重启/崩溃同理），
 * 任务 DB 停在 queued/processing 且永远不会再被消费——卡片表现为永久
 * 「生成中」。回收条件：非终态 + 创建时间超过阈值 + 不在 Redis 队列 →
 * 按 DB 行重新入队（幂等：已在队列中的任务跳过；终态任务由消费端防重
 * 守卫拦截，不会重复生图扣费）。
 *
 * 阈值取 15 分钟：需覆盖最长合法在途时间（taskTimeout 300s + 轮询 + 重试
 * 排队），避免误伤正在处理的任务导致双跑。
 */
const ORPHAN_STALE_MS = 15 * 60 * 1000
/** 回收扫描周期（连续消费循环内嵌，无需额外定时器） */
const ORPHAN_SCAN_INTERVAL_MS = 5 * 60 * 1000

export async function recoverOrphanTasks(): Promise<number> {
  const staleBefore = new Date(Date.now() - ORPHAN_STALE_MS)
  const candidates = await db
    .select()
    .from(generationTasks)
    .where(
      and(
        inArray(generationTasks.status, ["queued", "processing"]),
        lt(generationTasks.createdAt, staleBefore),
        // 样机任务不走 Redis 队列（外部服务驱动，mockup-service 同步），
        // 不在回收范围内，否则会被误判孤儿并塞进图像队列
        ne(generationTasks.taskType, "mockup"),
      ),
    )
    .limit(200)

  let recovered = 0
  for (const row of candidates) {
    // 防御：无模型的任务不是图像队列任务（样机等），交给各自同步通道
    if (!row.modelId) continue
    // 仍在队列 = 正常排队等待，不是孤儿
    if (await isTaskInQueue(row.enterpriseId, row.id)) continue

    // Redis 元数据显示正被消费且开始时间未超阈值 = 活跃 worker 在处理。
    // 不检查会被 createdAt 误判：排队超阈值、刚被消费 1 秒的任务会立即
    // 被重新入队 → 与在跑 worker 双跑、双退款。
    const meta = await getTaskStatus(row.enterpriseId, row.id)
    if (meta?.status === "processing" && meta.startedAt) {
      const startedAt = Number(meta.startedAt)
      if (Number.isFinite(startedAt) && Date.now() - startedAt < ORPHAN_STALE_MS) {
        continue
      }
    }

    // 全部序号已成功：崩在「持久化成功图之后、任务终态之前」——直接补终态
    const succeeded = row.succeededIndexes ?? []
    const pendingIndexes = Array.from({ length: row.imageCount }, (_, i) => i)
      .filter((i) => !succeeded.includes(i))
    if (pendingIndexes.length === 0) {
      await db
        .update(generationTasks)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(generationTasks.id, row.id))
      console.warn(`[queue] 回收孤儿任务 ${row.id}：全部序号已成功，补写终态 completed`)
      recovered++
      continue
    }

    // 模型已删除：无法重跑，按失败终态处理（退款走 refundFailedTask 语义）
    const [model] = await db
      .select()
      .from(models)
      .where(eq(models.id, row.modelId))
      .limit(1)
    if (!model) {
      await refundFailedTask(row.id)
      await db
        .update(generationTasks)
        .set({
          status: "failed",
          errorMessage: "任务丢失后回收失败：模型已删除",
          completedAt: new Date(),
        })
        .where(eq(generationTasks.id, row.id))
      console.warn(`[queue] 回收孤儿任务 ${row.id}：模型已删除，置 failed 并退款`)
      recovered++
      continue
    }

    // 重新入队（超时/重试参数取模型现值；只补未成功序号）
    await enqueue({
      taskId: row.id,
      enterpriseId: row.enterpriseId,
      modelId: row.modelId,
      prompt: row.prompt,
      imageSize: row.imageSize ?? "1024x1024",
      imageCount: row.imageCount,
      referenceImages: row.referenceImages ?? [],
      priority: row.priority,
      costPerImage: row.costPerImage ?? model.costPerImage,
      apiTimeout: model.apiTimeout,
      taskTimeout: model.taskTimeout,
      maxRetries: model.maxRetries,
      conversationId: row.conversationId,
      pendingIndexes,
    })
    await db
      .update(generationTasks)
      .set({ status: "queued" })
      .where(eq(generationTasks.id, row.id))
    console.warn(
      `[queue] 回收孤儿任务 ${row.id}（原状态 ${row.status}，重新入队补 ${pendingIndexes.length} 张；疑似 worker 重启丢失）`,
    )
    recovered++
  }
  return recovered
}

/**
 * 常驻滑动窗口消费循环（worker 进程专用，替代 while + processQueueOnce）。
 *
 * processQueueOnce 每轮 await 整批任务结束才开下一轮——批内只要有一个慢任务
 * （大图生成最长可达分钟级），同企业后续任务全被挡住。本循环改为：每个企业
 * 维护 in-flight 任务集合，任务一结束立即出队补位，慢任务不再阻塞他人；
 * 高并发（企业并发数百）下保持吞吐稳定。
 *
 * 进程内 in-flight 上限仍为 min(企业并发上限, WORKER_TASK_CONCURRENCY)（保护
 * DB 连接池），跨进程/跨副本总并发由 Redis 企业+模型槽位约束。
 *
 * 企业列表按 QUEUE_POLL_INTERVAL_MS 周期刷新（深积压时避免每 tick 全量 ZRANGE
 * 全局队列）；队列已空且无在途任务的企业从本轮缓存中剔除。
 *
 * @param opts.isRunning 返回 false 时停止补位并等待在途任务结束后返回（优雅退出）
 * @param opts.tickMs 补位扫描间隔，默认 500ms
 */
export async function processQueueContinuous(opts: {
  isRunning: () => boolean
  tickMs?: number
}): Promise<void> {
  const tickMs = opts.tickMs ?? 500
  const entRefreshMs = Math.max(1000, env.QUEUE_POLL_INTERVAL_MS)
  const inflight = new Map<string, Set<Promise<void>>>()

  let cachedEntIds: string[] = []
  let lastRefresh = 0
  let lastOrphanScan = 0

  while (opts.isRunning()) {
    try {
      const now = Date.now()
      if (now - lastRefresh >= entRefreshMs) {
        cachedEntIds = await listEnterprisesWithPendingTasks()
        lastRefresh = now
      }

      // 周期性孤儿回收（首轮立即执行）：找回 worker 重启/崩溃丢失的在途任务
      if (now - lastOrphanScan >= ORPHAN_SCAN_INTERVAL_MS) {
        lastOrphanScan = now
        try {
          const n = await recoverOrphanTasks()
          if (n > 0) console.log(`[queue] 孤儿回收：重新入队 ${n} 个任务`)
        } catch (err) {
          console.error(
            "[queue] 孤儿回收异常:",
            err instanceof Error ? err.message : err,
          )
        }
      }

      for (const enterpriseId of cachedEntIds) {
        const set = inflight.get(enterpriseId)
        if (set && set.size >= env.WORKER_TASK_CONCURRENCY) continue

        const [ent] = await db
          .select()
          .from(enterprises)
          .where(eq(enterprises.id, enterpriseId))
          .limit(1)
        if (!ent || ent.status !== "active") {
          if (!set || set.size === 0) inflight.delete(enterpriseId)
          continue
        }

        const maxInFlight = Math.min(
          Math.max(1, ent.maxConcurrent),
          env.WORKER_TASK_CONCURRENCY,
        )

        // 循环前统一解析/创建 in-flight 集合：循环内每轮引用同一 Set，
        // 否则补位循环会为每个任务各建一个孤立集合，进程内并发上限失效
        const taskSet = set ?? new Set<Promise<void>>()
        if (!set) inflight.set(enterpriseId, taskSet)

        let dequeued = 0
        for (let i = taskSet.size; i < maxInFlight; i++) {
          const task = await dequeueNext({
            enterpriseId,
            enterpriseMaxConcurrent: ent.maxConcurrent,
          })
          if (!task) break
          dequeued++
          const started = Date.now()
          const p = runTaskSafely(task, ent.maxConcurrent)
            .then((ok) => {
              console.log(
                `[queue] 任务 ${task.taskId} ${ok ? "完成" : "失败"}（耗时 ${Date.now() - started}ms）`,
              )
            })
            .finally(() => taskSet.delete(p))
          taskSet.add(p)
        }

        // 队列已空且无在途任务：从缓存剔除，下个刷新周期前不再扫描该企业
        if (dequeued === 0 && taskSet.size === 0) {
          inflight.delete(enterpriseId)
          cachedEntIds = cachedEntIds.filter((id) => id !== enterpriseId)
        }
      }
    } catch (err) {
      // 单轮异常不退出，下一轮继续
      console.error(
        "[queue] 滑动窗口消费循环异常:",
        err instanceof Error ? err.message : err,
      )
    }
    await sleep(tickMs)
  }

  // 优雅退出：等待全部在途任务结束
  const pending = [...inflight.values()].flatMap((s) => [...s])
  if (pending.length > 0) {
    console.log(`[queue] 等待 ${pending.length} 个在途任务完成后退出...`)
    await Promise.allSettled(pending)
  }
}

async function processOneTask(
  task: QueueTaskInput,
  enterpriseMaxConcurrent: number,
): Promise<void> {
  // 防御：DB 无任务行（孤儿任务，常见于 DB 被重置但 Redis 未清）。
  // 在发起 AI 请求前拦截，避免无意义生图调用 + api_call_log 外键违例 + 无限重试死循环。
  const [taskRow] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, task.taskId))
    .limit(1)
  if (!taskRow) {
    console.warn(
      `[queue] 任务 ${task.taskId} 在 DB 中无对应行（孤儿任务），跳过处理并清理`,
    )
    await failTask(task.enterpriseId, task.taskId, false)
    return
  }

  // 终态防重：孤儿回收重新入队的任务与原任务完成存在竞争窗口，后到者按
  // DB 终态同步 Redis 收尾并跳过，防止重复生图/重复扣费
  if (taskRow.status === "completed") {
    await completeTask(task.enterpriseId, task.taskId)
    return
  }
  if (taskRow.status === "failed") {
    await failTask(task.enterpriseId, task.taskId, false)
    return
  }

  // DB 侧补写 processing（条件更新防覆盖终态；此前 DB 从 queued 直接跳终态，
  // 前端轮询无法区分「排队中」与「生成中」）
  if (taskRow.status === "queued") {
    await db
      .update(generationTasks)
      .set({ status: "processing" })
      .where(
        and(
          eq(generationTasks.id, task.taskId),
          eq(generationTasks.status, "queued"),
        ),
      )
  }

  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, task.modelId))
    .limit(1)
  if (!model) throw new Error("模型不存在")

  // 任务属主权限组的并发上限（group.maxConcurrent 队列侧执行）
  const [groupRow] = await db
    .select({
      groupId: permissionGroups.id,
      maxConcurrent: permissionGroups.maxConcurrent,
    })
    .from(users)
    .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
    .where(eq(users.id, taskRow.userId))
    .limit(1)
  const groupId = groupRow?.groupId ?? null
  const groupMaxConcurrent = groupRow?.maxConcurrent ?? 0

  const startedAt = Date.now()

  // 任务级超时预算 taskTimeout（覆盖等槽位 + 全部生图请求）。到时中止：
  // 等待槽位的张直接放弃、在途 fetch 以 AbortError 失败，由既有的部分
  // 失败/重试/退款路径收尾——不再出现任务无限挂在 processing。
  const taskTimeoutMs = Math.max(30, task.taskTimeout || 300) * 1000
  const taskAbort = new AbortController()
  const taskTimeoutId = setTimeout(() => {
    if (!taskAbort.signal.aborted) {
      console.warn(
        `[queue] 任务 ${task.taskId} 超过 taskTimeout ${task.taskTimeout}s，中止剩余生图`,
      )
      taskAbort.abort()
    }
  }, taskTimeoutMs)

  // 删除止损：任务行被用户删除后不再转存/落库。每张转存前检查任务行仍存在；
  // 已删则置标志并 abort（等待槽位/在途请求尽快失败，剩余张不再发起）
  let taskDeleted = false
  const ensureTaskAlive = async (): Promise<void> => {
    if (taskDeleted) throw new Error("任务已被删除")
    const [row] = await db
      .select({ id: generationTasks.id })
      .from(generationTasks)
      .where(eq(generationTasks.id, task.taskId))
      .limit(1)
    if (!row) {
      taskDeleted = true
      console.warn(`[queue] 任务 ${task.taskId} 处理中被删除，中止剩余生图`)
      taskAbort.abort()
      throw new Error("任务已被删除")
    }
  }

  // 图片并发槽位（企业 + 模型 + 权限组上限；计数器 TTL 自愈在 acquire 内续期）。
  // 首次等待时打一条日志，便于从 worker 输出直接确认限流生效
  const slotTtlSec = Math.ceil((task.taskTimeout || 600_000) / 1000) + 300
  let loggedSlotWait = false
  const slots = {
    acquireSlot: async () => {
      const ok = await acquireImageSlot({
        enterpriseId: task.enterpriseId,
        modelId: task.modelId,
        groupId,
        enterpriseMaxConcurrent,
        modelMaxConcurrent: model.maxConcurrent,
        groupMaxConcurrent,
        ttlSec: slotTtlSec,
      })
      if (!ok && !loggedSlotWait) {
        loggedSlotWait = true
        console.log(
          `[queue] 任务 ${task.taskId} 图片等待并发槽位（企业上限 ${enterpriseMaxConcurrent}，模型上限 ${model.maxConcurrent}，权限组上限 ${groupMaxConcurrent || "不限"}）`,
        )
      }
      return ok
    },
    releaseSlot: () =>
      releaseImageSlot({
        enterpriseId: task.enterpriseId,
        modelId: task.modelId,
        groupId,
        modelMaxConcurrent: model.maxConcurrent,
        groupMaxConcurrent,
      }),
  }

  let imageResults: Awaited<ReturnType<typeof callImageApi>>
  try {
    const storage = await getStorage()
    // 企业私有模型的图片常回传在 API 端点同站域名；把端点 host 作为可信提示传入，
    // 下载时自动放行同注册域（如端点 api.foo.com 放行 img.foo.com）
    const endpointHost = (() => {
      try {
        return new URL(model.apiEndpoint).hostname
      } catch {
        return null
      }
    })()
    imageResults = await callImageApi({
      model,
      prompt: task.prompt,
      imageSize: task.imageSize,
      imageCount: taskRow.imageCount,
      indexes: task.pendingIndexes,
      referenceImages: task.referenceImages,
      enterpriseId: task.enterpriseId,
      signal: taskAbort.signal,
      downloadAndUpload: async (url, _idx) => {
        await ensureTaskAlive()
        return storage.saveFromUrl(
          url,
          task.enterpriseId,
          "generate",
          endpointHost ? [endpointHost] : undefined,
        )
      },
      slots,
    })
  } catch (err) {
    if (err instanceof PartialImageFailureError) throw err // 已记日志
    // 写错误日志（任务已删除时跳过：taskId 外键随任务级联删除，插入必违例）
    if (!taskDeleted) {
      const msg = err instanceof Error ? err.message : String(err)
      await apiCallLog(model.id, task, startedAt, msg, 0)
    }
    throw err
  } finally {
    clearTimeout(taskTimeoutId)
  }

  if (taskDeleted) {
    // 任务已删除：丢弃生成结果，不再写 DB/日志，同步 Redis 终态（带 TTL）
    await failTask(task.enterpriseId, task.taskId, false)
    return
  }

  // 合并历史成功图片（重试补张时保留已成功的）
  const { succeededIndexes, resultImages } = mergeImageResults(
    taskRow.succeededIndexes ?? [],
    taskRow.resultImages ?? [],
    imageResults,
  )
  const totalCount = taskRow.imageCount
  // 上游可能一次返回多于请求数的图（如即梦固定出 4 张）；多出的不视为失败，
  // 否则 failedCount 为负会误走"部分失败"重试分支
  const failedCount = Math.max(0, totalCount - succeededIndexes.length)
  const failureDetails = imageResults
    .filter((r) => r.error)
    .map((r) => `第 ${r.index + 1} 张: ${r.error}`)
    .slice(0, 5)
    .join("；")

  if (failedCount === 0) {
    // 全部成功
    await db
      .update(generationTasks)
      .set({
        status: "completed",
        resultImages,
        succeededIndexes,
        errorMessage: null,
        completedAt: new Date(),
      })
      .where(eq(generationTasks.id, task.taskId))

    await syncCardImagesOnTerminal({
      generationTaskId: task.taskId,
      status: "completed",
      imageUrls: resultImages,
    })

    // 回写会话缩略图（取第一张生成图）+ updatedAt，供左侧列表展示
    if (task.conversationId && resultImages.length > 0) {
      await db
        .update(conversations)
        .set({
          lastImageThumb: resultImages[0]!,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, task.conversationId))
    }

    await apiCallLog(model.id, task, startedAt, null, resultImages.length)
    await completeTask(task.enterpriseId, task.taskId)
    return
  }

  // 部分失败：先持久化已成功图片（防重试/崩溃丢失），再交由失败流程决策
  if (succeededIndexes.length > 0) {
    await db
      .update(generationTasks)
      .set({ resultImages, succeededIndexes })
      .where(eq(generationTasks.id, task.taskId))
  }

  const summary = `${failedCount}/${totalCount} 张失败${failureDetails ? `（${failureDetails}）` : ""}`
  await apiCallLog(model.id, task, startedAt, summary, succeededIndexes.length)
  throw new PartialImageFailureError(failedCount, totalCount, failureDetails)
}

async function handleTaskFailure(
  task: QueueTaskInput,
  err: unknown,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  // 是否还能重试
  const [current] = await db
    .select()
    .from(generationTasks)
    .where(eq(generationTasks.id, task.taskId))
    .limit(1)
  if (!current) {
    // 任务行已被删除：无退款对象，也不允许重试（否则已删任务被反复重新入队），
    // 直接把 Redis 元数据收尾为终态
    await failTask(task.enterpriseId, task.taskId, false)
    return
  }
  const retryCount = current.retryCount
  const shouldRetry = retryCount < task.maxRetries

  const totalCount = current?.imageCount ?? task.imageCount
  const succeeded = current?.succeededIndexes ?? []
  const failedCount = Math.max(0, totalCount - succeeded.length)

  if (shouldRetry) {
    // 仅重试失败张：待生成序号 = 全部序号 - 已成功序号
    const pendingIndexes = Array.from(
      { length: totalCount },
      (_, i) => i,
    ).filter((i) => !succeeded.includes(i))

    await db
      .update(generationTasks)
      .set({
        status: "queued",
        retryCount: retryCount + 1,
        errorMessage: msg,
        retryErrors: [...(current?.retryErrors ?? []), msg],
      })
      .where(eq(generationTasks.id, task.taskId))

    // 先写待生成序号再重新入队（dequeueNext 会读出 pendingIndexes）
    await setTaskPendingIndexes(task.enterpriseId, task.taskId, pendingIndexes)
    await failTask(task.enterpriseId, task.taskId, true)
    return
  }

  // 重试用尽：按最终失败张数退积分
  await refundFailedTask(task.taskId)

  if (succeeded.length > 0) {
    // 部分成功终态：有图交付 → completed，注明失败张数、原因与退款
    const detail =
      err instanceof PartialImageFailureError && err.details
        ? `（${err.details}）`
        : ""
    const partialMsg = `重试用尽：${failedCount}/${totalCount} 张生成失败${detail}，失败部分积分已退还`
    await db
      .update(generationTasks)
      .set({
        status: "completed",
        completedAt: new Date(),
        errorMessage: partialMsg,
      })
      .where(eq(generationTasks.id, task.taskId))

    await syncCardImagesOnTerminal({
      generationTaskId: task.taskId,
      status: "completed",
      imageUrls: current?.resultImages ?? [],
      errorMessage: partialMsg,
    })

    if (task.conversationId && (current?.resultImages ?? []).length > 0) {
      await db
        .update(conversations)
        .set({
          lastImageThumb: current!.resultImages![0]!,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, task.conversationId))
    }

    await completeTask(task.enterpriseId, task.taskId)
  } else {
    // 全部失败 → failed
    const finalMsg = `最终失败（重试 ${retryCount} 次）: ${msg}`
    await db
      .update(generationTasks)
      .set({
        status: "failed",
        errorMessage: finalMsg,
      })
      .where(eq(generationTasks.id, task.taskId))
    await syncCardImagesOnTerminal({
      generationTaskId: task.taskId,
      status: "failed",
      errorMessage: finalMsg,
    })
    await failTask(task.enterpriseId, task.taskId, false)
  }
}

async function apiCallLog(
  modelId: string,
  task: QueueTaskInput,
  startedAt: number,
  errorMsg: string | null,
  imageCount: number,
): Promise<void> {
  await db.insert(apiCallLogs).values({
    enterpriseId: task.enterpriseId,
    taskId: task.taskId,
    modelId,
    requestSummary: `model=${task.modelId} size=${task.imageSize} count=${task.imageCount}`,
    responseSummary: errorMsg
      ? `error: ${errorMsg.slice(0, 200)}`
      : `images=${imageCount}`,
    errorMessage: errorMsg,
    durationMs: Date.now() - startedAt,
  })
}
