/**
 * 图片模型请求体构造（纯函数库，零副作用，零外部依赖）
 *
 * 接口格式（2026-11 规范化为六格式）：
 * - openai：Images 协议（OpenAI 标准：无参考图 POST {base}/v1/images/generations，
 *   带参考图 POST {base}/v1/images/edits multipart，见 openai-image.ts）
 * - chat：Chat 协议（OpenAI 兼容对话接口生图：参考图走 image_url 多模态消息，
 *   从回复内容解析图片 URL/b64；无尺寸参数，尺寸由模型自行决定）
 * - gemini：Gemini 协议（官方原生 :generateContent + responseModalities IMAGE，
 *   imageConfig.aspectRatio 比例生图；参考图 inlineData base64）
 * - midjourney：Midjourney（MJ Proxy 协议，aipaiai：/mj/submit/imagine 提交 +
 *   /mj/task/{id}/fetch 轮询，一次任务固定 4 张四宫格）
 * - jimeng：即梦（jimeng-free-api 反代）
 * - grsai：Grsai（统一端点 /v1/api/generate：aspectRatio 比例 + imageSize 清晰度档位）
 *
 * openai（Images 协议）「尺寸传参模式」（extraConfig.sizeMode）：
 * pixels = size 像素串（默认）；ratio = 比例参数（nano banana 系中转，
 * 1024x1024 → 1:1）；tier = 清晰度档位（1K/2K/4K，按预设像素推导，
 * 可由 tierValue 固定为指定档位）。
 * 旧 gemini 行 useRatioParam=true 已随 0102 迁移补写 sizeMode='ratio'。
 */

export type ImageApiFormat =
  | "openai"
  | "jimeng"
  | "gemini"
  | "grsai"
  | "chat"
  | "midjourney"

export const DEFAULT_IMAGE_API_FORMAT: ImageApiFormat = "openai"
/**
 * 即梦参考图字段缺省名。
 * jimeng-free-api 反代的 /v1/images/generations 只解析 filePath（单张，向后
 * 兼容）/ filePaths（数组）两个参考图字段（另支持 multipart 上传），其余字段名
 * （如 images）会被静默忽略、按纯文生图出图，故默认取数组形式的 filePaths。
 */
export const DEFAULT_JIMENG_REFERENCE_IMAGE_FIELD = "filePaths"
/** OpenAI 生图参考图字段缺省名（参考图以 URL 链接数组传入 image 字段） */
export const DEFAULT_OPENAI_REFERENCE_IMAGE_FIELD = "image"
/** ratio 模式字段缺省名（nano banana / OpenRouter 风格中转；可按中转站约定覆盖） */
export const DEFAULT_RATIO_FIELD = "aspect_ratio"
/**
 * tier 模式字段缺省名（中转站约定不一：常见 size / image_size，
 * 可由 ratioParamField 覆盖）。
 */
export const DEFAULT_TIER_FIELD = "size"
/** imageSize 兜底（历史任务缺尺寸时，避免请求体缺字段） */
export const DEFAULT_IMAGE_SIZE = "1024x1024"

/** 尺寸传参模式（openai/gemini 共用）：pixels=尺寸串 / ratio=比例 / tier=清晰度档位 */
export type ImageSizeMode = "pixels" | "ratio" | "tier"
export const IMAGE_SIZE_MODES = ["pixels", "ratio", "tier"] as const
/** response_format 透传合法值（缺省不传，维持上游默认） */
export const IMAGE_RESPONSE_FORMATS = ["url", "b64_json"] as const

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
  /** 尺寸传参模式（新配置，优先于旧 useRatioParam 回退） */
  sizeMode?: ImageSizeMode
  /** 旧 gemini 配置：以比例参数代替尺寸参数（sizeMode 缺省时回退生效） */
  useRatioParam?: boolean
  /** tier 模式固定档位（1K/2K/4K；空 = 按预设像素自动推导） */
  tierValue?: string | null
  /** 比例/档位参数字段名（空 = ratio→aspect_ratio、tier→size） */
  ratioParamField?: string | null
  /** response_format 透传（url / b64_json；空 = 请求体不带该字段） */
  responseFormat?: string
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

const FORMATS = new Set<ImageApiFormat>([
  "openai",
  "jimeng",
  "gemini",
  "grsai",
  "chat",
  "midjourney",
])

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
    throw new Error(
      "图片模型仅支持 openai、chat、gemini、midjourney、jimeng、grsai 接口格式",
    )
  }
  const config = parseExtraConfig(input.extraConfig)

  // openai（Images 协议）：quality（质量透传）+ sizeMode（尺寸传参模式）+
  // tierValue（tier 固定档位）+ responseFormat（response_format 透传），
  // 值为管理员按上游文档填写
  if (format === "openai") {
    rejectUnsupportedFields(
      config,
      new Set(["quality", "sizeMode", "tierValue", "responseFormat"]),
    )
    const quality = config.quality
    if (quality !== undefined && typeof quality !== "string") {
      throw new Error("quality 必须是字符串")
    }
    if (
      config.sizeMode !== undefined &&
      !(IMAGE_SIZE_MODES as readonly string[]).includes(String(config.sizeMode))
    ) {
      throw new Error(`sizeMode 仅支持 ${IMAGE_SIZE_MODES.join("、")}`)
    }
    if (
      config.tierValue !== undefined &&
      !(GRSAI_IMAGE_SIZE_TIERS as readonly string[]).includes(
        String(config.tierValue),
      )
    ) {
      throw new Error(`tierValue 仅支持 ${GRSAI_IMAGE_SIZE_TIERS.join("、")}`)
    }
    if (
      config.responseFormat !== undefined &&
      !(IMAGE_RESPONSE_FORMATS as readonly string[]).includes(
        String(config.responseFormat),
      )
    ) {
      throw new Error(
        `responseFormat 仅支持 ${IMAGE_RESPONSE_FORMATS.join("、")}`,
      )
    }
    return
  }

  // chat（Chat 协议）/ gemini（Gemini 官方原生）：无尺寸/质量类透传配置
  if (format === "chat" || format === "gemini") {
    rejectUnsupportedFields(config, new Set())
    return
  }

  // midjourney：仅 prompt 参数后缀（--ar 由所选比例自动生成，管理员无须也不应配置）
  if (format === "midjourney") {
    rejectUnsupportedFields(config, new Set(["mjFlags"]))
    if (config.mjFlags !== undefined && typeof config.mjFlags !== "string") {
      throw new Error("mjFlags 必须是字符串")
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
 * 解析尺寸传参模式（openai/gemini 共用）：
 * extraConfig.sizeMode 优先；旧 gemini 行 useRatioParam=true 回退视为
 * ratio（存量数据不迁移、行为不变）；都缺省为 pixels。
 */
export function resolveImageSizeMode(
  extraConfig?: Record<string, unknown> | null,
  legacyUseRatioParam?: boolean | null,
): ImageSizeMode {
  const raw = extraConfig?.sizeMode
  if (raw === "pixels" || raw === "ratio" || raw === "tier") return raw
  return legacyUseRatioParam === true ? "ratio" : "pixels"
}

/**
 * OpenAI 兼容生图请求体：POST {base}/v1/images/generations
 *
 * - 尺寸传参模式（sizeMode，openai/gemini 共用；旧 useRatioParam 回退兼容）：
 *   - pixels（默认）：size 字段传像素串（"1024x1536"；智能比例传 "auto"）
 *   - ratio：比例参数（默认字段 aspect_ratio，值由尺寸 gcd 归约，如
 *     1024x1024 → 1:1），此时请求体不再携带 size（nano banana 系中转）
 *   - tier：清晰度档位（默认字段 size，值 1K/2K/4K 按预设总像素推导；
 *     中转站约定字段名不一，可由 ratioParamField 覆盖为 image_size 等）
 * - 参考图以 URL 链接数组传入 image 字段（字段名可由 referenceImageField 覆盖）
 * - quality（可选）：管理员配置的质量参数原样透传（如 high/medium/low、hd/standard）
 * - response_format（可选）：url / b64_json 透传（部分上游默认返回
 *   b64、需显式要求才返回 URL，或反之）
 */
export function buildOpenAiRequestBody(
  input: BuildOpenAiRequestInput,
): Record<string, unknown> {
  const size = input.imageSize?.trim() || DEFAULT_IMAGE_SIZE
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
  }
  const mode = resolveImageSizeMode(
    { sizeMode: input.sizeMode },
    input.useRatioParam,
  )
  if (mode === "ratio") {
    const field = input.ratioParamField?.trim() || DEFAULT_RATIO_FIELD
    body[field] = sizeToRatio(size)
  } else if (mode === "tier") {
    const field = input.ratioParamField?.trim() || DEFAULT_TIER_FIELD
    body[field] = grsaiImageSizeTier(size, input.tierValue)
  } else {
    body.size = size
  }
  if (input.quality?.trim()) {
    body.quality = input.quality.trim()
  }
  if (input.responseFormat?.trim()) {
    body.response_format = input.responseFormat.trim()
  }
  if (input.referenceImages.length > 0) {
    const field =
      input.referenceImageField?.trim() ||
      DEFAULT_OPENAI_REFERENCE_IMAGE_FIELD
    body[field] = input.referenceImages
  }
  return body
}

/**
 * 即梦生图请求体：POST {model.apiEndpoint}（jimeng-free-api 反代）
 *
 * - 尺寸不发像素 size，走 ratio（gcd 归约比例）+ resolution（1k/2k/4k 档位）
 * - 参考图以 URL 数组传入 filePaths 字段（字段名可由 referenceImageField 覆盖）；
 *   反代侧自行拉取 http(s) URL 或解析 data:URL，上传后走混合生成（blend）模式
 */
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
      input.referenceImageField?.trim() ||
      DEFAULT_JIMENG_REFERENCE_IMAGE_FIELD
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

// ═══════════════ Chat 协议（OpenAI 兼容对话接口生图） ═══════════════

/**
 * Chat 生图请求体：POST {base}/v1/chat/completions
 *
 * - prompt 作为 user 消息文本；参考图以 image_url 多模态 part 附加（OpenAI
 *   vision 消息形状，各类聚合渠道通用）；无参考图时 content 直接用纯文本
 *   字符串（兼容面最宽）
 * - 无尺寸/质量参数（协议本身不支持，尺寸由模型自行决定）
 */
export function buildChatImageRequestBody(input: {
  model: string
  prompt: string
  referenceImages: string[]
}): Record<string, unknown> {
  const content =
    input.referenceImages.length > 0
      ? [
          { type: "text", text: input.prompt },
          ...input.referenceImages.map((url) => ({
            type: "image_url",
            image_url: { url },
          })),
        ]
      : input.prompt
  return {
    model: input.model,
    messages: [{ role: "user", content }],
  }
}

/**
 * 从 Chat 协议回复的 message.content 解析图片列表（返回 URL / data URL 数组）：
 * - content 为分段数组时取 image_url part 的 url（兼容 image_url 为字符串或
 *   {url} 对象、以及 output_url 变体）
 * - 文本内容提取 markdown 图片链接 ![alt](url)，其次裸 data:URI 与常见
 *   图片扩展名的 URL（部分聚合渠道直接回纯 URL 文本）
 */
export function extractChatImages(content: unknown): string[] {
  const urls: string[] = []
  const texts: string[] = []
  const push = (u: unknown) => {
    if (typeof u === "string" && u && !urls.includes(u)) urls.push(u)
  }
  const pushUrlPart = (part: Record<string, unknown>) => {
    const iu = part.image_url ?? part.output_url ?? part.image
    if (typeof iu === "string") push(iu)
    else if (iu && typeof iu === "object") push((iu as Record<string, unknown>).url)
    if (typeof part.url === "string") push(part.url)
  }
  if (typeof content === "string") {
    texts.push(content)
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw === "string") {
        texts.push(raw)
        continue
      }
      if (!raw || typeof raw !== "object") continue
      const part = raw as Record<string, unknown>
      if (part.type === "image_url" || part.type === "output_url" || part.type === "image") {
        pushUrlPart(part)
      }
      if (typeof part.text === "string") texts.push(part.text)
    }
  }
  if (urls.length === 0) {
    const joined = texts.join("\n")
    // markdown 图片链接
    for (const m of joined.matchAll(/!\[[^\]]*\]\((\s*<)?([^)\s>]+)/g)) {
      push(m[2])
    }
    if (urls.length === 0) {
      // 裸 data URI 与常见图片扩展名 URL
      for (const m of joined.matchAll(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g)) {
        push(m[0])
      }
      for (const m of joined.matchAll(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/gi)) {
        push(m[0])
      }
    }
  }
  return urls
}

// ═══════════════ Gemini 协议（官方原生 :generateContent 生图） ═══════════════

/** Gemini imageConfig.aspectRatio 支持值（官方生图模型固定十档；无像素级尺寸控制） */
const GEMINI_SUPPORTED_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
] as const

/**
 * 把尺寸串换算成 Gemini aspectRatio：gcd 归约；不在支持集时按对数距离就近
 * 吸附（复用 Grsai 同款算法，支持集不同）；"auto" 返回 null（省略 imageConfig，
 * 由模型自定比例）。普通比例最大 14:1，超限钳到边界。
 */
export function geminiAspectRatio(size: string): string | null {
  if (size === "auto") return null
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return "1:1"
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return "1:1"
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(width, height)
  let rw = width / divisor
  let rh = height / divisor
  // MJ/Gemini 普通模式画幅上限 14:1（含竖向），超限先钳到边界再吸附
  if (rw / rh > 14) rw = 14 * rh
  if (rh / rw > 14) rh = 14 * rw
  const ratio = `${rw}:${rh}`
  if ((GEMINI_SUPPORTED_RATIOS as readonly string[]).includes(ratio)) return ratio
  const target = Math.log(rw / rh)
  let best = "1:1"
  let bestDist = Number.POSITIVE_INFINITY
  for (const candidate of GEMINI_SUPPORTED_RATIOS) {
    const [cw, ch] = candidate.split(":").map(Number)
    const dist = Math.abs(Math.log(cw / ch) - target)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

/** Gemini 参考图（服务端取图后转 base64 的 inlineData part 载荷） */
export interface GeminiInlineImage {
  mimeType: string
  data: string
}

/**
 * Gemini 原生生图请求体：POST {base}/v1beta/models/{model}:generateContent
 *
 * - generationConfig.responseModalities 必须含 IMAGE 才返回图片
 * - 比例生图：imageConfig.aspectRatio（十档；"auto" 省略该节）
 * - 参考图以 inline_data base64 part 附加（官方协议不接受图片 URL）
 */
export function buildGeminiImageRequestBody(input: {
  prompt: string
  imageSize: string
  inlineImages: GeminiInlineImage[]
}): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: input.prompt }]
  for (const img of input.inlineImages) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } })
  }
  const aspectRatio = geminiAspectRatio(input.imageSize || DEFAULT_IMAGE_SIZE)
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
    ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
  }
  return {
    contents: [{ role: "user", parts }],
    generationConfig,
  }
}

/**
 * 从 Gemini generateContent 响应解析图片 data URL 列表（inlineData /
 * inline_data part；兼容 data 为带前缀 data URL 或裸 base64）。
 */
export function extractGeminiImages(data: unknown): string[] {
  if (!data || typeof data !== "object") return []
  const obj = data as Record<string, unknown>
  const candidates = obj.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const first = candidates[0]
  if (!first || typeof first !== "object") return []
  const content = (first as Record<string, unknown>).content
  if (!content || typeof content !== "object") return []
  const parts = (content as Record<string, unknown>).parts
  if (!Array.isArray(parts)) return []
  const urls: string[] = []
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue
    const part = raw as Record<string, unknown>
    const inline = (part.inlineData ?? part.inline_data) as
      | Record<string, unknown>
      | undefined
    const mimeType =
      (inline?.mimeType as string) ?? (inline?.mime_type as string) ?? "image/png"
    const base64 = inline?.data
    if (typeof base64 === "string" && base64) {
      urls.push(
        base64.startsWith("data:")
          ? base64
          : `data:${mimeType};base64,${base64}`,
      )
    }
  }
  return urls
}

/** 从 Gemini 错误响应提取 message（{error: {message, status}} 常见形态） */
export function extractGeminiErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const err = (data as Record<string, unknown>).error
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>
    const msg = obj.message ?? obj.status
    if (typeof msg === "string" && msg) return msg
  }
  if (typeof err === "string" && err) return err
  return null
}

// ═══════════════ Midjourney（MJ Proxy 协议，aipaiai） ═══════════════

/** 归一化 MJ Proxy 根地址：容忍配到域名 / /mj / 完整 submit 路径 */
export function resolveMidjourneyBase(endpoint: string): string {
  const url = endpoint.replace(/\/+$/, "")
  if (url.endsWith("/mj/submit/imagine")) {
    return url.slice(0, -"/mj/submit/imagine".length)
  }
  if (url.endsWith("/mj")) return url.slice(0, -"/mj".length)
  return url
}

/** MJ imagine 提交端点 */
export function resolveMidjourneySubmitEndpoint(endpoint: string): string {
  return `${resolveMidjourneyBase(endpoint)}/mj/submit/imagine`
}

/** MJ 任务查询端点（GET，返回任务对象本身） */
export function resolveMidjourneyFetchEndpoint(
  endpoint: string,
  taskId: string,
): string {
  return `${resolveMidjourneyBase(endpoint)}/mj/task/${encodeURIComponent(taskId)}/fetch`
}

/**
 * 构造 MJ imagine 提交 prompt：
 * - 参考图（公网 URL）以空格拼接在 prompt 开头（协议约定）
 * - --ar 由所选比例 gcd 归约生成（auto 时省略）；普通模式画幅上限 14:1，
 *   超限钳到边界
 * - 管理员配置的参数后缀 mjFlags 追加在末尾（自动剔除其中可能冲突的 --ar）
 */
export function buildMidjourneyPrompt(input: {
  prompt: string
  imageSize: string
  referenceImages: string[]
  flags?: string | null
}): string {
  const parts: string[] = [...input.referenceImages, input.prompt.trim()]
  const ar = geminiAspectRatio(input.imageSize || DEFAULT_IMAGE_SIZE)
  if (ar) parts.push(`--ar ${ar}`)
  const flags = (input.flags ?? "")
    .replace(/(^|\s)--ar\s+\S+/gi, "$1")
    .trim()
  if (flags) parts.push(flags)
  return parts.filter(Boolean).join(" ")
}

/**
 * 解析 MJ imagine 提交响应：{code, description, result}。
 * code 为 1/21/22 且 result 为非空字符串才算提交成功（HTTP 200 不代表成功）。
 */
export function parseMidjourneySubmitResponse(
  data: unknown,
): { ok: true; taskId: string } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "MJ 提交响应格式无法识别" }
  }
  const obj = data as Record<string, unknown>
  const code = Number(obj.code)
  const description =
    typeof obj.description === "string" ? obj.description : "未知错误"
  if ((code === 1 || code === 21 || code === 22) && typeof obj.result === "string" && obj.result) {
    return { ok: true, taskId: obj.result }
  }
  return { ok: false, error: `MJ 提交失败（code ${code || "?"}）：${description}` }
}

/** MJ 任务查询态（status 大写枚举；splitStatus 小写枚举） */
export interface MidjourneyTaskState {
  /** NOT_START / IN_PROGRESS / SUCCESS / FAILURE / 未知 */
  status: string
  /** waiting / polling / succeeded / failed / expired（四图拆分） */
  splitStatus: string | null
  /** 拆分后图片（index 1-4 对应四宫格位置） */
  images: Array<{ url: string; width: number | null; height: number | null }>
  progress: string | null
  failReason: string | null
}

/** 解析 /mj/task/{id}/fetch 返回的任务对象 */
export function extractMidjourneyTaskState(data: unknown): MidjourneyTaskState {
  const state: MidjourneyTaskState = {
    status: "",
    splitStatus: null,
    images: [],
    progress: null,
    failReason: null,
  }
  if (!data || typeof data !== "object") return state
  const obj = data as Record<string, unknown>
  if (typeof obj.status === "string") state.status = obj.status.toUpperCase()
  if (typeof obj.splitStatus === "string") state.splitStatus = obj.splitStatus
  if (typeof obj.progress === "string") state.progress = obj.progress
  if (typeof obj.failReason === "string" && obj.failReason) {
    state.failReason = obj.failReason
  }
  if (Array.isArray(obj.images)) {
    for (const raw of obj.images) {
      if (!raw || typeof raw !== "object") continue
      const img = raw as Record<string, unknown>
      const url = typeof img.url === "string" ? img.url : null
      if (!url) continue
      state.images.push({
        url,
        width: Number(img.width) > 0 ? Number(img.width) : null,
        height: Number(img.height) > 0 ? Number(img.height) : null,
      })
    }
  }
  return state
}

// ═══════════════ 生图结果共享类型（供适配器与队列消费者使用） ═══════════════

/** 单张图片生成结果（index 对应任务内图片序号；url/error 二选一） */
export interface ImageGenResult {
  index: number
  url?: string
  /** 转存时探测到的像素尺寸（本桶复用/探测失败为 null；无 url 时无意义） */
  width?: number | null
  height?: number | null
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

/** result_image_sizes 的单元素类型（与 result_images 按位置一一对应；null=未探测到） */
export type ResultImageSize = { width: number; height: number } | null

/**
 * 合并历史成功图片与本轮结果（重试补张时保留已成功图片）。
 * 返回按序号升序排列的成功序号 + 一一对应的 URL 列表 + 尺寸列表
 * （尺寸同样按位置对齐：历史项保留原尺寸——无记录为 null，本轮覆盖
 * 时随新 URL 一起替换为本轮探测值）。
 */
export function mergeImageResults(
  prevIndexes: number[],
  prevUrls: string[],
  prevSizes: ResultImageSize[] | null,
  results: ImageGenResult[],
): {
  succeededIndexes: number[]
  resultImages: string[]
  resultImageSizes: ResultImageSize[]
} {
  const map = new Map<number, { url: string; size: ResultImageSize }>()
  prevIndexes.forEach((idx, i) => {
    const url = prevUrls[i]
    if (url) map.set(idx, { url, size: prevSizes?.[i] ?? null })
  })
  for (const r of results) {
    if (r.url) {
      map.set(r.index, {
        url: r.url,
        size:
          r.width != null && r.height != null
            ? { width: r.width, height: r.height }
            : null,
      })
    }
  }
  const succeededIndexes = [...map.keys()].sort((a, b) => a - b)
  return {
    succeededIndexes,
    resultImages: succeededIndexes.map((i) => map.get(i)!.url),
    resultImageSizes: succeededIndexes.map((i) => map.get(i)!.size),
  }
}
