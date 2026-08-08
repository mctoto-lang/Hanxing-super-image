/**
 * AI 统一调度入口（手册 §5.6）
 *
 * 按 model.apiFormat 分发到 GRS / 即梦适配器。
 * 调用方（队列消费者）注入 downloadAndUpload 回调（storage 抽象）。
 */
import { decrypt } from "@/lib/crypto"
import {
  assertSupportedImageApiFormat,
  validateImageModelConfig,
} from "@/lib/ai/image-model-config"
import { callGRSApi } from "@/lib/ai/grs"
import { callJimengApi } from "@/lib/ai/jimeng"
import type { models } from "@/db/schema"

type ModelRow = typeof models.$inferSelect

export type DownloadAndUploadFn = (
  imageUrl: string,
  imageIndex: number,
) => Promise<string>

/**
 * 统一调用：根据模型 apiFormat 分发。
 *
 * @param model 模型行（来自 DB）
 * @param opts  prompt/imageSize/imageCount/referenceImages
 * @param downloadAndUpload 图片下载转存回调
 */
export async function callImageApi(opts: {
  model: ModelRow
  prompt: string
  imageSize: string
  imageCount: number
  referenceImages?: string[] | null
  downloadAndUpload: DownloadAndUploadFn
  signal?: AbortSignal
}): Promise<string[]> {
  const { model, prompt, imageSize, imageCount, referenceImages, downloadAndUpload, signal } = opts

  // 校验配置
  assertSupportedImageApiFormat(model.apiFormat)
  validateImageModelConfig({
    apiFormat: model.apiFormat,
    extraConfig: model.extraConfig ?? {},
  })

  // 解密 API Key
  const apiKey = decrypt(model.apiKeyEncrypted)
  const extraConfig = (model.extraConfig ?? {}) as Record<string, unknown>

  if (model.apiFormat === "grs") {
    return await callGRSApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
        referenceImageField: model.referenceImageField ?? undefined,
      },
      task: { prompt, imageSize, imageCount, referenceImages },
      extraConfig: {
        grsModelFamily: (extraConfig.grsModelFamily ??
          extraConfig.grs_model_family) as "gpt" | "gemini" | undefined,
        replyType: (extraConfig.replyType ??
          extraConfig.reply_type) as "json" | "async" | undefined,
        imageSizeGrs: (extraConfig.imageSizeGrs ??
          extraConfig.image_size_grs) as "1K" | "2K" | "4K" | undefined,
      },
      apiKey,
      downloadAndUpload,
      signal,
    })
  }

  // jimeng
  return await callJimengApi({
    model: {
      name: model.name,
      apiEndpoint: model.apiEndpoint,
      apiTimeout: model.apiTimeout,
      referenceImageField: model.referenceImageField ?? undefined,
    },
    task: { prompt, imageSize, imageCount, referenceImages },
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
}
