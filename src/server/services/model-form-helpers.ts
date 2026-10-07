import type { ModelExtraConfig } from "@/db/schema"

/**
 * 生图模型表单共享助手（admin-models 与 platform-models 原各自复制一份）
 */

/** 把扁平字段组装为 extraConfig（按 apiFormat 白名单） */
export function buildExtraConfig(input: {
  apiFormat: "openai" | "jimeng" | "gemini" | "grsai"
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
  quality?: string
  grsaiImageSize?: "1K" | "2K" | "4K"
}): ModelExtraConfig {
  const cfg: ModelExtraConfig = {}
  // openai / gemini：质量参数透传（空 = 不写 = 关闭）
  if (input.apiFormat === "openai" || input.apiFormat === "gemini") {
    if (input.quality?.trim()) cfg.quality = input.quality.trim()
    return cfg
  }
  // grsai：清晰度档位手动覆盖（空 = 自动推导，不写字段）
  if (input.apiFormat === "grsai") {
    if (input.grsaiImageSize) cfg.grsai_image_size = input.grsaiImageSize
    return cfg
  }
  // jimeng
  if (input.jimengResolution) cfg.jimengResolution = input.jimengResolution
  if (input.jimengN) cfg.jimengN = input.jimengN
  return cfg
}
