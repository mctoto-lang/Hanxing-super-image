/**
 * Gemini 协议适配器（gemini 格式；官方原生 :generateContent 生图）
 *
 * POST {apiEndpoint}/v1beta/models/{model}:generateContent，x-goog-api-key
 * 头鉴权，同步 JSON 响应（gemini-2.5-flash-image / Nano Banana 系）。
 *
 * - generationConfig.responseModalities 必须含 IMAGE；比例生图走
 *   imageConfig.aspectRatio（官方十档，无像素级尺寸控制，宽高由 gcd 归约
 *   + 就近吸附；"auto" 省略该节由模型自定）
 * - 参考图：官方协议不接受图片 URL，服务端先取图转 base64 以 inline_data
 *   part 附加（复用对话侧 gemini-chat 的取图转码口径）
 * - 响应从 candidates[0].content.parts 解析 inlineData → data URL 转存
 * - 每张图一个独立工作单元（等待并发槽位 → 单发 → 取首图 → 转存），
 *   单张失败不影响其他张，支持 indexes 子集重试补张
 */
import { API_ERROR_BODY_MAX_LENGTH } from "@/lib/ai/error-limits"
import { describeFetchError } from "@/lib/fetch-error"
import {
  buildGeminiImageRequestBody,
  extractGeminiErrorMessage,
  extractGeminiImages,
  type GeminiInlineImage,
  type ImageGenResult,
} from "@/lib/ai/image-model-config"
import type {
  DownloadAndUploadFn,
  ImageApiSlotCallbacks,
} from "@/lib/ai/openai-image"

export interface GeminiImageModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
}

export interface GeminiImageTask {
  prompt: string
  imageSize: string
  /** 任务总张数（决定序号范围 0..imageCount-1） */
  imageCount: number
  /** 本次需要生成的图片序号（部分失败重试仅补失败张）；缺省 = 全部 */
  indexes?: number[]
  referenceImages?: string[] | null
}

/**
 * 解析 Gemini 生图端点：apiEndpoint 配到域名或 /v1beta 结尾均可，
 * 自动拼 /v1beta/models/{model}:generateContent（已含 :generateContent 原样）。
 */
export function resolveGeminiGenerateEndpoint(
  endpoint: string,
  modelName: string,
): string {
  const url = endpoint.replace(/\/+$/, "")
  if (/:generateContent$/.test(url)) return url
  const model = encodeURIComponent(modelName)
  if (/\/v1beta(?:\/|$)/.test(url)) return `${url}/models/${model}:generateContent`
  return `${url}/v1beta/models/${model}:generateContent`
}

/** 取参考图转 base64 inlineData（官方协议不吃 URL；失败带 URL 定位） */
async function fetchInlineImage(
  url: string,
  signal: AbortSignal,
): Promise<GeminiInlineImage> {
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err
    const reason = describeFetchError(err)
    throw new Error(`参考图下载失败（${url}）${reason ? `: ${reason}` : ""}`)
  }
  if (!res.ok) {
    throw new Error(`参考图下载失败（${url}）：HTTP ${res.status}`)
  }
  const buf = await res.arrayBuffer()
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png"
  return {
    mimeType: mimeType.startsWith("image/") ? mimeType : "image/png",
    data: Buffer.from(buf).toString("base64"),
  }
}

/** 槽位等待重试间隔（同 OpenAI 适配器） */
const SLOT_WAIT_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function callGeminiImageApi(opts: {
  model: GeminiImageModel
  task: GeminiImageTask
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
  slots?: ImageApiSlotCallbacks
}): Promise<ImageGenResult[]> {
  const { model, task, apiKey, downloadAndUpload, signal, slots } = opts
  const endpoint = resolveGeminiGenerateEndpoint(model.apiEndpoint, model.name)
  const referenceImages = task.referenceImages ?? []
  const indexes =
    task.indexes && task.indexes.length > 0
      ? task.indexes
      : Array.from({ length: task.imageCount }, (_, i) => i)

  // 参考图每次请求都相同，任务内取一次复用；下载失败不吞——记录原因，
  // 每个工作单元按该原因计失败，绝不退化成纯文生图产出与参考图无关的图
  let inlineImages: GeminiInlineImage[] = []
  let referenceError: string | null = null
  if (referenceImages.length > 0) {
    try {
      inlineImages = await Promise.all(
        referenceImages.map((u) => fetchInlineImage(u, signal ?? new AbortController().signal)),
      )
    } catch (err) {
      inlineImages = []
      referenceError =
        err instanceof Error && err.name === "AbortError"
          ? `参考图下载超时或被中止（上限 ${model.apiTimeout || 120} 秒）`
          : err instanceof Error
            ? err.message
            : String(err)
    }
  }

  async function waitForSlot(): Promise<boolean> {
    if (!slots?.acquireSlot) return true
    for (;;) {
      if (await slots.acquireSlot()) return true
      if (signal?.aborted) return false
      await sleep(SLOT_WAIT_MS)
    }
  }

  /** 生成单张图片：单发 generateContent → 解析首张 inlineData → 转存 */
  async function generateOne(index: number): Promise<ImageGenResult> {
    // 参考图取不到（顶层下载已失败）：按原因计失败，不占槽位、不发纯文生图
    if (referenceError) return { index, error: referenceError }
    const acquired = await waitForSlot()
    if (!acquired) return { index, error: "任务被中止（等待并发槽位时中断）" }
    try {
      const controller = new AbortController()
      const timeoutMs = (model.apiTimeout || 120) * 1000
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener("abort", onAbort)
      try {
        const requestBody = buildGeminiImageRequestBody({
          prompt: task.prompt,
          imageSize: task.imageSize,
          inlineImages,
        })

        let response: Response
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          })
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err
          const reason = describeFetchError(err)
          if (reason) throw new Error(`生图请求网络失败（${endpoint}）: ${reason}`)
          throw err
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "")
          throw new Error(
            `Gemini 生图 API 错误 ${response.status}: ${text.slice(0, API_ERROR_BODY_MAX_LENGTH)}`,
          )
        }

        const data: unknown = await response.json()
        const images = extractGeminiImages(data)
        if (images.length > 0) {
          const saved = await downloadAndUpload(images[0]!, index)
          return {
            index,
            url: saved.url,
            width: saved.width,
            height: saved.height,
          }
        }

        const errMsg = extractGeminiErrorMessage(data)
        throw new Error(errMsg ?? "Gemini 生图响应中未解析到图片")
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener("abort", onAbort)
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError"
      const msg = isAbort
        ? `生图请求超时或被中止（上限 ${model.apiTimeout || 120} 秒）`
        : err instanceof Error
          ? err.message
          : String(err)
      return { index, error: msg }
    } finally {
      await slots?.releaseSlot?.()
    }
  }

  return await Promise.all(indexes.map((i) => generateOne(i)))
}
