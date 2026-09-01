/**
 * 即梦适配器（手册 §5.6，迁移旧项目 callJimengAPI）
 *
 * 即梦接口通常同步返回结果，逻辑较 OpenAI 适配器简单（单请求 n 张）。
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
  /** 归属企业：随请求头 X-Enterprise-Id 透传给中转/网关，供其按 key 规范预转存 */
  enterpriseId?: string
}

export type DownloadAndUploadFn = (
  imageUrl: string,
  imageIndex: number,
) => Promise<string>

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
  const n = extraConfig.jimengN ?? task.imageCount

  const requestBody = buildJimengRequestBody({
    model: model.name,
    prompt: task.prompt,
    ratio: sizeToRatio(task.imageSize),
    resolution,
    count: Math.min(4, Math.max(1, n)),
    referenceImages,
    referenceImageField: model.referenceImageField ?? undefined,
  })

  const controller = new AbortController()
  const timeoutMs = (model.apiTimeout || 120) * 1000
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true })

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(task.enterpriseId ? { "X-Enterprise-Id": task.enterpriseId } : {}),
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal,
  })
  clearTimeout(timeoutId)

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`即梦 API 错误 ${response.status}: ${text.slice(0, 200)}`)
  }

  const data = await response.json()
  const urls = extractImageUrls(data)
  if (urls.length === 0) {
    throw new Error("即梦 API 响应无可识别的图片字段")
  }

  // 转存所有返回的图片
  const result: string[] = []
  for (let i = 0; i < urls.length; i++) {
    result.push(await downloadAndUpload(urls[i]!, i))
  }
  return result
}
