/**
 * OpenAI 标准生图适配器
 *
 * POST {apiEndpoint}/v1/images/generations（apiEndpoint 配到 /v1 结尾，
 * 如 https://api.openai.com/v1），Bearer 鉴权，同步 JSON 响应。
 *
 * - 请求体：{ model, prompt, size, image: [参考图URL...], quality? }
 *   尺寸固定走 size 字段；参考图以 URL 链接数组传入（默认字段 image，
 *   可由模型 referenceImageField 覆盖）；quality 为管理员配置的可选透传参数。
 * - 每张图一个独立工作单元（等待并发槽位 → fetch → 解析 → 转存），
 *   张与张之间互不阻塞、各自独立超时；单张失败不影响其他张，
 *   支持 indexes 子集重试补张。
 * - 响应解析：data[0].url（标准）/ data[0].b64_json（转 data URL 转存），
 *   并对常见网关变体做容错提取。
 */
import {
  buildOpenAiRequestBody,
  type ImageGenResult,
} from "@/lib/ai/image-model-config"

export interface OpenAiImageModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
  referenceImageField?: string | null
  /** 质量参数透传（管理员配置；空 = 请求体不带 quality 字段） */
  quality?: string | null
}

export interface OpenAiImageTask {
  prompt: string
  imageSize: string
  /** 任务总张数（决定序号范围 0..imageCount-1） */
  imageCount: number
  /** 本次需要生成的图片序号（部分失败重试仅补失败张）；缺省 = 全部 */
  indexes?: number[]
  referenceImages?: string[] | null
}

/** 图片槽位回调（由队列消费者注入 Redis 实现：企业 + 模型并发限制） */
export interface ImageApiSlotCallbacks {
  /** 发送生图请求前获取槽位，成功返回 true；false = 当前无槽位需稍后重试 */
  acquireSlot?: () => Promise<boolean>
  /** 单张请求结束后释放槽位（无论成败） */
  releaseSlot?: () => Promise<void>
}

/** 下载并转存图片的回调（由调用方注入 storage 逻辑） */
export type DownloadAndUploadFn = (
  imageUrl: string,
  imageIndex: number,
) => Promise<string>

/** 槽位等待重试间隔（等待期间不计时单张超时，拿到槽位才开始计时） */
const SLOT_WAIT_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 解析 OpenAI 生图端点（apiEndpoint 建议配到 /v1 结尾） */
export function resolveOpenAiGenerateEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.includes("/images/generations")) return url
  if (url.endsWith("/v1")) return url + "/images/generations"
  return url + "/v1/images/generations"
}

/**
 * 从响应中提取单张图片（url 或 b64_json → data URL）。
 * 优先 OpenAI 标准 data[0]，其次常见网关变体（url / image_url / results）。
 */
export function extractOpenAiImage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>

  if (Array.isArray(obj.data) && obj.data.length > 0) {
    const first = obj.data[0]
    if (typeof first === "string") return first
    if (first && typeof first === "object") {
      const item = first as Record<string, unknown>
      if (typeof item.url === "string" && item.url) return item.url
      if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`
      }
    }
  }
  if (typeof obj.url === "string") return obj.url
  if (typeof obj.image_url === "string") return obj.image_url
  const results = obj.results ?? obj.images
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

/** 从 OpenAI 错误响应提取 message（{error: {message}} 常见形态） */
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

/**
 * 调用 OpenAI 标准生图 API（并发模式）
 *
 * 每张图一个独立工作单元：等待槽位（企业+模型并发限制）→ fetch →
 * 解析同步响应 → 转存。结果按入参 indexes 顺序返回（index 保序）。
 */
export async function callOpenAiImageApi(opts: {
  model: OpenAiImageModel
  task: OpenAiImageTask
  apiKey: string
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
  slots?: ImageApiSlotCallbacks
}): Promise<ImageGenResult[]> {
  const { model, task, apiKey, downloadAndUpload, signal, slots } = opts
  const endpoint = resolveOpenAiGenerateEndpoint(model.apiEndpoint)
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
        const requestBody = buildOpenAiRequestBody({
          model: model.name,
          prompt: task.prompt,
          imageSize: task.imageSize,
          referenceImages,
          referenceImageField: model.referenceImageField ?? undefined,
          quality: model.quality ?? undefined,
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
          throw new Error(`OpenAI 生图 API 错误 ${response.status}: ${text.slice(0, 200)}`)
        }

        const data: unknown = await response.json()
        const url = extractOpenAiImage(data)
        if (url) return { index, url: await downloadAndUpload(url, index) }

        const errMsg = extractErrorMessage(data)
        throw new Error(
          errMsg ?? "OpenAI 生图 API 响应无可识别的图片字段",
        )
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener("abort", onAbort)
      }
    } catch (err) {
      // fetch 原生 AbortError 消息是英文（"This operation was aborted"），
      // 统一汉化为带超时上限的提示，避免原样透传到任务卡片
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
