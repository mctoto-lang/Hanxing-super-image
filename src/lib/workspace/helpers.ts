/**
 * 工作台辅助纯函数（1:1 对齐旧项目 lib/）
 *
 * 从旧项目迁移：workspace-reference-images.ts、workspace-batch-upload.ts、
 * workspace-log-summary.ts 中的核心算法。
 */

import type {
  PromptCardRow,
  BatchGenerationLanguage,
  CardImageRow,
  TaskCardImagesPayload,
} from "./types"

// ─── 参考图 ───

/** 参考图模型接口（松散类型，兼容 boolean / number） */
interface ReferenceImageModel {
  supportsReferenceImage?: boolean | number | null
  maxReferenceImages?: number | null
}

/** 规范化参考图 URL 数组：过滤非字符串、trim、去重、去空 */
export function normalizeReferenceImages(images: unknown): string[] {
  if (!Array.isArray(images)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const img of images) {
    if (typeof img !== "string") continue
    const trimmed = img.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/** 获取参考图上限：不支持返回 0，否则 max(1, floor(max_reference_images || 1)) */
export function getReferenceImageLimit(model: ReferenceImageModel | null): number {
  if (!model) return 0
  const supports = Boolean(model.supportsReferenceImage)
  if (!supports) return 0
  const max = Number(model.maxReferenceImages)
  return Math.max(1, Math.floor(Number.isFinite(max) && max > 0 ? max : 1))
}

// ─── 翻译状态 ───

export function getTranslationStatus(
  card: Pick<
    PromptCardRow,
    "prompt" | "translatedPrompt" | "translationSourcePrompt" | "translationStatus"
  >,
): "none" | "translating" | "synced" | "outdated" {
  if (!card.translatedPrompt) {
    return card.translationStatus === "translating" ? "translating" : "none"
  }
  return card.translationSourcePrompt === card.prompt ? "synced" : "outdated"
}

// ─── 批量生图语言摘要 ───

export function getBatchGenerationLanguageSummary(
  cards: PromptCardRow[],
  language: BatchGenerationLanguage,
) {
  const hasEnglish = (card: PromptCardRow) => Boolean(card.translatedPrompt)
  const requiresLanguageSelection = cards.some(
    (card) => Boolean(card.prompt) && hasEnglish(card),
  )
  const primaryCount = cards.filter((card) =>
    language === "zh" ? Boolean(card.prompt) : hasEnglish(card),
  ).length

  return {
    requiresLanguageSelection,
    primaryCount,
    fallbackCount: cards.length - primaryCount,
  }
}

// ─── 生图提示词选择 ───

/** 根据语言偏好和卡片状态选择用于生图的提示词 */
export function getGenerationPrompt(
  card: Pick<
    PromptCardRow,
    "prompt" | "translatedPrompt" | "displayLanguage"
  >,
  languagePreference?: BatchGenerationLanguage,
): string {
  const hasEnglish = Boolean(card.translatedPrompt)
  if (languagePreference === "en") {
    return hasEnglish ? card.translatedPrompt! : card.prompt
  }
  if (languagePreference === "zh") {
    return card.prompt || (hasEnglish ? card.translatedPrompt! : card.prompt)
  }
  // 无偏好：按卡片显示语言
  return card.displayLanguage === "en" && hasEnglish
    ? card.translatedPrompt!
    : card.prompt
}

// ─── 轮询合并（身份稳定，保证 FlipCard memo 生效） ───

const sameDate = (a: Date | null, b: Date | null): boolean =>
  a === b || (a != null && b != null && a.getTime() === b.getTime())

/** 两张卡片渲染相关字段是否一致（一致则可复用旧对象引用，跳过重渲染） */
export function sameCardDisplay(a: PromptCardRow, b: PromptCardRow): boolean {
  return (
    a.prompt === b.prompt &&
    a.translatedPrompt === b.translatedPrompt &&
    a.translationSourcePrompt === b.translationSourcePrompt &&
    a.translationStatus === b.translationStatus &&
    a.displayLanguage === b.displayLanguage &&
    a.selectedImageId === b.selectedImageId &&
    a.selImgId === b.selImgId &&
    a.selImgUrl === b.selImgUrl &&
    a.selImgModelName === b.selImgModelName &&
    a.selImgSize === b.selImgSize &&
    sameDate(a.selImgStartedAt, b.selImgStartedAt) &&
    sameDate(a.selImgCompletedAt, b.selImgCompletedAt) &&
    sameDate(a.selImgCreatedAt, b.selImgCreatedAt) &&
    sameDate(a.updatedAt, b.updatedAt)
  )
}

/** 图片行内容是否一致（id 相同且关键字段未变 → 复用旧行引用） */
export function sameImageRow(a: CardImageRow, b: CardImageRow): boolean {
  return (
    a.status === b.status &&
    a.imageUrl === b.imageUrl &&
    a.isSelected === b.isSelected &&
    a.errorMessage === b.errorMessage &&
    a.generationTaskId === b.generationTaskId &&
    sameDate(a.generationStartedAt, b.generationStartedAt) &&
    sameDate(a.generationCompletedAt, b.generationCompletedAt)
  )
}

/**
 * 解析卡片的「展示图片」——与 FlipCard 正面展示一致的三级回退：
 *   ① selectedImageId 命中的图（用户显式选择 / 终态自动兜底选中）
 *   ② isSelected 标记的图
 *   ③ 首张有 URL 的已完成图（images 按 createdAt 降序，即最新在前）
 *
 * 导出（ZIP / 逐张）与卡片正面共用此解析，保证「下载的图片 == 卡片当前
 * 展示的图片」。卡片从未显式选图时 selectedImageId 为空，靠 ②③ 兜底。
 * 入参为结构化最小集，服务端瘦查询行（card_image select 子集）可直接复用。
 */
export interface DisplayImageLike {
  id: string
  imageUrl: string | null
  isSelected: boolean | null
  status: string
}

export function resolveCardDisplayImage(
  card: { selectedImageId: string | null },
  images: DisplayImageLike[],
): DisplayImageLike | null {
  return (
    images.find((i) => i.id === card.selectedImageId && i.imageUrl) ||
    images.find((i) => i.isSelected && i.imageUrl) ||
    images.find((i) => i.status === "completed" && i.imageUrl) ||
    null
  )
}

/**
 * 增量 upsert 图片数组：delta 行按 id 替换/追加；无任何有效变化时返回原数组引用。
 * 全量模式（incremental=false）直接采用 payload 行（服务端已是该卡全量）。
 * 服务端每轮会重发未变化的选中行——这类行保留旧引用，避免击穿 memo。
 */
export function mergeImageRows(
  prev: CardImageRow[] | undefined,
  payloadRows: CardImageRow[],
  incremental: boolean,
): CardImageRow[] {
  if (!incremental || !prev || prev.length === 0) return payloadRows
  if (payloadRows.length === 0) return prev

  const prevById = new Map(prev.map((r) => [r.id, r] as const))
  let changed = false
  for (const row of payloadRows) {
    const old = prevById.get(row.id)
    if (!old || !sameImageRow(old, row)) {
      prevById.set(row.id, row)
      changed = true
    }
  }
  if (!changed) return prev

  // 保持 createdAt 倒序（与服务端排序一致）
  return [...prevById.values()].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

// ─── 轮询对账 ───

/**
 * 对比服务端计数（权威：服务端 GROUP BY 全量计数）与本地 images 数组推算的
 * 计数，返回不一致的卡片 id。增量丢行（如跨进程时钟偏移导致的跨界行）会让
 * 本地计数永远落后（典型：服务端 pending=0 但本地残留 pending 行），检测到
 * 不一致后应做一次全量重同步。
 */
export function findCountMismatch(
  payload: TaskCardImagesPayload,
  localMap: Map<string, CardImageRow[]>,
): string[] {
  const mismatched: string[] = []
  for (const summary of Object.values(payload.cards)) {
    const rows = localMap.get(summary.cardId) ?? []
    let pending = 0
    let completed = 0
    let failed = 0
    for (const row of rows) {
      if (row.status === "pending" || row.status === "generating") pending++
      else if (row.status === "completed") completed++
      else if (row.status === "failed") failed++
    }
    if (
      pending !== summary.pendingCount ||
      completed !== summary.completedCount ||
      failed !== summary.failedCount
    ) {
      mismatched.push(summary.cardId)
    }
  }
  return mismatched
}

// ─── 翻转卡辅助 ───

/** 判断是否应自动翻到图片面 */
export function shouldAutoFlipToImage(opts: {
  hasImage: boolean
  previousImageUrl: string | null
  currentImageUrl: string | null
  isEditingPrompt: boolean
  manuallyFlippedToBack: boolean
}): boolean {
  if (!opts.hasImage) return false
  if (opts.isEditingPrompt) return false
  if (opts.manuallyFlippedToBack) return false
  // URL 变化时触发
  return opts.currentImageUrl !== opts.previousImageUrl
}

// ─── 卡片网格辅助 ───

export const INITIAL_VISIBLE_COUNT = 16
export const VISIBLE_STEP = 12
export const GRID_COLUMNS = 4

export function shouldShowBottomSkeletons(
  visibleCount: number,
  totalCards: number,
): boolean {
  return visibleCount < totalCards
}

export function getBottomSkeletonCount(
  visibleCount: number,
  totalCards: number,
): number {
  if (!shouldShowBottomSkeletons(visibleCount, totalCards)) return 0
  return Math.min(VISIBLE_STEP, totalCards - visibleCount)
}

export function getBottomSkeletonIndexes(
  visibleCount: number,
  totalCards: number,
): number[] {
  const count = getBottomSkeletonCount(visibleCount, totalCards)
  return Array.from({ length: count }, (_, i) => visibleCount + i + 1)
}

export function getNextVisibleCountOnDataChange(
  currentVisibleCount: number,
  totalCards: number,
): number {
  return Math.min(Math.max(INITIAL_VISIBLE_COUNT, currentVisibleCount), totalCards)
}

// ─── 模板辅助 ───

export const workspaceTemplateTypes: Array<{
  value: string
  label: string
}> = [
  { value: "fission", label: "裂变模板" },
  { value: "deepen", label: "细化模板" },
  { value: "regenerate", label: "重生成模板" },
  { value: "extract", label: "提取提示词模板" },
  { value: "translate", label: "翻译模板" },
]

export function filterWorkspaceTemplates(
  templates: Array<{ type: string }>,
  type: string,
): Array<{ type: string }> {
  return templates.filter((t) => t.type === type)
}

export function createWorkspaceTemplatePayload(form: {
  name: string
  type: string
  content: string
  chatApiId: string
  fissionCount: string | number | null
  visibility: string
}): Record<string, unknown> {
  return {
    name: form.name.trim(),
    type: form.type,
    content: form.content,
    chatApiId: form.chatApiId,
    fissionCount:
      form.type === "fission" && form.fissionCount
        ? Number(form.fissionCount)
        : null,
    visibility: form.visibility,
  }
}

// ─── 图片库辅助 ───

export type GalleryMode = "selected" | "reference"

export function getInitialGalleryMode(
  requestedMode: GalleryMode | undefined,
  referenceLimit: number,
): GalleryMode {
  if (requestedMode === "reference" && referenceLimit > 0) return "reference"
  return "selected"
}

export function getGalleryModeOptions(referenceLimit: number): Array<{
  value: GalleryMode
  label: string
}> {
  const options: Array<{ value: GalleryMode; label: string }> = [
    { value: "selected", label: "选择展示图" },
  ]
  if (referenceLimit > 0) {
    options.push({ value: "reference", label: "管理参考图" })
  }
  return options
}

export function getGalleryModeLabel(mode: GalleryMode): string {
  return mode === "reference" ? "管理参考图" : "选择展示图"
}

export function shouldShowReferenceFooter(referenceLimit: number): boolean {
  return referenceLimit > 0
}

// ─── 队列状态徽章 ───

export function getQueueBadgeColor(
  total: number,
  greenThreshold = 10,
  yellowThreshold = 15,
): "green" | "yellow" | "red" {
  if (total === 0) return "green"
  if (total < greenThreshold) return "green"
  if (total < yellowThreshold) return "yellow"
  return "red"
}

// ─── 文件名清理 ───

export function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

// ─── 日志摘要 ───

export function summarizeImageResponseBody(body: string | null): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === "object" && "imageCount" in parsed) {
      return `生成 ${parsed.imageCount} 张图片`
    }
    return body
  } catch {
    return body
  }
}
