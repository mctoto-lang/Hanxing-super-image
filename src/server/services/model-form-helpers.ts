import type { ModelExtraConfig } from "@/db/schema"

/**
 * 生图模型表单共享助手（admin-models 与 platform-models 原各自复制一份）
 */

/** 接口格式全集（与 api_format 枚举一致） */
export type ImageApiFormatInput =
  | "openai"
  | "chat"
  | "gemini"
  | "midjourney"
  | "jimeng"
  | "grsai"

/** 把扁平字段组装为 extraConfig（按 apiFormat 白名单） */
export function buildExtraConfig(input: {
  apiFormat: ImageApiFormatInput
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
  quality?: string
  /** 尺寸传参模式（Images 协议；缺省/像素 = 不写键，读取侧回退 pixels） */
  sizeMode?: "pixels" | "ratio" | "tier"
  /** tier 模式固定档位（仅 tier 模式写入；空 = 自动推导不写键） */
  tierValue?: "1K" | "2K" | "4K"
  /** response_format 透传（Images 协议；空 = 不写键 = 不传） */
  responseFormat?: "url" | "b64_json"
  grsaiImageSize?: "1K" | "2K" | "4K"
  /** Midjourney prompt 参数后缀（空 = 不写键 = 不追加） */
  mjFlags?: string
}): ModelExtraConfig {
  const cfg: ModelExtraConfig = {}
  // Images 协议（openai）：质量透传 + 尺寸传参模式（tier 固定档位）+ response_format
  if (input.apiFormat === "openai") {
    if (input.quality?.trim()) cfg.quality = input.quality.trim()
    if (input.sizeMode && input.sizeMode !== "pixels") {
      cfg.sizeMode = input.sizeMode
      if (input.sizeMode === "tier" && input.tierValue) {
        cfg.tierValue = input.tierValue
      }
    }
    if (input.responseFormat) cfg.responseFormat = input.responseFormat
    return cfg
  }
  // grsai：清晰度档位手动覆盖（空 = 自动推导，不写字段）。
  // 只写新键 grsaiImageSize（旧键 grsai_image_size 为存量数据，读取侧双读兼容）
  if (input.apiFormat === "grsai") {
    if (input.grsaiImageSize) cfg.grsaiImageSize = input.grsaiImageSize
    return cfg
  }
  // midjourney：prompt 参数后缀（--ar 自动生成并剔重）
  if (input.apiFormat === "midjourney") {
    if (input.mjFlags?.trim()) cfg.mjFlags = input.mjFlags.trim()
    return cfg
  }
  // chat（Chat 协议）/ gemini（Gemini 官方原生）：无额外配置项
  if (input.apiFormat === "chat" || input.apiFormat === "gemini") {
    return cfg
  }
  // jimeng
  if (input.jimengResolution) cfg.jimengResolution = input.jimengResolution
  if (input.jimengN) cfg.jimengN = input.jimengN
  return cfg
}
