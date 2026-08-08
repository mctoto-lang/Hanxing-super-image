/**
 * 图片模型请求体构造（手册 §5.6，从旧项目 image-model-config.ts 原样迁移）
 *
 * 纯函数库，零副作用，零外部依赖 —— 迁移价值最高。
 * 调整：类型名 camelCase 匹配新 schema（grsModelFamily 而非 grs_model_family），
 * 但运行时仍兼容 snake_case（来自 DB 的 extraConfig）。
 */

export type ImageApiFormat = "grs" | "jimeng"
export type GrsModelFamily = "gpt" | "gemini"

export const DEFAULT_IMAGE_API_FORMAT: ImageApiFormat = "grs"
export const DEFAULT_REFERENCE_IMAGE_FIELD = "images"

export interface ImageModelConfigInput {
  apiFormat?: unknown
  extraConfig?: unknown
}

export interface GrsExtraConfig {
  grsModelFamily?: GrsModelFamily
  replyType?: "json" | "async"
  imageSizeGrs?: "1K" | "2K" | "4K"
}

interface BuildGrsRequestInput {
  model: string
  prompt: string
  imageSize: string
  extraConfig: GrsExtraConfig
  referenceImages: string[]
  referenceImageField?: string
}

interface BuildJimengRequestInput {
  model: string
  prompt: string
  ratio: string
  resolution: string
  count: number
  referenceImages: string[]
  referenceImageField?: string
}

interface GenerationCapabilities {
  apiFormat?: unknown
  extraConfig?: unknown
  supportsReferenceImage?: unknown
  maxReferenceImages?: unknown
  supportedSizes?: unknown
}

const FORMATS = new Set<ImageApiFormat>(["grs", "jimeng"])

/**
 * 兼容 snake_case（DB extraConfig）与 camelCase（TS 强类型）的字段读取。
 * 旧项目 DB 存 grs_model_family，新 schema 也用 snake_case（jsonb）。
 */
function getExtraConfig(
  raw: unknown,
  key: "grsModelFamily" | "replyType" | "imageSizeGrs",
): unknown {
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>
  const camelMap: Record<typeof key, string[]> = {
    grsModelFamily: ["grsModelFamily", "grs_model_family"],
    replyType: ["replyType", "reply_type"],
    imageSizeGrs: ["imageSizeGrs", "image_size_grs"],
  }
  for (const k of camelMap[key]) {
    if (obj[k] !== undefined) return obj[k]
  }
  return undefined
}

function parseExtraConfig(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error()
      }
      return parsed as Record<string, unknown>
    } catch {
      throw new Error("extraConfig 必须是有效的 JSON 对象")
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error("extraConfig 必须是有效的 JSON 对象")
}

const GRS_FIELDS = new Set([
  "grs_model_family",
  "reply_type",
  "image_size_grs",
  "grsModelFamily",
  "replyType",
  "imageSizeGrs",
])
const JIMENG_FIELDS = new Set([
  "jimeng_resolution",
  "jimeng_n",
  "jimengResolution",
  "jimengN",
])

function rejectUnsupportedFields(
  config: Record<string, unknown>,
  allowed: Set<string>,
) {
  const unsupported = Object.keys(config).filter((key) => !allowed.has(key))
  if (unsupported.length > 0) {
    throw new Error(`当前接口格式不支持配置字段：${unsupported.join(", ")}`)
  }
}

export function assertSupportedImageApiFormat(value: unknown): ImageApiFormat {
  if (!FORMATS.has(value as ImageApiFormat)) {
    throw new Error(`不支持的图片接口格式：${String(value)}`)
  }
  return value as ImageApiFormat
}

function parseSupportedSizes(value: unknown): Set<string> {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return new Set()
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Set()
  }
  const ratios = (parsed as { ratios?: unknown }).ratios
  if (!Array.isArray(ratios)) return new Set()
  return new Set(
    ratios.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const { width, height } = item as { width?: unknown; height?: unknown }
      return Number(width) > 0 && Number(height) > 0
        ? [`${Number(width)}x${Number(height)}`]
        : []
    }),
  )
}

export function validateGenerationCapabilities(
  model: GenerationCapabilities,
  referenceImages: unknown,
  imageSize: unknown,
): string[] {
  const images = Array.isArray(referenceImages)
    ? [
        ...new Set(
          referenceImages
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : []
  if (images.length > 0 && !model.supportsReferenceImage) {
    throw new Error("当前模型不支持参考图")
  }
  const maxCount = Math.max(1, Number(model.maxReferenceImages) || 1)
  if (images.length > maxCount) {
    throw new Error(`当前模型最多支持 ${maxCount} 张参考图`)
  }
  const sizes = parseSupportedSizes(model.supportedSizes)
  const size = typeof imageSize === "string" ? imageSize.trim() : ""
  if (sizes.size > 0 && !sizes.has(size)) {
    throw new Error(`当前模型不支持尺寸 ${size}`)
  }
  return images
}

export function validateImageModelConfig(input: ImageModelConfigInput): void {
  const format = input.apiFormat
  if (!FORMATS.has(format as ImageApiFormat)) {
    throw new Error("图片模型仅支持 grs 和 jimeng 接口格式")
  }
  const config = parseExtraConfig(input.extraConfig)

  if (format === "grs") {
    rejectUnsupportedFields(config, GRS_FIELDS)
    const family = getExtraConfig(config, "grsModelFamily")
    if (family !== "gpt" && family !== "gemini") {
      throw new Error("请选择有效的 GRS 模型族：gpt 或 gemini")
    }
    const replyType = getExtraConfig(config, "replyType")
    if (
      replyType !== undefined &&
      replyType !== "json" &&
      replyType !== "async"
    ) {
      throw new Error("replyType 仅支持 json 或 async")
    }
    const imageSizeGrs = getExtraConfig(config, "imageSizeGrs")
    if (
      imageSizeGrs !== undefined &&
      !["1K", "2K", "4K"].includes(String(imageSizeGrs))
    ) {
      throw new Error("imageSizeGrs 仅支持 1K、2K 或 4K")
    }
    if (family === "gpt" && imageSizeGrs !== undefined) {
      throw new Error("GPT 模型族不支持 imageSizeGrs")
    }
    return
  }

  // jimeng
  rejectUnsupportedFields(config, JIMENG_FIELDS)
  const resolution = config.jimeng_resolution ?? config.jimengResolution
  if (
    resolution !== undefined &&
    !["1k", "2k", "4k"].includes(String(resolution))
  ) {
    throw new Error("jimeng_resolution 仅支持 1k、2k 或 4k")
  }
  const n = config.jimeng_n ?? config.jimengN
  if (
    n !== undefined &&
    (!Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 4)
  ) {
    throw new Error("jimeng_n 必须是 1 到 4 的整数")
  }
}

/** 把 "1024x1024" 归约成 "1:1"（gcd） */
export function sizeToRatio(size: string): string {
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return "1:1"
  const width = Number(match[1])
  const height = Number(match[2])
  const gcd = (a: number, b: number): number =>
    b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

export function buildGrsRequestBody(
  input: BuildGrsRequestInput,
): Record<string, unknown> {
  const family = input.extraConfig.grsModelFamily ?? "gpt"
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    replyType: input.extraConfig.replyType ?? "json",
  }
  if (family === "gpt") {
    body.size = input.imageSize
  } else {
    body.aspectRatio = sizeToRatio(input.imageSize)
  }
  if (family === "gemini" && input.extraConfig.imageSizeGrs) {
    body.imageSize = input.extraConfig.imageSizeGrs
  }
  if (input.referenceImages.length > 0) {
    const field =
      input.referenceImageField?.trim() || DEFAULT_REFERENCE_IMAGE_FIELD
    body[field] = input.referenceImages
  }
  return body
}

export function buildJimengRequestBody(
  input: BuildJimengRequestInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    ratio: input.ratio,
    resolution: input.resolution,
    n: input.count,
  }
  if (input.referenceImages.length > 0) {
    const field =
      input.referenceImageField?.trim() || DEFAULT_REFERENCE_IMAGE_FIELD
    body[field] = input.referenceImages
  }
  return body
}

/** 从模型能力 + 用户输入构造 GRS 请求体（便捷封装） */
export function buildGrsRequestFromCapabilities(opts: {
  model: GenerationCapabilities & {
    apiEndpoint?: string
    name: string
    referenceImageField?: string
  }
  prompt: string
  imageSize: string
  referenceImages: string[]
}): Record<string, unknown> {
  validateImageModelConfig(opts.model)
  const images = validateGenerationCapabilities(
    opts.model,
    opts.referenceImages,
    opts.imageSize,
  )
  const extraConfig = (opts.model.extraConfig ?? {}) as GrsExtraConfig
  return buildGrsRequestBody({
    model: opts.model.name,
    prompt: opts.prompt,
    imageSize: opts.imageSize,
    extraConfig,
    referenceImages: images,
    referenceImageField: opts.model.referenceImageField,
  })
}
