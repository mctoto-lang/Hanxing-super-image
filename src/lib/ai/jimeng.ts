/**
 * 即梦适配器（手册 §5.6，迁移旧项目 callJimengAPI）
 *
 * 即梦接口通常同步返回结果，逻辑较 OpenAI 适配器简单。单次上游请求最多
 * 返回 4 张：需要更多张时按 4 张/请求自动拆分（并发窗口
 * JIMENG_CHUNK_CONCURRENCY），任一请求失败整体抛错（全或无契约不变）。
 *
 * jimengN 不在此处生效——模型配置的「每次 N 张」已在提交端相乘进
 * task.imageCount（次数 × N），适配器只按传入总数生成。
 */
import {
  buildJimengRequestBody,
  sizeToRatio,
} from "@/lib/ai/image-model-config"

export interface JimengModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
  referenceImageField?: string | null
}

export interface JimengExtraConfig {
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
}

export interface JimengTask {
  prompt: string
  imageSize: string
  imageCount: number
  referenceImages?: string[] | null
}

export type DownloadAndUploadFn = (
  imageUrl: string,
  imageIndex: number,
) => Promise<string>

/** 单次即梦 API 请求的张数上限（上游约束） */
const JIMENG_MAX_PER_REQUEST = 4
/** 多请求拆分的并发窗口：8 张 = 2 请求并行；32 张 = 4 请求 × 2 轮 */
const JIMENG_CHUNK_CONCURRENCY = 4

function extractImageUrls(data: unknown): string[] {
  if (!data || typeof data !== "object") return []
  const obj = data as Record<string, unknown>
  // 多种响应格式容错
  if (Array.isArray(obj.images)) {
    return obj.images
      .filter((x): x is string => typeof x === "string")
  }
  if (Array.isArray(obj.data)) {
    return obj.data
      .map((x) =>
        typeof x === "string" ? x : (x as Record<string, unknown>)?.url,
      )
      .filter((x): x is string => typeof x === "string")
  }
  if (typeof obj.url === "string") return [obj.url]
  return []
}

/** 把总张数拆成 ≤4 的请求块：8→[4,4]、6→[4,2]、3→[3] */
function splitRequestCounts(total: number): number[] {
  let remaining = Math.max(1, Math.floor(total))
  const chunks: number[] = []
  while (remaining > 0) {
    const c = Math.min(JIMENG_MAX_PER_REQUEST, remaining)
    chunks.push(c)
    remaining -= c
  }
  return chunks
}

/** 带并发窗口的任务执行器：保持结果按序；任一失败停止派发新任务并抛出 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length)
  let next = 0
  let stopped = false
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      for (;;) {
        if (stopped) return
        const i = next++
        if (i >= tasks.length) return
        try {
          results[i] = await tasks[i]!()
        } catch (err) {
          stopped = true
          throw err
        }
      }
    },
  )
  await Promise.all(workers)
  return results
}

export async function callJimengApi(opts: {
  model: JimengModel
  task: JimengTask
  extraConfig: JimengExtraConfig
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
}): Promise<string[]> {
  const { model, task, extraConfig, apiKey, downloadAndUpload, signal } = opts
  const endpoint = model.apiEndpoint.replace(/\/+$/, "")
  const referenceImages = task.referenceImages ?? []
  const resolution = extraConfig.jimengResolution ?? "1k"
  const timeoutMs = (model.apiTimeout || 120) * 1000

  /** 单个请求块：一次即梦 API 调用，返回该块的图片 URL（原样，不裁剪） */
  const requestChunk = async (count: number): Promise<string[]> => {
    const requestBody = buildJimengRequestBody({
      model: model.name,
      prompt: task.prompt,
      ratio: sizeToRatio(task.imageSize),
      resolution,
      count,
      referenceImages,
      referenceImageField: model.referenceImageField ?? undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    if (signal)
      signal.addEventListener("abort", () => controller.abort(), { once: true })

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`即梦 API 错误 ${response.status}: ${text.slice(0, 200)}`)
      }

      const data = await response.json()
      const urls = extractImageUrls(data)
      if (urls.length === 0) {
        throw new Error("即梦 API 响应无可识别的图片字段")
      }
      return urls
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // 拆分请求：>4 张自动按 4 张/块并行（窗口 4），块序拼接保证顺序稳定；
  // 超量返回（如上游固定出 4 张）由上层按需张数裁剪，此处原样上抛
  const chunks = splitRequestCounts(task.imageCount)
  const urlGroups = await runWithConcurrency(
    chunks.map((c) => () => requestChunk(c)),
    JIMENG_CHUNK_CONCURRENCY,
  )
  const urls = urlGroups.flat()

  // 转存所有返回的图片
  const result: string[] = []
  for (let i = 0; i < urls.length; i++) {
    result.push(await downloadAndUpload(urls[i]!, i))
  }
  return result
}
