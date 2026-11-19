/**
 * Chat 协议适配器（chat 格式；OpenAI 兼容对话接口生图）
 *
 * POST {apiEndpoint}/v1/chat/completions（apiEndpoint 配到 /v1 结尾），
 * Bearer 鉴权，非流式 JSON 响应。
 *
 * - prompt 作为 user 消息；参考图以 image_url 多模态 part 附加（vision 消息
 *   形状，各类聚合渠道通用）；无参考图时 content 为纯文本字符串
 * - 无尺寸/质量参数（协议不支持，尺寸由模型自行决定）
 * - 响应从 choices[0].message.content 解析图片：分段 image_url part、
 *   markdown 图片链接、裸 data URI / 图片扩展名 URL（见 extractChatImages）
 * - 每张图一个独立工作单元（等待并发槽位 → 单发对话 → 取回复首图 → 转存），
 *   单张失败不影响其他张，支持 indexes 子集重试补张（同 OpenAI 适配器口径）
 */
import { API_ERROR_BODY_MAX_LENGTH } from "@/lib/ai/error-limits"
import { describeFetchError } from "@/lib/fetch-error"
import {
  buildChatImageRequestBody,
  extractChatImages,
  type ImageGenResult,
} from "@/lib/ai/image-model-config"
import type {
  DownloadAndUploadFn,
  ImageApiSlotCallbacks,
} from "@/lib/ai/openai-image"
import type { SavedImage } from "@/lib/storage/image-dim"

export interface ChatImageModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
}

export interface ChatImageTask {
  prompt: string
  /** 任务总张数（决定序号范围 0..imageCount-1） */
  imageCount: number
  /** 本次需要生成的图片序号（部分失败重试仅补失败张）；缺省 = 全部 */
  indexes?: number[]
  referenceImages?: string[] | null
}

/** Chat 生图端点解析（与 OpenAI 生图端点解析同规则，路径不同） */
export function resolveChatCompletionsEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.includes("/chat/completions")) return url
  if (url.endsWith("/v1")) return url + "/chat/completions"
  return url + "/v1/chat/completions"
}

/** 从回复 JSON 取 message.content（choices[0].message；content 可为字符串或分段数组） */
function extractChatMessageContent(data: unknown): unknown {
  if (!data || typeof data !== "object") return null
  const choices = (data as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (!first || typeof first !== "object") return null
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== "object") return null
  return (message as Record<string, unknown>).content
}

/** 从 Chat 错误响应提取 message（{error: {message}} 常见形态） */
function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const err = (data as Record<string, unknown>).error
  if (err && typeof err === "object") {
    const msg = (err as Record<string, unknown>).message
    if (typeof msg === "string" && msg) return msg
  }
  if (typeof err === "string" && err) return err
  return null
}

/** 槽位等待重试间隔（同 OpenAI 适配器） */
const SLOT_WAIT_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function callChatImageApi(opts: {
  model: ChatImageModel
  task: ChatImageTask
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
  slots?: ImageApiSlotCallbacks
}): Promise<ImageGenResult[]> {
  const { model, task, apiKey, downloadAndUpload, signal, slots } = opts
  const endpoint = resolveChatCompletionsEndpoint(model.apiEndpoint)
  const referenceImages = task.referenceImages ?? []
  const indexes =
    task.indexes && task.indexes.length > 0
      ? task.indexes
      : Array.from({ length: task.imageCount }, (_, i) => i)

  async function waitForSlot(): Promise<boolean> {
    if (!slots?.acquireSlot) return true
    for (;;) {
      if (await slots.acquireSlot()) return true
      if (signal?.aborted) return false
      await sleep(SLOT_WAIT_MS)
    }
  }

  /** 生成单张图片：一次对话请求 → 回复中取首张图 → 转存 */
  async function generateOne(index: number): Promise<ImageGenResult> {
    const acquired = await waitForSlot()
    if (!acquired) return { index, error: "任务被中止（等待并发槽位时中断）" }
    try {
      const controller = new AbortController()
      const timeoutMs = (model.apiTimeout || 120) * 1000
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener("abort", onAbort)
      try {
        const requestBody = buildChatImageRequestBody({
          model: model.name,
          prompt: task.prompt,
          referenceImages,
        })

        let response: Response
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
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
            `Chat 生图 API 错误 ${response.status}: ${text.slice(0, API_ERROR_BODY_MAX_LENGTH)}`,
          )
        }

        const data: unknown = await response.json()
        const images = extractChatImages(extractChatMessageContent(data))
        if (images.length > 0) {
          const saved = await downloadAndUpload(images[0]!, index)
          return {
            index,
            url: saved.url,
            width: saved.width,
            height: saved.height,
          }
        }

        const errMsg = extractErrorMessage(data)
        throw new Error(errMsg ?? "Chat 生图回复中未解析到图片")
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

// 供类型引用（SavedImage 经 DownloadAndUploadFn 间接使用）
export type { SavedImage }
