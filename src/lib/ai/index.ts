/**
 * AI 统一调度入口（手册 §5.6）
 *
 * 按 model.apiFormat 分发（六格式，2026-11 规范化）：
 * - openai：Images 协议（OpenAI 标准；适配器内按有无参考图分流
 *   generations JSON / edits multipart）
 * - chat：Chat 协议（OpenAI 兼容对话接口生图，回复解析图片）
 * - gemini：Gemini 官方原生（:generateContent + responseModalities IMAGE，
 *   比例生图 + inlineData 参考图）
 * - midjourney：MJ Proxy（aipaiai；提交 + 轮询，一任务 4 张）
 * - jimeng：即梦适配器（按需拆分请求，整体成败）
 * - grsai：Grsai 适配器（aspectRatio 比例 + imageSize 清晰度档位）
 * 调用方（队列消费者）注入 downloadAndUpload 回调（storage 抽象）。
 */
import { decrypt } from "@/lib/crypto"
import { signUploadToken } from "@/lib/storage/upload-token"
import {
  assertSupportedImageApiFormat,
  isContentPolicyError,
  resolveGrsaiImageSizeOverride,
  summarizeImageErrors,
  validateImageModelConfig,
  DEFAULT_IMAGE_SIZE,
  type ImageGenResult,
  type ImageSizeMode,
} from "@/lib/ai/image-model-config"
import {
  callOpenAiImageApi,
  type DownloadAndUploadFn as OpenAiDownloadAndUploadFn,
  type ImageApiSlotCallbacks,
} from "@/lib/ai/openai-image"
import { callJimengApi } from "@/lib/ai/jimeng"
import { callGrsaiImageApi } from "@/lib/ai/grsai-image"
import { callChatImageApi } from "@/lib/ai/chat-image"
import { callGeminiImageApi } from "@/lib/ai/gemini-image"
import { callMidjourneyImageApi } from "@/lib/ai/midjourney-image"
import type { models } from "@/db/schema"

type ModelRow = typeof models.$inferSelect

export type DownloadAndUploadFn = OpenAiDownloadAndUploadFn

export type { ImageGenResult, ImageApiSlotCallbacks }
export { isContentPolicyError, summarizeImageErrors }

/**
 * 统一调用：根据模型 apiFormat 分发。
 *
 * 返回按图片序号（index）组织的结果数组：openai/chat/gemini 逐张请求支持单张
 * 失败（部分成功），midjourney 按任务粒度整体成败（一任务 4 张），即梦为多
 * 请求拆分但整体成败（全或无）。
 *
 * @param model 模型行（来自 DB）
 * @param opts  prompt/imageSize/imageCount/referenceImages
 * @param downloadAndUpload 图片下载转存回调
 * @param slots 图片并发槽位回调（逐张协议占用；即梦/MJ 不占用）
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

  // openai：Images 协议（generations/edits 分流在适配器内）
  if (model.apiFormat === "openai") {
    return await callOpenAiImageApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
        quality:
          typeof extraConfig.quality === "string"
            ? extraConfig.quality
            : undefined,
        // 尺寸传参模式：extraConfig.sizeMode 优先；缺省时由适配器按旧
        // useRatioParam 回退（存量迁移行已补写 sizeMode，双保险）
        sizeMode:
          typeof extraConfig.sizeMode === "string"
            ? (extraConfig.sizeMode as ImageSizeMode)
            : undefined,
        useRatioParam: model.useRatioParam === true,
        tierValue:
          typeof extraConfig.tierValue === "string"
            ? extraConfig.tierValue
            : undefined,
        ratioParamField: model.ratioParamField ?? undefined,
        responseFormat:
          typeof extraConfig.responseFormat === "string"
            ? extraConfig.responseFormat
            : undefined,
      },
      task: { prompt, imageSize, imageCount, indexes, referenceImages: referenceImagesForUpstream },
      apiKey,
      downloadAndUpload,
      signal,
      slots,
    })
  }

  // chat：Chat 协议（对话接口生图，无尺寸参数；逐张工作单元支持部分成功）
  if (model.apiFormat === "chat") {
    return await callChatImageApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
      },
      task: { prompt, imageCount, indexes, referenceImages: referenceImagesForUpstream },
      apiKey,
      downloadAndUpload,
      signal,
      slots,
    })
  }

  // gemini：Gemini 官方原生（:generateContent 比例生图；参考图服务端取图转 inlineData）
  if (model.apiFormat === "gemini") {
    return await callGeminiImageApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
      },
      task: { prompt, imageSize, imageCount, indexes, referenceImages: referenceImagesForUpstream },
      apiKey,
      downloadAndUpload,
      signal,
      slots,
    })
  }

  // midjourney：MJ Proxy（提交 + 轮询；一任务固定 4 张，任务粒度整体成败）
  if (model.apiFormat === "midjourney") {
    return await callMidjourneyImageApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
        taskTimeout: model.taskTimeout,
        mjFlags:
          typeof extraConfig.mjFlags === "string" ? extraConfig.mjFlags : undefined,
      },
      task: { prompt, imageSize, imageCount, indexes, referenceImages: referenceImagesForUpstream },
      apiKey,
      downloadAndUpload,
      signal,
    })
  }

  // grsai：统一端点 /v1/api/generate，比例必传（aspectRatio 由尺寸预设归约），
  // 清晰度档位自动推导或模型配置覆盖
  if (model.apiFormat === "grsai") {
    return await callGrsaiImageApi({
      model: {
        name: model.name,
        apiEndpoint: model.apiEndpoint,
        apiTimeout: model.apiTimeout,
        // 清晰度档位手动覆盖（新键优先、旧键存量兜底，见 image-model-config）
        imageSizeOverride: resolveGrsaiImageSizeOverride(extraConfig),
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
    .map((saved, i) => ({
      index: jimengIndexes[i]!,
      url: saved.url,
      width: saved.width,
      height: saved.height,
    }))
}
