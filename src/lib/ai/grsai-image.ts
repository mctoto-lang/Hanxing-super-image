/**
 * Grsai（Gemini (Grsai)）生图适配器
 *
 * POST {apiEndpoint}/v1/api/generate，Bearer 鉴权，同步 JSON 响应
 * （replyType 固定 json）。
 *
 * - 请求体：{ model, prompt, aspectRatio, imageSize, images, replyType }
 *   比例由尺寸预设 gcd 归约（不支持的比例就近吸附）；清晰度档位
 *   1K/2K/4K 自动推导，可由模型 extraConfig.grsai_image_size 覆盖；
 *   参考图以 URL/base64 数组传入 images 字段。
 * - 每张图一个独立工作单元（等待并发槽位 → fetch → 解析 → 转存），
 *   张与张之间互不阻塞、各自独立超时；单张失败不影响其他张，
 *   支持 indexes 子集重试补张。
 * - 响应：{ status, results: [{ url }], error }；status 非 succeeded
 *   （failed/violation/running 等）按失败处理并透出上游 error。
 */
import {
  buildGrsaiRequestBody,
  type ImageGenResult,
} from "@/lib/ai/image-model-config"
import type {
  DownloadAndUploadFn,
  ImageApiSlotCallbacks,
} from "@/lib/ai/openai-image"

export interface GrsaiImageModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
  /** 清晰度档位手动覆盖（模型 extraConfig.grsai_image_size；空 = 自动推导） */
  imageSizeOverride?: string | null
}

export interface GrsaiImageTask {
  prompt: string
  imageSize: string
  /** 任务总张数（决定序号范围 0..imageCount-1） */
  imageCount: number
  /** 本次需要生成的图片序号（部分失败重试仅补失败张）；缺省 = 全部 */
  indexes?: number[]
  referenceImages?: string[] | null
}

/** 槽位等待重试间隔（与 openai-image 一致：等待期间不计时单张超时） */
const SLOT_WAIT_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 解析 Grsai 生图端点（apiEndpoint 配到域名或 /v1 结尾均可） */
export function resolveGrsaiGenerateEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.includes("/api/generate")) return url
  if (url.endsWith("/v1")) return url + "/api/generate"
  return url + "/v1/api/generate"
}

/**
 * 从 Grsai 同步响应提取单张图片 URL。
 * 成功形态 { status: "succeeded", results: [{ url }] }；对常见变体
 * （url / data[0].url）做容错提取。
 */
export function extractGrsaiImage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.results) && obj.results.length > 0) {
    const first = obj.results[0]
    if (typeof first === "string") return first
    if (first && typeof first === "object") {
      const url = (first as Record<string, unknown>).url
      if (typeof url === "string" && url) return url
    }
  }
  if (typeof obj.url === "string" && obj.url) return obj.url
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    const first = obj.data[0]
    if (first && typeof first === "object") {
      const url = (first as Record<string, unknown>).url
      if (typeof url === "string" && url) return url
    }
  }
  return null
}

/** 从 Grsai 错误响应提取 message（{ error: "..." } / { error: { message } }） */
function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const err = (data as Record<string, unknown>).error
  if (typeof err === "string" && err) return err
  if (err && typeof err === "object") {
    const msg = (err as Record<string, unknown>).message
    if (typeof msg === "string" && msg) return msg
  }
  return null
}

/**
 * 调用 Grsai 生图 API（并发模式）
 *
 * 每张图一个独立工作单元：等待槽位（企业+模型并发限制）→ fetch →
 * 解析同步响应 → 转存。结果按入参 indexes 顺序返回（index 保序）。
 */
export async function callGrsaiImageApi(opts: {
  model: GrsaiImageModel
  task: GrsaiImageTask
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
  slots?: ImageApiSlotCallbacks
}): Promise<ImageGenResult[]> {
  const { model, task, apiKey, downloadAndUpload, signal, slots } = opts
  const endpoint = resolveGrsaiGenerateEndpoint(model.apiEndpoint)
  const referenceImages = task.referenceImages ?? []
  const indexes =
    task.indexes && task.indexes.length > 0
      ? task.indexes
      : Array.from({ length: task.imageCount }, (_, i) => i)

  /** 等待图片槽位（外层 signal 中止时放弃等待） */
  async function waitForSlot(): Promise<boolean> {
    if (!slots?.acquireSlot) return true
    for (;;) {
      if (await slots.acquireSlot()) return true
      if (signal?.aborted) return false
      await sleep(SLOT_WAIT_MS)
    }
  }

  /** 生成单张图片（含槽位获取/释放、独立超时、转存） */
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
        const requestBody = buildGrsaiRequestBody({
          model: model.name,
          prompt: task.prompt,
          imageSize: task.imageSize,
          referenceImages,
          imageSizeOverride: model.imageSizeOverride ?? undefined,
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

        if (!response.ok) {
          const text = await response.text().catch(() => "")
          throw new Error(`Grsai 生图 API 错误 ${response.status}: ${text.slice(0, 2000)}`)
        }

        const data: unknown = await response.json()
        const status =
          data && typeof data === "object"
            ? (data as Record<string, unknown>).status
            : undefined
        if (typeof status === "string" && status !== "succeeded") {
          // violation = 内容安全拒绝；failed/running 等同样按失败透出上游 error
          const errMsg = extractErrorMessage(data)
          throw new Error(
            `Grsai 生图状态 ${status}${errMsg ? `：${errMsg}` : ""}`,
          )
        }
        const url = extractGrsaiImage(data)
        if (url) return { index, url: await downloadAndUpload(url, index) }

        throw new Error(
          extractErrorMessage(data) ?? "Grsai 生图 API 响应无可识别的图片字段",
        )
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener("abort", onAbort)
      }
    } catch (err) {
      // fetch 原生 AbortError 消息是英文，统一汉化为带超时上限的提示
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
