/**
 * 模板流程 LLM 输出的解析与校验（纯函数，零运行时依赖）。
 *
 * 从 template-steps 抽出：template-steps 依赖执行链（orchestrator →
 * task-queue → redis），纯函数单测不需要也不应连上真实 Redis——
 * 本模块保持零 db/redis import。
 */
import type { AgentClarifyQuestion, AgentTemplateDirection } from "@/lib/agent/graph"
import { SINGLE_PROMPT_BORDER_SUFFIX } from "@/lib/agent/cards/plan"
import { LlmValidationError } from "./llm-errors"

/** 单条澄清消息最多追问数（澄清 system prompt 与解析共用同一上限） */
export const MAX_CLARIFY_QUESTIONS = 3

/** 每个追问输出的推荐选项上限（与「3 个最适合的推荐选项」策略对齐） */
export const MAX_CLARIFY_OPTIONS = 3

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// ═══════════════════════════ 澄清输出解析 ═══════════════════════════

/** 澄清轮 LLM 输出（归一化后） */
export interface ClarifyOutput {
  analysis: string
  filled: Record<string, string>
  questions: AgentClarifyQuestion[]
  ready: boolean
}

/**
 * 归一化并校验澄清轮输出：questions 裁到最多 3 个；question 文本为空的条目、
 * 非布尔的 ready 视为不合格（抛 LlmValidationError → callLlmJson 纠错重试）。
 */
export function parseClarifyOutput(raw: unknown): ClarifyOutput {
  const obj = asRecord(raw)
  if (!obj) throw new LlmValidationError("输出不是 JSON 对象")
  const analysis = typeof obj.analysis === "string" ? obj.analysis.trim() : ""

  const filled: Record<string, string> = {}
  const rawFilled = asRecord(obj.filled)
  if (rawFilled) {
    for (const [key, value] of Object.entries(rawFilled)) {
      if (typeof value === "string" && value.trim()) filled[key] = value.trim()
    }
  }

  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : []
  const questions: AgentClarifyQuestion[] = []
  const seenIds = new Set<string>()
  for (const item of rawQuestions.slice(0, MAX_CLARIFY_QUESTIONS)) {
    const q = asRecord(item)
    const text = q && typeof q.question === "string" ? q.question.trim() : ""
    if (!text) throw new LlmValidationError("questions 中存在缺少 question 文本的条目")
    let id = q && typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q-${questions.length + 1}`
    while (seenIds.has(id)) id = `${id}-${questions.length + 1}`
    seenIds.add(id)
    const topic = q && (q.topic === "style" || q.topic === "content") ? q.topic : undefined
    const options = (q && Array.isArray(q.options) ? q.options : [])
      .map((o) => (typeof o === "string" ? o.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_CLARIFY_OPTIONS)
    questions.push(topic ? { id, topic, question: text, options } : { id, question: text, options })
  }

  if (typeof obj.ready !== "boolean") throw new LlmValidationError("ready 必须是布尔值")
  return { analysis, filled, questions, ready: obj.ready }
}

// ═══════════════════════════ 方向输出校验 ═══════════════════════════

/** 小阿卡纳四花色的兜底映射（LLM 缺项时按塔罗经典元素补全） */
const SUIT_ELEMENT_DEFAULTS: { suit: string; mapping: string }[] = [
  { suit: "权杖", mapping: "火 · 行动与创造的意象" },
  { suit: "圣杯", mapping: "水 · 情感与关系的意象" },
  { suit: "宝剑", mapping: "风 · 思维与冲突的意象" },
  { suit: "星币", mapping: "土 · 物质与现实的意象" },
]

function slugifyDirectionId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

// ═══════════════════════════ 风格短语（风格锚点） ═══════════════════════════

/** 风格短语长度区间（撰写目标 20-50 字；兜底截断上限 60 字） */
export const STYLE_PHRASE_MIN_CHARS = 10
export const STYLE_PHRASE_MAX_CHARS = 60

/**
 * 归一化 LLM 产出的风格短语：过短/缺失时取风格总述首个分句确定性补全
 * （截 60 字），风格规范生成是流程咽喉，不因短语缺失判废卡流程。
 */
function normalizeStylePhrase(raw: unknown, visualLanguage: string, name: string): string {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (text.length >= STYLE_PHRASE_MIN_CHARS) return text.slice(0, STYLE_PHRASE_MAX_CHARS)
  const firstClause = (visualLanguage.split(/[。；;]/)[0] ?? "").trim()
  if (firstClause.length >= STYLE_PHRASE_MIN_CHARS) return firstClause.slice(0, STYLE_PHRASE_MAX_CHARS)
  return `${name}风格，整套 78 张统一媒介、色调与光影氛围`.slice(0, STYLE_PHRASE_MAX_CHARS)
}

/**
 * 读取方向的风格锚点短语（78 张提示词逐字开头的文字锚）。
 * 存量方向数据无 stylePhrase 字段——兜底取风格总述首个分句，再兜底固定文案。
 */
export function stylePhraseOf(direction: {
  stylePhrase?: unknown
  visualLanguage: string
  name: string
}): string {
  return normalizeStylePhrase(direction.stylePhrase, direction.visualLanguage, direction.name)
}

/**
 * 方向示例图提示词：画面风格总述 + 首张示例卡场景（该方向下的画面预演），
 * 供方向选择阶段生成 1 张预览图。纯函数，便于单测。
 */
export function buildDirectionExamplePrompt(direction: AgentTemplateDirection): string {
  const sample = direction.sampleCards[0]
  const scene = sample ? `${sample.name}：${sample.scene}` : "以该方向核心意象设计的塔罗卡面"
  return `${direction.visualLanguage}。${scene}。主体占画面 60% 以上，近景特写，构图与卡面出图比例一致。${SINGLE_PROMPT_BORDER_SUFFIX}`
}

function normalizeSuitMapping(raw: unknown): { suit: string; mapping: string }[] {
  const fromLlm = new Map<string, string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = asRecord(item)
      const suit = entry && typeof entry.suit === "string" ? entry.suit.trim() : ""
      const mapping = entry && typeof entry.mapping === "string" ? entry.mapping.trim() : ""
      if (suit) fromLlm.set(suit, mapping)
    }
  }
  return SUIT_ELEMENT_DEFAULTS.map(({ suit, mapping }) => ({
    suit,
    mapping: fromLlm.get(suit) || mapping,
  }))
}

function normalizeSampleCards(raw: unknown, directionName: string): { name: string; scene: string }[] {
  if (!Array.isArray(raw)) {
    throw new LlmValidationError(`方向「${directionName}」缺少示例牌 sampleCards`)
  }
  const cards = raw
    .map((item) => {
      const c = asRecord(item)
      const name = c && typeof c.name === "string" ? c.name.trim() : ""
      const scene = c && typeof c.scene === "string" ? c.scene.trim() : ""
      return name ? { name, scene } : null
    })
    .filter((c): c is { name: string; scene: string } => c !== null)
    .slice(0, 3)
  if (cards.length === 0) {
    throw new LlmValidationError(`方向「${directionName}」缺少有效的示例牌`)
  }
  return cards
}

/**
 * 校验并归一化 gen_directions 输出：恰好 3 个方向、名称非空且互不重复、
 * id 缺失时按名称/序号生成并保证唯一。不合格抛 LlmValidationError。
 */
export function validateDirections(raw: unknown): AgentTemplateDirection[] {
  const obj = asRecord(raw)
  const list = obj && Array.isArray(obj.directions) ? obj.directions : null
  if (!list) throw new LlmValidationError("输出缺少 directions 数组")
  if (list.length !== 3) {
    throw new LlmValidationError(`directions 必须恰好 3 个方向，实际 ${list.length} 个`)
  }
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  return list.map((item, index) => {
    const d = asRecord(item)
    if (!d) throw new LlmValidationError(`第 ${index + 1} 个方向不是对象`)
    const name = typeof d.name === "string" ? d.name.trim() : ""
    if (!name) throw new LlmValidationError(`第 ${index + 1} 个方向缺少名称`)
    if (seenNames.has(name)) throw new LlmValidationError(`方向名重复：${name}`)
    seenNames.add(name)

    let id = slugifyDirectionId(typeof d.id === "string" ? d.id : "")
    if (!id) id = slugifyDirectionId(name)
    if (!id) id = `direction-${index + 1}`
    while (seenIds.has(id)) id = `${id}-${index + 1}`
    seenIds.add(id)

    const concept = typeof d.concept === "string" ? d.concept.trim() : ""
    const palette = typeof d.palette === "string" ? d.palette.trim() : ""
    const description = (typeof d.description === "string" && d.description.trim()) || concept || name
    const worldview = typeof d.worldview === "string" ? d.worldview.trim() : ""
    const majorArcana = typeof d.majorArcana === "string" ? d.majorArcana.trim() : ""
    const visualLanguage =
      (typeof d.visualLanguage === "string" && d.visualLanguage.trim()) || palette || description

    return {
      id,
      name,
      description,
      concept: concept || undefined,
      worldview: worldview || undefined,
      majorArcana: majorArcana || undefined,
      suitMapping: normalizeSuitMapping(d.suitMapping),
      palette: palette || undefined,
      visualLanguage,
      stylePhrase: normalizeStylePhrase(d.stylePhrase, visualLanguage, name),
      sampleCards: normalizeSampleCards(d.sampleCards, name),
    }
  })
}

/**
 * 单个风格规范方向（AgentTemplateDirection 载体）的归一化。
 * visualLanguage = 画面风格总述（80-100 字简洁表述——保证整体
 * 提示词 ≈ 280 字）；stylePhrase = 风格
 * 短语（风格的短文字锚点，当前仅存储留档）；过短时确定性补全而非判废
 * ——风格规范生成是流程咽喉，卡在这里会让用户停在「等待候选方向」无法推进。
 */
function normalizeStyleSpecDirection(
  d: Record<string, unknown>,
  name: string,
  index: number,
): AgentTemplateDirection {
  const palette = typeof d.palette === "string" ? d.palette.trim() : ""
  const concept = typeof d.concept === "string" ? d.concept.trim() : ""
  const description = (typeof d.description === "string" && d.description.trim()) || concept || name
  const worldview = typeof d.worldview === "string" ? d.worldview.trim() : ""
  const baseVisualLanguage = (typeof d.visualLanguage === "string" && d.visualLanguage.trim()) || ""

  const parts = [baseVisualLanguage || `${name}的画面风格`, palette, description, worldview]
    .map((part) => part.replace(/[。；;，,]$/, ""))
    .filter(Boolean)
  const visualLanguage =
    parts.join("，").length >= 60
      ? parts.join("，")
      : `${parts.join("，")}，整套 78 张画面保持统一：同一艺术媒介与笔触、明确的主辅色与光线特征、一致的质感与氛围，呈现同一系列作品的完整风格体系`

  let id = slugifyDirectionId(typeof d.id === "string" ? d.id : "")
  if (!id) id = slugifyDirectionId(name)
  if (!id) id = `style-spec-${index + 1}`

  return {
    id,
    name,
    description,
    concept: concept || undefined,
    worldview: worldview || undefined,
    majorArcana: typeof d.majorArcana === "string" && d.majorArcana.trim() ? d.majorArcana.trim() : undefined,
    suitMapping: normalizeSuitMapping(d.suitMapping),
    palette: palette || undefined,
    visualLanguage,
    stylePhrase: normalizeStylePhrase(d.stylePhrase, visualLanguage, name),
    sampleCards: normalizeSampleCards(d.sampleCards, name),
  }
}

/**
 * 校验并归一化 gen_style_spec 输出：恰好 3 个候选《风格规范书》方向、
 * 名称非空且互不重复（结构性问题抛 LlmValidationError 触发纠错重试）；
 * 画面风格总述过短走确定性补全而非拒绝（防流程卡死）。
 */
export function validateStyleDirections(raw: unknown): AgentTemplateDirection[] {
  const obj = asRecord(raw)
  const list = obj && Array.isArray(obj.directions) ? obj.directions : null
  if (!list) throw new LlmValidationError("输出缺少 directions 数组")
  if (list.length !== 3) {
    throw new LlmValidationError(`必须恰好 3 个风格规范方向，实际 ${list.length} 个`)
  }
  const seenNames = new Set<string>()
  return list.map((item, index) => {
    const d = asRecord(item)
    if (!d) throw new LlmValidationError(`第 ${index + 1} 个方向不是对象`)
    const name = typeof d.name === "string" ? d.name.trim() : ""
    if (!name) throw new LlmValidationError(`第 ${index + 1} 个方向缺少名称`)
    if (seenNames.has(name)) throw new LlmValidationError(`方向名重复：${name}`)
    seenNames.add(name)
    return normalizeStyleSpecDirection(d, name, index)
  })
}
