/**
 * 图片模型请求体构造（纯函数库，零副作用，零外部依赖）
 *
 * 接口格式：openai（OpenAI 标准生图 /v1/images/generations）| jimeng（即梦）|
 * gemini（Gemini 系中转：请求形状同 openai，尺寸参数可切换为比例）|
 * grsai（Gemini (Grsai)：aspectRatio 比例 + imageSize 清晰度档位）。
 * GRS 格式已下线。
 */

export type ImageApiFormat = "openai" | "jimeng" | "gemini" | "grsai"

export const DEFAULT_IMAGE_API_FORMAT: ImageApiFormat = "openai"
/** 即梦参考图字段缺省名 */
export const DEFAULT_REFERENCE_IMAGE_FIELD = "images"
/** OpenAI 生图参考图字段缺省名（参考图以 URL 链接数组传入 image 字段） */
export const DEFAULT_OPENAI_REFERENCE_IMAGE_FIELD = "image"
/** gemini 格式比例参数字段缺省名（管理员可按中转站约定覆盖） */
export const DEFAULT_RATIO_FIELD = "aspect_ratio"
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
  /** gemini 格式：以比例参数代替尺寸参数（1024x1024 → 1:1；auto 原样传） */
  useRatioParam?: boolean
  /** gemini 格式：比例参数字段名（空 = aspect_ratio） */
  ratioParamField?: string | null
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

const FORMATS = new Set<ImageApiFormat>(["openai", "jimeng", "gemini", "grsai"])

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
    throw new Error("图片模型仅支持 openai、jimeng、gemini 和 grsai 接口格式")
  }
  const config = parseExtraConfig(input.extraConfig)

  // openai / gemini：额外配置仅 quality（质量参数透传，值为管理员按上游文档填写的字符串）
  if (format === "openai" || format === "gemini") {
    rejectUnsupportedFields(config, new Set(["quality"]))
    const quality = config.quality
    if (quality !== undefined && typeof quality !== "string") {
      throw new Error("quality 必须是字符串")
    }
    return
  }

  // grsai：额外配置仅清晰度档位（新键 grsaiImageSize；旧键 grsai_image_size
  // 为存量数据，白名单同时放行，存量行不因旧键被拒，读取新键优先）
  if (format === "grsai") {
    rejectUnsupportedFields(config, new Set(["grsaiImageSize", "grsai_image_size"]))
    const tier = config.grsaiImageSize ?? config.grsai_image_size
    if (
      tier !== undefined &&
      !(GRSAI_IMAGE_SIZE_TIERS as readonly string[]).includes(String(tier))
    ) {
      throw new Error(`grsaiImageSize 仅支持 ${GRSAI_IMAGE_SIZE_TIERS.join("、")}`)
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
 * - 尺寸默认走 size 字段（"1024x1536"；智能比例传 "auto"）
 * - gemini 格式可配置 useRatioParam：改为比例参数（默认字段 aspect_ratio，
 *   值由尺寸 gcd 归约，如 1024x1024 → 1:1），此时请求体不再携带 size
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
  }
  if (input.useRatioParam) {
    const field = input.ratioParamField?.trim() || DEFAULT_RATIO_FIELD
    body[field] = sizeToRatio(size)
  } else {
    body.size = size
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

// ═══════════════ Grsai（Gemini (Grsai)）格式：比例 + 清晰度档位 ═══════════════

interface BuildGrsaiRequestInput {
  model: string
  prompt: string
  imageSize: string
  referenceImages: string[]
  /** 清晰度档位手动覆盖（模型 extraConfig.grsaiImageSize，旧键 grsai_image_size 存量双读；空 = 按预设尺寸自动推导） */
  imageSizeOverride?: string | null
}

/** Grsai aspectRatio 支持值（nano-banana 系列通用集） */
const GRSAI_SUPPORTED_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9",
] as const

/** 清晰度档位合法值 */
export const GRSAI_IMAGE_SIZE_TIERS = ["1K", "2K", "4K"] as const

/**
 * 提取 grsai 清晰度档位手动覆盖：新键 grsaiImageSize 优先，旧键
 * grsai_image_size 为存量数据兜底双读；都缺省返回 undefined
 * （= 按预设尺寸自动推导档位）。
 */
export function resolveGrsaiImageSizeOverride(
  extraConfig: Record<string, unknown> | null | undefined,
): string | undefined {
  if (typeof extraConfig?.grsaiImageSize === "string") return extraConfig.grsaiImageSize
  if (typeof extraConfig?.grsai_image_size === "string") return extraConfig.grsai_image_size
  return undefined
}

/**
 * 把尺寸串换算成 Grsai aspectRatio 值：
 * gcd 归约比例（1024x1536 → 2:3）；"auto" 原样返回；归约结果不在
 * Grsai 支持集时，按比例值（w/h）就近吸附到支持的比例，避免上游拒判。
 */
export function grsaiAspectRatio(size: string): string {
  if (size === "auto") return "auto"
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return "1:1"
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return "1:1"
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(width, height)
  const ratio = `${width / divisor}:${height / divisor}`
  if ((GRSAI_SUPPORTED_RATIOS as readonly string[]).includes(ratio)) return ratio
  // 就近吸附：找 |log(w/h) - log(rw/rh)| 最小的支持比例
  const target = Math.log(width / height)
  let best = "1:1"
  let bestDist = Number.POSITIVE_INFINITY
  for (const candidate of GRSAI_SUPPORTED_RATIOS) {
    if (candidate === "auto") continue
    const [rw, rh] = candidate.split(":").map(Number)
    const dist = Math.abs(Math.log(rw / rh) - target)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

/**
 * 清晰度档位：手动覆盖优先；否则按预设总像素推导
 * （≤160 万像素 → 1K、≤600 万像素 → 2K、更大 → 4K，与 nano-banana
 * 1K≈百万像素级 / 2K≈四百万像素级的档位语义对齐；1024x1536 ≈ 157 万 → 1K）。
 */
export function grsaiImageSizeTier(
  size: string,
  override?: string | null,
): string {
  const manual = override?.trim()
  if (manual && (GRSAI_IMAGE_SIZE_TIERS as readonly string[]).includes(manual)) {
    return manual
  }
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return "1K"
  const pixels = Number(match[1]) * Number(match[2])
  if (pixels <= 1_600_000) return "1K"
  if (pixels <= 6_000_000) return "2K"
  return "4K"
}

/**
 * Grsai 生图请求体：POST {base}/v1/api/generate
 *
 * - 比例必传：aspectRatio 由尺寸预设 gcd 归约（不支持的比例就近吸附）
 * - 清晰度：imageSize 档位（1K/2K/4K），按预设像素自动推导或模型配置覆盖
 * - 参考图：images 数组（base64 与 URL 均支持，这里传转存后的 URL）
 * - replyType 固定 json（同步响应，与逐张工作单元模式一致）
 */
export function buildGrsaiRequestBody(
  input: BuildGrsaiRequestInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    aspectRatio: grsaiAspectRatio(input.imageSize || DEFAULT_IMAGE_SIZE),
    imageSize: grsaiImageSizeTier(input.imageSize, input.imageSizeOverride),
    replyType: "json",
  }
  if (input.referenceImages.length > 0) {
    body.images = input.referenceImages
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

/** 汇总错误时单条上游错误的长度上限（响应体可能很长，截断保留关键前段） */
const IMAGE_ERROR_MAX_LENGTH = 400
/** 汇总错误最多保留的条数（不同张可能因同一原因失败，去重后仍可能多条） */
const IMAGE_ERROR_MAX_ITEMS = 3

/**
 * 汇总一批生图结果中失败张的上游错误（去重、逐条截断、限量）。
 *
 * callImageApi 对单张失败不抛异常（部分成功语义，error 携带上游状态码/
 * 响应体摘要），调用方必须从这里取失败原因透传给重试收尾的报错/事件/
 * 任务日志——否则失败信息只剩"未知原因"，无法定位上游问题。
 * 全部成功时返回 null。
 */
export function summarizeImageErrors(results: readonly ImageGenResult[]): string | null {
  const errors: string[] = []
  for (const r of results) {
    if (r.url || !r.error) continue
    const trimmed = r.error.trim().slice(0, IMAGE_ERROR_MAX_LENGTH)
    if (trimmed && !errors.includes(trimmed)) errors.push(trimmed)
  }
  if (errors.length === 0) return null
  const shown = errors.slice(0, IMAGE_ERROR_MAX_ITEMS).join("；")
  return errors.length > IMAGE_ERROR_MAX_ITEMS ? `${shown}；等共 ${errors.length} 类错误` : shown
}

/**
 * 判断生图错误是否为上游内容安全策略拒绝（画面描述血腥/色情/暴力等被拦）。
 *
 * 这类失败可以通过改写提示词规避，调用方应把报错原文交给改写 AI；
 * 过载/限流/超时/网络等纯调用失败不匹配本函数——重试同样的提示词即可，
 * 不应触发改写。
 */
const CONTENT_POLICY_PATTERNS: RegExp[] = [
  /content[_\s-]?polic/i,
  /safety\s+(system|filter|setting|guard)/i,
  /polic(?:y|ies)\s+violation/i,
  /violat(?:es|ed|ion)\b[^\n]{0,60}(?:polic|content|communit|usage)/i,
  /prohibited\s+(?:content|by)/i,
  /\bnsfw\b/i,
  /sexual(?:ly)?\s+(?:explicit|content)/i,
  /graphic\s+(?:violence|content)/i,
  /敏感内容|内容安全|违规内容|审核不通过/,
]

export function isContentPolicyError(message: string): boolean {
  return CONTENT_POLICY_PATTERNS.some((pattern) => pattern.test(message))
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
