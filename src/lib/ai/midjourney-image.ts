/**
 * Midjourney 适配器（midjourney 格式；MJ Proxy 协议，aipaiai）
 *
 * 提交 POST {base}/mj/submit/imagine（Bearer；参考图 URL 空格拼 prompt 头部、
 * --ar 走所选比例、state 带内部追踪号、管理员参数后缀 mjFlags 追加末尾），
 * 轮询 GET {base}/mj/task/{id}/fetch 至终态。
 *
 * - 一次任务固定产出 4 张（四宫格自动拆分，splitStatus=succeeded 后 images
 *   按 1-4 位置给出独立 URL 与真实宽高）；提交端已按「数量=任务数」把
 *   imageCount 相乘为 4N（同即梦口径），本适配器按 4 张/任务拆工作单元
 * - 全部任务先提交（提交快、上游并行出图），再并行轮询至 taskTimeout 截止；
 *   单次 HTTP 受 apiTimeout 约束，轮询间隔 4s（官方建议 3-5s）
 * - 任务 FAILURE / splitStatus failed|expired / 超时 → 该任务 4 张全部失败
 *   （本任务整体成败语义，不支持单张补试——重试会重新提交整个任务重新计费）
 * - 图片 URL 有时效（expires_at），完成即转存自有存储
 */
import { API_ERROR_BODY_MAX_LENGTH } from "@/lib/ai/error-limits"
import { describeFetchError } from "@/lib/fetch-error"
import {
  buildMidjourneyPrompt,
  extractMidjourneyTaskState,
  parseMidjourneySubmitResponse,
  resolveMidjourneyFetchEndpoint,
  resolveMidjourneySubmitEndpoint,
  type ImageGenResult,
  type MidjourneyTaskState,
} from "@/lib/ai/image-model-config"
import type { DownloadAndUploadFn } from "@/lib/ai/openai-image"

/** MJ 单任务固定产出的四宫格张数 */
export const MJ_IMAGES_PER_TASK = 4
/** 轮询间隔（官方建议 3-5s，取 4s 平衡及时性与调用频次） */
const POLL_INTERVAL_MS = 4_000

export interface MidjourneyImageModel {
  name: string
  apiEndpoint: string
  /** 单次 HTTP（提交/查询）超时秒数 */
  apiTimeout: number
  /** 任务整体截止秒数（提交+轮询+取图全流程） */
  taskTimeout: number
  /** 管理员配置的 prompt 参数后缀（如 --v 8.2 --fast；--ar 自动生成并去重） */
  mjFlags?: string | null
}

export interface MidjourneyImageTask {
  prompt: string
  imageSize: string
  /** 总张数（= 任务数 × 4；提交端已相乘，同即梦 jimengN 口径） */
  imageCount: number
  /** 本次需要生成的图片序号（部分重试按任务粒度整体重跑）；缺省 = 全部 */
  indexes?: number[]
  referenceImages?: string[] | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 单次 HTTP（带独立超时 + 外层中止信号透传） */
async function httpJson(
  url: string,
  init: RequestInit,
  timeoutSec: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err
      const reason = describeFetchError(err)
      throw new Error(`请求网络失败（${url}）${reason ? `: ${reason}` : ""}`)
    }
    const text = await response.text().catch(() => "")
    if (!response.ok) {
      throw new Error(
        `MJ API 错误 ${response.status}: ${text.slice(0, API_ERROR_BODY_MAX_LENGTH)}`,
      )
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`MJ API 响应非 JSON：${text.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** 提交一个 imagine 任务，返回任务 ID */
async function submitTask(opts: {
  model: MidjourneyImageModel
  task: MidjourneyImageTask
  apiKey: string
  state: string
  signal?: AbortSignal
}): Promise<string> {
  const { model, task, apiKey, state, signal } = opts
  const body = {
    model: model.name,
    prompt: buildMidjourneyPrompt({
      prompt: task.prompt,
      imageSize: task.imageSize,
      referenceImages: task.referenceImages ?? [],
      flags: model.mjFlags,
    }),
    state,
  }
  const data = await httpJson(
    resolveMidjourneySubmitEndpoint(model.apiEndpoint),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    model.apiTimeout || 120,
    apiKey,
    signal,
  )
  const parsed = parseMidjourneySubmitResponse(data)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.taskId
}

/** 轮询任务至四图就绪（splitStatus=succeeded）；FAILURE/拆分失败/超时抛错 */
async function pollTaskUntilSplit(opts: {
  model: MidjourneyImageModel
  apiKey: string
  taskId: string
  deadline: number
  signal?: AbortSignal
}): Promise<MidjourneyTaskState["images"]> {
  const { model, apiKey, taskId, deadline, signal } = opts
  const fetchUrl = resolveMidjourneyFetchEndpoint(model.apiEndpoint, taskId)
  for (;;) {
    if (signal?.aborted) throw new Error("任务被中止")
    if (Date.now() > deadline) {
      throw new Error(`Midjourney 任务超时（上限 ${model.taskTimeout || 300} 秒，任务 ${taskId}）`)
    }
    const data = await httpJson(fetchUrl, { method: "GET" }, model.apiTimeout || 120, apiKey, signal)
    const state = extractMidjourneyTaskState(data)
    if (state.status === "FAILURE") {
      throw new Error(`Midjourney 任务失败${state.failReason ? `：${state.failReason}` : `（任务 ${taskId}）`}`)
    }
    if (state.status === "SUCCESS") {
      if (state.splitStatus === "succeeded" && state.images.length > 0) {
        return state.images.slice(0, MJ_IMAGES_PER_TASK)
      }
      if (state.splitStatus === "failed") {
        throw new Error("Midjourney 四图拆分失败（splitStatus=failed）")
      }
      if (state.splitStatus === "expired") {
        throw new Error("Midjourney 四图拆分结果已过期（splitStatus=expired）")
      }
      // SUCCESS 但拆分仍在进行：继续等待，勿重复提交
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

export async function callMidjourneyImageApi(opts: {
  model: MidjourneyImageModel
  task: MidjourneyImageTask
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
}): Promise<ImageGenResult[]> {
  const { model, task, apiKey, downloadAndUpload, signal } = opts
  const requested =
    task.indexes && task.indexes.length > 0
      ? new Set(task.indexes)
      : new Set(Array.from({ length: task.imageCount }, (_, i) => i))
  // 工作单元 = 任务（4 张）：按序号整除聚合，同任务只提交一次
  const taskIdxs = [...new Set([...requested].map((i) => Math.floor(i / MJ_IMAGES_PER_TASK)))]
  const deadline = Date.now() + (model.taskTimeout || 300) * 1000

  /** 跑完一个任务：提交 → 轮询 → 转存 4 图（只回填请求涉及的序号） */
  async function runTask(taskIdx: number): Promise<ImageGenResult[]> {
    try {
      const taskId = await submitTask({
        model,
        task,
        apiKey,
        state: `t${taskIdx}-${Date.now()}`,
        signal,
      })
      const images = await pollTaskUntilSplit({ model, apiKey, taskId, deadline, signal })
      const results: ImageGenResult[] = []
      for (let i = 0; i < images.length; i++) {
        const index = taskIdx * MJ_IMAGES_PER_TASK + i
        if (!requested.has(index)) continue
        try {
          const saved = await downloadAndUpload(images[i]!.url, index)
          results.push({
            index,
            url: saved.url,
            width: images[i]!.width ?? saved.width,
            height: images[i]!.height ?? saved.height,
          })
        } catch (err) {
          results.push({
            index,
            error: `MJ 图片转存失败（任务 ${taskId}）：${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }
      return results
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError"
      const msg = isAbort
        ? `Midjourney 任务超时或被中止（上限 ${model.taskTimeout || 300} 秒）`
        : err instanceof Error
          ? err.message
          : String(err)
      // 任务整体失败：该任务涉及的请求序号全部计失败（任务粒度，无单张补试）
      const base = taskIdx * MJ_IMAGES_PER_TASK
      return Array.from({ length: MJ_IMAGES_PER_TASK }, (_, i) => base + i)
        .filter((index) => requested.has(index))
        .map((index) => ({ index, error: msg }))
    }
  }

  const all = await Promise.all(taskIdxs.map((t) => runTask(t)))
  return all.flat().sort((a, b) => a.index - b.index)
}
