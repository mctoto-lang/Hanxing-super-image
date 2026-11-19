/**
 * Images 协议适配器（openai 格式；OpenAI 标准图片接口）
 *
 * 按有无参考图分流（2026-11 规范化，行为对齐官方规范）：
 * - 无参考图：POST {apiEndpoint}/v1/images/generations（JSON；
 *   apiEndpoint 配到 /v1 结尾，如 https://api.openai.com/v1）
 * - 带参考图：POST {apiEndpoint}/v1/images/edits（multipart 文件上传，
 *   服务端先下载参考图 URL 转 Blob 再以 image/image[] 文件字段附加）
 *
 * - 请求体：{ model, prompt, size|比例|档位, quality?, response_format? }
 *   尺寸传参模式（sizeMode）三态：pixels 走 size 字段 / ratio 走比例参数
 *   （默认 aspect_ratio，值由尺寸 gcd 归约）/ tier 走清晰度档位（默认
 *   size，1K/2K/4K 按预设像素推导，可由 tierValue 固定档位）；旧 gemini 行
 *   useRatioParam=true 回退视为 ratio。
 * - 每张图一个独立工作单元（等待并发槽位 → fetch → 解析 → 转存），
 *   张与张之间互不阻塞、各自独立超时；单张失败不影响其他张，
 *   支持 indexes 子集重试补张。
 * - 响应解析：data[0].url（标准）/ data[0].b64_json（转 data URL 转存），
 *   并对常见网关变体做容错提取。
 */
import { API_ERROR_BODY_MAX_LENGTH } from "@/lib/ai/error-limits"
import { describeFetchError } from "@/lib/fetch-error"
import {
  buildOpenAiRequestBody,
  type ImageGenResult,
  type ImageSizeMode,
} from "@/lib/ai/image-model-config"
import type { SavedImage } from "@/lib/storage/image-dim"

export interface OpenAiImageModel {
  name: string
  apiEndpoint: string
  apiTimeout: number
  referenceImageField?: string | null
  /** 质量参数透传（管理员配置；空 = 请求体不带 quality 字段） */
  quality?: string | null
  /** 尺寸传参模式（新配置，优先于旧 useRatioParam 回退） */
  sizeMode?: ImageSizeMode
  /** 旧 gemini 配置：以比例参数代替尺寸参数 */
  useRatioParam?: boolean
  /** tier 模式固定档位（1K/2K/4K；空 = 按预设像素自动推导） */
  tierValue?: string | null
  /** 比例/档位参数字段名（空 = ratio→aspect_ratio、tier→size） */
  ratioParamField?: string | null
  /** response_format 透传（url / b64_json；空 = 请求体不带该字段） */
  responseFormat?: string | null
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

/** 下载并转存图片的回调（由调用方注入 storage 逻辑），返回 URL 与探测尺寸 */
export type DownloadAndUploadFn = (
  imageUrl: string,
  imageIndex: number,
) => Promise<SavedImage>

/** 槽位等待重试间隔（等待期间不计时单张超时，拿到槽位才开始计时；200ms 降低释放到拾取延迟） */
const SLOT_WAIT_MS = 200

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

/** 解析 OpenAI 图像编辑端点（Images 协议：带参考图一律走 edits，multipart 文件上传） */
export function resolveOpenAiEditsEndpoint(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.includes("/images/edits")) return url
  if (url.includes("/images/generations")) {
    return url.replace("/images/generations", "/images/edits")
  }
  if (url.endsWith("/v1")) return url + "/images/edits"
  return url + "/v1/images/edits"
}

/**
 * 构造 edits multipart 表单：请求体各字段（model/prompt/size|比例|档位/
 * quality/response_format）平铺为表单字段；参考图以文件形式附加
 * （单张字段名 image，多张按官方 SDK 口径重复 image[]）。
 */
export function buildOpenAiEditsFormData(
  body: Record<string, unknown>,
  files: Array<{ blob: Blob; filename: string }>,
): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    form.append(key, String(value))
  }
  const field = files.length === 1 ? "image" : "image[]"
  for (const f of files) form.append(field, f.blob, f.filename)
  return form
}

/** 下载参考图为 Blob（edits multipart 需要真实文件）；缺 MIME 时按 png 兜底 */
async function fetchReferenceBlob(
  url: string,
  signal: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
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
  const raw = await res.blob()
  const blob = raw.type ? raw : new Blob([raw], { type: "image/png" })
  const m = url.split("?")[0]!.match(/([a-z0-9_-]+\.(?:png|jpe?g|webp))$/i)
  return { blob, filename: m?.[1] ?? "reference.png" }
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
      if (typeof item.image_url === "string" && item.image_url) {
        return item.image_url
      }
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
  // Images 协议分流：无参考图走 generations（JSON），带参考图走 edits（multipart）
  const generateEndpoint = resolveOpenAiGenerateEndpoint(model.apiEndpoint)
  const editsEndpoint = resolveOpenAiEditsEndpoint(model.apiEndpoint)
  const referenceImages = task.referenceImages ?? []
  const indexes =
    task.indexes && task.indexes.length > 0
      ? task.indexes
      : Array.from({ length: task.imageCount }, (_, i) => i)

  // edits 分支的参考图对任务内每张都相同：顶层统一下载一次 Blob 复用，
  // 避免 N 张 × M 参考图重复下载，下载也不再占用并发槽位；下载失败不吞
  // （对齐逐张失败语义）——每个工作单元直接按原因计失败，不发起请求。
  // 下载受 apiTimeout 与外层中止信号双重约束（沿用单张请求的超时口径）
  let referenceFiles: Array<{ blob: Blob; filename: string }> = []
  let referenceError: string | null = null
  if (referenceImages.length > 0) {
    const refController = new AbortController()
    const refTimeoutId = setTimeout(
      () => refController.abort(),
      (model.apiTimeout || 120) * 1000,
    )
    const onRefAbort = () => refController.abort()
    signal?.addEventListener("abort", onRefAbort)
    try {
      referenceFiles = await Promise.all(
        referenceImages.map((u) => fetchReferenceBlob(u, refController.signal)),
      )
    } catch (err) {
      referenceFiles = []
      referenceError =
        err instanceof Error && err.name === "AbortError"
          ? `参考图下载超时或被中止（上限 ${model.apiTimeout || 120} 秒）`
          : err instanceof Error
            ? err.message
            : String(err)
    } finally {
      clearTimeout(refTimeoutId)
      signal?.removeEventListener("abort", onRefAbort)
    }
  }

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
    // 参考图取不到（顶层下载已失败）：按原因计失败，不占槽位、不发起请求
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
        let response: Response
        try {
          if (referenceImages.length > 0) {
            // edits：multipart 提交（官方规范不接受 URL 数组）；参考图
            // Blob 已在顶层下载一次，此处仅复用
            const formBody = buildOpenAiEditsFormData(
              buildOpenAiRequestBody({
                model: model.name,
                prompt: task.prompt,
                imageSize: task.imageSize,
                referenceImages: [],
                quality: model.quality ?? undefined,
                sizeMode: model.sizeMode,
                useRatioParam: model.useRatioParam,
                tierValue: model.tierValue,
                ratioParamField: model.ratioParamField ?? undefined,
                responseFormat: model.responseFormat ?? undefined,
              }),
              referenceFiles,
            )
            response = await fetch(editsEndpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}` },
              body: formBody,
              signal: controller.signal,
            })
          } else {
            const requestBody = buildOpenAiRequestBody({
              model: model.name,
              prompt: task.prompt,
              imageSize: task.imageSize,
              referenceImages: [],
              quality: model.quality ?? undefined,
              sizeMode: model.sizeMode,
              useRatioParam: model.useRatioParam,
              tierValue: model.tierValue,
              ratioParamField: model.ratioParamField ?? undefined,
              responseFormat: model.responseFormat ?? undefined,
            })
            response = await fetch(generateEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            })
          }
        } catch (err) {
          // AbortError 交给外层统一汉化（超时或被中止）；网络层失败带端点与原因
          if (err instanceof Error && err.name === "AbortError") throw err
          const reason = describeFetchError(err)
          const endpoint = referenceImages.length > 0 ? editsEndpoint : generateEndpoint
          if (reason) throw new Error(`生图请求网络失败（${endpoint}）: ${reason}`)
          throw err
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "")
          // 保留大段上游响应体（含内容政策拒绝等完整错误），便于定位来源
          throw new Error(`OpenAI 生图 API 错误 ${response.status}: ${text.slice(0, API_ERROR_BODY_MAX_LENGTH)}`)
        }

        const data: unknown = await response.json()
        const url = extractOpenAiImage(data)
        if (url) {
          const saved = await downloadAndUpload(url, index)
          return {
            index,
            url: saved.url,
            width: saved.width,
            height: saved.height,
          }
        }

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
