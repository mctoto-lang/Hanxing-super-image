/**
 * 图片模型请求体构造（纯函数库，零副作用，零外部依赖）
 *
 * 接口格式：openai（OpenAI 标准生图 /v1/images/generations）| jimeng（即梦）。
 * GRS 格式已下线。
 */

export type ImageApiFormat = "openai" | "jimeng"

export const DEFAULT_IMAGE_API_FORMAT: ImageApiFormat = "openai"
/** 即梦参考图字段缺省名 */
export const DEFAULT_REFERENCE_IMAGE_FIELD = "images"
/** OpenAI 生图参考图字段缺省名（参考图以 URL 链接数组传入 image 字段） */
export const DEFAULT_OPENAI_REFERENCE_IMAGE_FIELD = "image"
/** imageSize 兜底（历史任务缺尺寸时，避免请求体缺字段） */
export const DEFAULT_IMAGE_SIZE = "1024x1024"

export interface ImageModelConfigInput {
  apiFormat?: unknown
  extraConfig?: unknown
}

interface BuildOpenAiRequestInput {
  model: string
  prompt: string
  imageSize: string
  referenceImages: string[]
  referenceImageField?: string
  /** 质量参数透传（管理员配置的具体值；空 = 请求体不带该字段） */
  quality?: string
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
  sizePresets?: unknown
}

const FORMATS = new Set<ImageApiFormat>(["openai", "jimeng"])

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
  // sizePresets 为 [{label,width,height,enabled?}, ...]；解析出所有启用项的 "${w}x${h}"。
  // enabled === false 的项不计入白名单（被关闭的比例无法提交）。
  // 兼容历史可能传入的 JSON 字符串。
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return new Set()
    }
  }
  if (!Array.isArray(parsed)) return new Set()
  return new Set(
    parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const { width, height, enabled } = item as {
        width?: unknown
        height?: unknown
        enabled?: unknown
      }
      if (enabled === false) return []
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
  const sizes = parseSupportedSizes(model.sizePresets)
  const size = typeof imageSize === "string" ? imageSize.trim() : ""
  // 智能(auto) 由模型决定尺寸，跳过白名单校验
  if (size !== "auto" && sizes.size > 0 && !sizes.has(size)) {
    throw new Error(`当前模型不支持尺寸 ${size}`)
  }
  return images
}

export function validateImageModelConfig(input: ImageModelConfigInput): void {
  const format = input.apiFormat
  if (!FORMATS.has(format as ImageApiFormat)) {
    throw new Error("图片模型仅支持 openai 和 jimeng 接口格式")
  }
  const config = parseExtraConfig(input.extraConfig)

  // openai：额外配置仅 quality（质量参数透传，值为管理员按上游文档填写的字符串）
  if (format === "openai") {
    rejectUnsupportedFields(config, new Set(["quality"]))
    const quality = config.quality
    if (quality !== undefined && typeof quality !== "string") {
      throw new Error("quality 必须是字符串")
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
    (!Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 8)
  ) {
    throw new Error("jimeng_n 必须是 1 到 8 的整数")
  }
}

/** 把 "1024x1024" 归约成 "1:1"（gcd）；"auto" 原样返回（由模型决定） */
export function sizeToRatio(size: string): string {
  if (size === "auto") return "auto"
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return "1:1"
  const width = Number(match[1])
  const height = Number(match[2])
  const gcd = (a: number, b: number): number =>
    b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

/**
 * OpenAI 标准生图请求体：POST {base}/v1/images/generations
 *
 * - 尺寸固定走 size 字段（"1024x1536"；智能比例传 "auto"）
 * - 参考图以 URL 链接数组传入 image 字段（字段名可由 referenceImageField 覆盖）
 * - quality（可选）：管理员配置的质量参数原样透传（如 high/medium/low、hd/standard）
 */
export function buildOpenAiRequestBody(
  input: BuildOpenAiRequestInput,
): Record<string, unknown> {
  const size = input.imageSize?.trim() || DEFAULT_IMAGE_SIZE
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    size,
  }
  if (input.quality?.trim()) {
    body.quality = input.quality.trim()
  }
  if (input.referenceImages.length > 0) {
    const field =
      input.referenceImageField?.trim() ||
      DEFAULT_OPENAI_REFERENCE_IMAGE_FIELD
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

// ═══════════════ 生图结果共享类型（供适配器与队列消费者使用） ═══════════════

/** 单张图片生成结果（index 对应任务内图片序号；url/error 二选一） */
export interface ImageGenResult {
  index: number
  url?: string
  error?: string
}

/**
 * 合并历史成功图片与本轮结果（重试补张时保留已成功图片）。
 * 返回按序号升序排列的成功序号 + 一一对应的 URL 列表。
 */
export function mergeImageResults(
  prevIndexes: number[],
  prevUrls: string[],
  results: ImageGenResult[],
): { succeededIndexes: number[]; resultImages: string[] } {
  const map = new Map<number, string>()
  prevIndexes.forEach((idx, i) => {
    const url = prevUrls[i]
    if (url) map.set(idx, url)
  })
  for (const r of results) {
    if (r.url) map.set(r.index, r.url)
  }
  const succeededIndexes = [...map.keys()].sort((a, b) => a - b)
  return {
    succeededIndexes,
    resultImages: succeededIndexes.map((i) => map.get(i)!),
  }
}
