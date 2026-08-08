/**
 * GRS 中转站适配器（手册 §5.6，迁移旧项目 callGRSAPI/pollGRSResult）
 *
 * 业务逻辑原样搬迁，只做适配：
 *   - DB 访问从 better-sqlite3 → Drizzle（外部传入 model/task）
 *   - 下载/上传逻辑外部注入（storage 抽象）
 */
import { buildGrsRequestBody, sizeToRatio } from "@/lib/ai/image-model-config"

const POLL_INTERVAL_MS = 5000
const MAX_POLL_TIME_MS = 5 * 60 * 1000 // 5 分钟

export interface GrsModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
  referenceImageField?: string | null
}

export interface GrsExtraConfig {
  grsModelFamily?: "gpt" | "gemini"
  replyType?: "json" | "async"
  imageSizeGrs?: "1K" | "2K" | "4K"
}

export interface GrsTask {
  prompt: string
  imageSize: string
  imageCount: number
  referenceImages?: string[] | null
}

/** 下载并转存图片的回调（由调用方注入 storage 逻辑） */
export type DownloadAndUploadFn = (
  imageUrl: string,
  imageIndex: number,
) => Promise<string>

/** 解析 GRS 端点（确保路径正确） */
function resolveGenerateEndpoint(endpoint: string): string {
  let url = endpoint.replace(/\/+$/, "")
  if (!url.includes("/api/generate")) {
    if (url.endsWith("/v1")) url += "/api/generate"
    else if (url.endsWith("/v1/api")) url += "/generate"
    else if (!url.includes("/v1/")) url += "/v1/api/generate"
  }
  return url
}

/** 解析 GRS 轮询端点 */
function resolveResultEndpoint(endpoint: string): string {
  let url = endpoint.replace(/\/+$/, "")
  if (url.includes("/api/generate")) url = url.replace("/api/generate", "/api/result")
  else if (url.includes("/v1/api")) url = url.replace("/v1/api", "/v1/api/result")
  else if (url.endsWith("/v1")) url += "/api/result"
  else url += "/v1/api/result"
  return url
}

/** 通用图片 URL 提取（容错多种响应格式） */
function extractImageUrl(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>
  if (typeof obj.url === "string") return obj.url
  if (typeof obj.image_url === "string") return obj.image_url
  const results = obj.results ?? (obj.data as Record<string, unknown> | undefined)?.results
  if (Array.isArray(results) && results.length > 0) {
    const first = results[0]
    if (typeof first === "string") return first
    if (first && typeof first === "object") {
      const u = (first as Record<string, unknown>).url
      if (typeof u === "string") return u
    }
  }
  return null
}

/**
 * 调用 GRS API 生图（同步模式 + 异步轮询）
 *
 * 返回转存后的图片 URL 数组。
 */
export async function callGRSApi(opts: {
  model: GrsModel
  task: GrsTask
  extraConfig: GrsExtraConfig
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
}): Promise<string[]> {
  const { model, task, extraConfig, apiKey, downloadAndUpload, signal } = opts
  const endpoint = resolveGenerateEndpoint(model.apiEndpoint)
  const family = extraConfig.grsModelFamily ?? "gemini"
  const replyType = extraConfig.replyType ?? "json"
  const referenceImages = task.referenceImages ?? []
  const imageUrls: string[] = []

  for (let i = 0; i < task.imageCount; i++) {
    const controller = new AbortController()
    const timeoutMs = (model.apiTimeout || 120) * 1000
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    if (signal) signal.addEventListener("abort", () => controller.abort())

    const requestBody = buildGrsRequestBody({
      model: model.name,
      prompt: task.prompt,
      imageSize: task.imageSize,
      extraConfig: {
        grsModelFamily: family,
        replyType,
        imageSizeGrs: extraConfig.imageSizeGrs,
      },
      referenceImages,
      referenceImageField: model.referenceImageField ?? undefined,
    })

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`GRS API 错误 ${response.status}: ${text.slice(0, 200)}`)
    }

    const data = await response.json()

    // 同步成功
    if (data.status === "succeeded") {
      const url = extractImageUrl(data)
      if (url) {
        imageUrls.push(await downloadAndUpload(url, i))
        continue
      }
    }

    // 异步任务：轮询
    if (
      data.id &&
      (data.status === "running" ||
        data.status === "pending" ||
        replyType === "async")
    ) {
      const grsTaskId = data.id
      const imageUrl = await pollGRSResult({
        endpoint: model.apiEndpoint,
        apiKey,
        taskId: grsTaskId,
        downloadAndUpload,
        imageIndex: i,
        signal,
      })
      imageUrls.push(imageUrl)
      continue
    }

    // 容错：通用提取
    const fallback = extractImageUrl(data)
    if (fallback) {
      imageUrls.push(await downloadAndUpload(fallback, i))
    } else {
      throw new Error("GRS API 响应无可识别的图片字段")
    }
  }

  return imageUrls
}

/** 轮询 GRS 异步任务结果 */
export async function pollGRSResult(opts: {
  endpoint: string
  apiKey: string
  taskId: string
  downloadAndUpload: DownloadAndUploadFn
  imageIndex: number
  signal?: AbortSignal
}): Promise<string> {
  const { endpoint, apiKey, taskId, downloadAndUpload, imageIndex, signal } = opts
  const pollEndpoint = resolveResultEndpoint(endpoint)
  const separator = pollEndpoint.includes("?") ? "&" : "?"
  const fullUrl = `${pollEndpoint}${separator}id=${taskId}`
  const startTime = Date.now()

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    if (signal?.aborted) throw new Error("轮询被中止")
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    let response: Response
    try {
      response = await fetch(fullUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    } catch {
      continue
    }
    if (!response.ok) continue

    const data = await response.json()
    if (data.status === "succeeded") {
      const url = extractImageUrl(data)
      if (url) return await downloadAndUpload(url, imageIndex)
      throw new Error("GRS 轮询成功但无图片 URL")
    }
    if (data.status === "failed" || data.status === "error") {
      throw new Error(`GRS 任务失败: ${data.error ?? "未知错误"}`)
    }
    // running/pending → 继续轮询
  }

  throw new Error("GRS 任务超时（5 分钟未完成）")
}

// 占位：sizeToRatio 在 buildGrsRequestBody 内部已用，这里 export 备测试
export { sizeToRatio }
