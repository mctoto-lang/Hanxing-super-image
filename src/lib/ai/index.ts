/**
 * AI 统一调度入口（手册 §5.6）
 *
 * 按 model.apiFormat 分发到 OpenAI 标准生图 / 即梦适配器。
 * 调用方（队列消费者）注入 downloadAndUpload 回调（storage 抽象）。
 */
import { decrypt } from "@/lib/crypto"
import { signUploadToken } from "@/lib/storage/upload-token"
import {
  assertSupportedImageApiFormat,
  validateImageModelConfig,
  DEFAULT_IMAGE_SIZE,
  type ImageGenResult,
} from "@/lib/ai/image-model-config"
import {
  callOpenAiImageApi,
  type DownloadAndUploadFn as OpenAiDownloadAndUploadFn,
  type ImageApiSlotCallbacks,
} from "@/lib/ai/openai-image"
import { callJimengApi } from "@/lib/ai/jimeng"
import type { models } from "@/db/schema"

type ModelRow = typeof models.$inferSelect

export type DownloadAndUploadFn = OpenAiDownloadAndUploadFn

export type { ImageGenResult, ImageApiSlotCallbacks }

/**
 * 统一调用：根据模型 apiFormat 分发。
 *
 * 返回按图片序号（index）组织的结果数组：OpenAI 逐张请求支持单张失败
 * （部分成功），即梦为多请求拆分但整体成败（全或无）。
 *
 * @param model 模型行（来自 DB）
 * @param opts  prompt/imageSize/imageCount/referenceImages
 * @param downloadAndUpload 图片下载转存回调
 * @param slots 图片并发槽位回调（OpenAI 逐张占用；即梦请求不占用）
 */
export async function callImageApi(opts: {
  model: ModelRow
  prompt: string
  imageSize: string
  imageCount: number
  /** 本次需要生成的图片序号（部分失败重试仅补失败张）；缺省 = 全部 */
  indexes?: number[]
  referenceImages?: string[] | null
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
  slots?: ImageApiSlotCallbacks
}): Promise<ImageGenResult[]> {
  const { model, prompt, imageCount, indexes, referenceImages, downloadAndUpload, signal, slots } = opts
  // 尺寸兜底：历史任务/异常入队可能缺尺寸，避免请求体缺 size 字段
  const imageSize = opts.imageSize?.trim() || DEFAULT_IMAGE_SIZE

  // 校验配置
  assertSupportedImageApiFormat(model.apiFormat)
  validateImageModelConfig({
    apiFormat: model.apiFormat,
    extraConfig: model.extraConfig ?? {},
  })

  // 解密 API Key
  const apiKey = decrypt(model.apiKeyEncrypted)
  const extraConfig = (model.extraConfig ?? {}) as Record<string, unknown>

  // 参考图 URL 会原样进入上游请求体、由上游服务器直接拉取（无会话
  // cookie）。本地存储模式的 /uploads 已收紧为「会话或令牌」，这里在
  // 出站前统一附短时效令牌；COS / 外域 URL 原样（signUploadToken 内过滤）
  const referenceImagesForUpstream = (referenceImages ?? []).map((u) =>
    signUploadToken(u),
  )

  if (model.apiFormat === "openai") {
    return await callOpenAiImageApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
        referenceImageField: model.referenceImageField ?? undefined,
      },
      task: { prompt, imageSize, imageCount, indexes, referenceImages: referenceImagesForUpstream },
      apiKey,
      downloadAndUpload,
      signal,
      slots,
    })
  }

  // jimeng：按需张数自动拆分请求（单次上游上限 4 张，并发窗口 4），整体
  // 成败（无槽位回调、不支持部分成功）。部分重试只补失败张，返回结果映射
  // 回请求的序号（jimengN 已在提交端相乘进 imageCount，此处不再覆盖）
  const jimengIndexes =
    indexes && indexes.length > 0
      ? indexes
      : Array.from({ length: imageCount }, (_, i) => i)
  const urls = await callJimengApi({
    model: {
      name: model.name,
      apiEndpoint: model.apiEndpoint,
      apiTimeout: model.apiTimeout,
      referenceImageField: model.referenceImageField ?? undefined,
    },
    task: { prompt, imageSize, imageCount: jimengIndexes.length, referenceImages: referenceImagesForUpstream },
    extraConfig: {
      jimengResolution: (extraConfig.jimengResolution ??
        extraConfig.jimeng_resolution) as "1k" | "2k" | "4k" | undefined,
      jimengN: (extraConfig.jimengN ?? extraConfig.jimeng_n) as
        | number
        | undefined,
    },
    apiKey,
    downloadAndUpload,
    signal,
  })
  // 上游可能一次返回多于请求数的图（如即梦固定出 4 张）：只取请求的张数；
  // 少于请求数时缺的张按失败处理（succeededIndexes 覆盖不到即计失败）
  return urls
    .slice(0, jimengIndexes.length)
    .map((url, i) => ({ index: jimengIndexes[i]!, url }))
}
