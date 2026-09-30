/**
 * 卡面生图提示词护栏（纯函数，零运行时依赖）
 *
 * 供编排引擎/生图节点在把提示词送入生图 API 前统一加固，也可被 server
 * action 复用。两类护栏：
 *
 * 1. 负向约束追加（appendCardArtGuardrails）：卡面一律不画边框、文字、标题、
 *    罗马数字/数字编号、尺寸与比例标注——这些元素由后期制版承担（边框由
 *    transparent border overlay 合成，见 lib/agent/assets），模型画进画面即废卡；
 * 2. 尺寸措辞清洗（sanitizeDimensionWording）：文案 Agent 偶尔会把生图配置里的
 *    「1024x1024」「3:4」「aspect ratio」等参数措辞泄漏进提示词，清洗后避免
 *    模型把尺寸数字当画面元素画出（如把 "1:1" 画成匾额题字）。
 *
 * 追加为幂等设计（以 CARD_ART_GUARDRAIL_MARKER 为界）：重复应用不叠加，
 * 且清洗跳过已追加的护栏段（护栏文案本身含「尺寸/比例」等关键词）。
 */

/** 护栏段起始标记（幂等判定 + 清洗分段依据，不对外暴露到提示词语义之外） */
export const CARD_ART_GUARDRAIL_MARKER = "卡面负向约束"

/**
 * 卡面负向约束段（追加到提示词末尾的固定文案）。
 * 中英文并列：中文给中文系模型，英文关键词给 SD 系/加权解析器。
 */
export const CARD_ART_NEGATIVE_PROMPT =
  `${CARD_ART_GUARDRAIL_MARKER}：画面中不要出现任何边框或装饰框（no border / no frame）；` +
  `不要出现任何文字、标题、牌名或字母（no text / no title / no letters）；` +
  `不要出现罗马数字或数字编号（no Roman numerals / no numbers）；` +
  `不要出现尺寸、比例、分辨率等参数标注（no dimensions / no aspect ratio）。`

/** 负向约束要点（展示用：运行详情/审核提示里列出该卡已加固的约束项） */
export const CARD_ART_NEGATIVE_TAGS = [
  "无边框",
  "无文字",
  "无标题",
  "无罗马数字/数字编号",
  "无尺寸/比例标注",
] as const

/** 提示词是否已带卡面护栏（幂等追加与日志去重用） */
export function hasCardArtGuardrails(prompt: string): boolean {
  return prompt.includes(CARD_ART_GUARDRAIL_MARKER)
}

/**
 * 剥离用户可控文本中伪造的护栏标记：正文一旦包含 marker，会让幂等追加
 * 误判「已加固」而跳过负向约束，并让尺寸清洗把 marker 之后的整段豁免。
 * 用户可控段（visualBrief / brief / meaning 等）拼进提示词前先过这里。
 */
export function stripGuardrailMarker(text: string): string {
  return text.includes(CARD_ART_GUARDRAIL_MARKER)
    ? text.split(CARD_ART_GUARDRAIL_MARKER).join("〔已移除护栏标记〕")
    : text
}

/**
 * 追加卡面负向约束（幂等：已带护栏的提示词原样返回）。
 * 空提示词返回空串（由调用方在上游判空）。
 */
export function appendCardArtGuardrails(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed) return ""
  if (hasCardArtGuardrails(trimmed)) return trimmed
  return `${trimmed}\n${CARD_ART_NEGATIVE_PROMPT}`
}

/* ─── 尺寸/比例措辞清洗 ─────────────────────────────────────────────── */

/** 尺寸/比例关键词（「尺寸」「比例」语义太泛，只删「关键词+参数值」组合与无歧义词） */
const DIM_KEYWORD = String.raw`(?:aspect\s*ratio|宽高比|纵横比|高宽比|分辨率|resolution|尺寸|比例)`
/** 参数值形态：WxH / W:H / Wpx / W像素 */
const DIM_VALUE =
  String.raw`\d{1,5}(?:\.\d+)?\s*` +
  String.raw`(?:[:：x×*]\s*\d{1,5}(?:\.\d+)?|px|pixels?|像素)`

/**
 * 清洗策略（按序应用）：
 * 1. 关键词引导：「尺寸 1024x1024」「比例：2:3」「aspect ratio 3:4」「resolution 1024px」；
 * 2. 值引导倒装：「1024x1024 的尺寸」「3:4 的比例」；
 * 3. 孤立参数值：1024x1024 / 3:4 / 16：9 / 1024px（各边 ≥2 位才视作尺寸，
 *    避免误伤「4x4 网格」这类单数字组）；
 * 4. 无歧义裸关键词：aspect ratio / resolution / 宽高比 / 纵横比 / 分辨率。
 * 注意：「尺寸」「比例」不单独删——中文画面描述里「人物比例夸张」是合法措辞。
 */
const DIMENSION_PATTERNS: RegExp[] = [
  new RegExp(`${DIM_KEYWORD}\\s*[:：=＝]?\\s*(?:为|是|约)?\\s*${DIM_VALUE}`, "gi"),
  new RegExp(`${DIM_VALUE}\\s*的?\\s*${DIM_KEYWORD}`, "gi"),
  /\b\d{2,5}\s*[x×*]\s*\d{2,5}\b/gi,
  /\b\d{1,5}\s*(?:px|pixels?|像素)\b/gi,
  /\b\d{1,4}\s*[:：]\s*\d{1,4}\b/g,
  /\b(?:aspect\s*ratio|resolution)\b/gi,
  /(?:宽高比|纵横比|高宽比|分辨率)/g,
]

/** 删除残留的悬挂连接符与多余空白（清洗后的「， 」「（）」等） */
function cleanupAfterStrip(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。、；：,.:;!?！？])/g, "$1")
    .replace(/([，、；,;])\s*(?=[，、；,;])/g, "")
    .replace(/([（(])\s*([）)])/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/**
 * 从提示词中清洗尺寸/宽高比措辞（best-effort 正则清洗，不做语义改写）。
 *
 * 已带护栏的提示词：护栏段（marker 起至结尾）本身含「尺寸/比例」等关键词，
 * 原样保留不参与清洗，只清洗 marker 之前的正文。
 */
export function sanitizeDimensionWording(prompt: string): string {
  if (!prompt) return ""
  const markerIdx = prompt.indexOf(CARD_ART_GUARDRAIL_MARKER)
  const head = markerIdx >= 0 ? prompt.slice(0, markerIdx) : prompt
  const tail = markerIdx >= 0 ? prompt.slice(markerIdx) : ""

  let cleaned = head
  for (const pattern of DIMENSION_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ")
  }
  cleaned = cleanupAfterStrip(cleaned)

  if (!tail) return cleaned
  // 护栏段原样拼回（正文非空时以换行衔接，与 append 的格式一致）
  return cleaned ? `${cleaned}\n${tail}` : tail
}

/**
 * 一站式加固：先清洗尺寸措辞，再幂等追加负向约束。
 * 生图前的最后一个提示词加工步骤（打回改写产出的新 prompt 同样适用）。
 */
export function applyCardArtGuardrails(prompt: string): string {
  return appendCardArtGuardrails(sanitizeDimensionWording(prompt))
}
