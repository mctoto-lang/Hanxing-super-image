/**
 * Agent LLM JSON 输出的解析、截断修复与纠错提示（纯函数，零依赖）。
 *
 * 与 llm-errors.ts 同理独立成模块：llm.ts 的 import 链连着
 * db / task-queue / redis，解析纯函数与其单测不应触发这些副作用。
 *
 * parseJsonLoose 多级策略（逐级降级，任一级成功即返回）：
 *  1. 直接 JSON.parse；
 *  2. 按行剥离 markdown 围栏后再 parse；
 *  3. 引号感知的平衡括号扫描取完整对象（对 JSON 前后杂文免疫，
 *     杂文中的大括号会被跳过），含尾逗号清理；
 *  4. 截断轻量修复：max_tokens 截断（finish_reason=length）的输出
 *     缺失尾部符号——按扫描态补齐引号/括号、丢弃悬挂键名后重试。
 */

/** JSON 解析失败（可触发纠错重试）；reason 描述具体失败形态 */
export class LlmJsonParseError extends Error {
  constructor(
    public raw: string,
    public reason: string,
  ) {
    super(`LLM 输出无法解析为 JSON（${reason}）`)
    this.name = "LlmJsonParseError"
  }
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: Error }

function tryParse<T>(text: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * 去掉对象/数组元素的尾逗号（LLM 高频语法偏差，JSON 标准不允许）。
 * 仅在直接解析失败后作为修复手段使用，不用于已合法的 JSON。
 */
function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1")
}

/** 按行剥离 markdown 围栏（```json / ``` 标记行），不碰字符串值内的反引号 */
function stripCodeFences(text: string): string {
  const fenceLine = /^\s*```[a-zA-Z0-9_-]*\s*$/
  const lines = text.split(/\r?\n/)
  const kept = lines.filter((line) => !fenceLine.test(line))
  return kept.length === lines.length ? text.replace(/```[a-zA-Z0-9_-]*/g, "").trim() : kept.join("\n")
}

/**
 * 引号感知扫描：从 start（某个 "{"）起取首个平衡对象的原文切片；
 * 到文本结束仍未闭合（截断）返回 null。字符串内的大括号与转义引号
 * 不影响配平。
 */
function extractBalancedObject(text: string, start: number): string | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === "\\") {
      if (inStr) esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 修复容器的闭合符号：重扫 prefix 取未闭合括号栈，逆序补 "]" / "}" */
function closingForPrefix(prefix: string): string | null {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i]
    if (esc) {
      esc = false
      continue
    }
    if (ch === "\\") {
      if (inStr) esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === "{" || ch === "[") stack.push(ch)
    else if (ch === "}" || ch === "]") stack.pop()
  }
  // 停在字符串内：先补引号再补括号
  return (inStr ? '"' : "") + stack.reverse().map((c) => (c === "{" ? "}" : "]")).join("")
}

interface RepairFrame {
  kind: "{" | "["
  /** 容器内下一个期待：key=对象键名，colon=键名后待冒号，value=值，memberEnd=成员后待逗号或闭合 */
  expecting: "key" | "colon" | "value" | "memberEnd"
}

/** 裸字面量完整形态（数字 / true / false / null）；截断处若匹配则可保留 */
const BARE_LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/

/**
 * 截断修复：从 start 起单遍跟踪字符串态、容器栈与「最近完整成员」边界，
 * 构造截断点之前 + 补齐闭合符号的候选 JSON；非截断形态（已平衡）返回 null。
 *
 * 修复策略：值位置的半截字符串补引号保留内容；键名/键值对不完整时
 * 退回到最近一个完整成员边界；裸字面量完整时保留。
 */
function repairTruncatedJson(text: string, start: number): string | null {
  const frames: RepairFrame[] = []
  let inStr = false
  let esc = false
  /** 最近完整成员结束位置（含闭合括号/字符串，不含其后的逗号） */
  let safeEnd = start
  /** 值位置裸字面量起点；-1 = 不在字面量中 */
  let literalStart = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) {
        esc = false
        continue
      }
      if (ch === "\\") {
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = false
        const top = frames[frames.length - 1]
        if (top?.expecting === "value") {
          top.expecting = "memberEnd"
          safeEnd = i + 1
        } else if (top?.expecting === "key") {
          top.expecting = "colon"
        }
      }
      continue
    }
    if (ch === '"') {
      inStr = true
      literalStart = -1
      continue
    }
    if (ch === "{" || ch === "[") {
      frames.push({ kind: ch, expecting: ch === "{" ? "key" : "value" })
      literalStart = -1
      continue
    }
    if (ch === "}" || ch === "]") {
      if (frames.length === 0) return null
      frames.pop()
      const top = frames[frames.length - 1]
      if (top) top.expecting = "memberEnd"
      safeEnd = i + 1
      literalStart = -1
      continue
    }
    if (ch === ",") {
      const top = frames[frames.length - 1]
      if (top) top.expecting = top.kind === "{" ? "key" : "value"
      safeEnd = i
      literalStart = -1
      continue
    }
    if (ch === ":") {
      const top = frames[frames.length - 1]
      if (top?.expecting === "colon") top.expecting = "value"
      literalStart = -1
      continue
    }
    if (literalStart === -1) {
      const top = frames[frames.length - 1]
      if (top?.expecting === "value") literalStart = i
    }
  }
  if (frames.length === 0) return null

  let end: number
  if (inStr) {
    // 值位置的半截字符串：补引号即有效值，保留全部内容
    end = frames[frames.length - 1]!.expecting === "value" ? text.length : safeEnd
  } else if (literalStart >= 0) {
    end = BARE_LITERAL.test(text.slice(literalStart).trim()) ? text.length : safeEnd
  } else {
    end = safeEnd
  }
  if (end <= start) {
    // 连一个完整成员都没有：仅保留外层空对象骨架
    return text[start] === "{" ? "{}" : null
  }
  return text.slice(start, end) + closingForPrefix(text.slice(start, end))
}

function summarizeJsonError(err: Error): string {
  return err.message.split("\n")[0]!.slice(0, 80)
}

/**
 * 宽松 JSON 解析（Agent 全链路共用）。解析失败抛 LlmJsonParseError，
 * message 带具体原因（输出为空 / 未找到 JSON 对象 / 语法错误 / 疑似截断）。
 */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim()
  if (!trimmed) throw new LlmJsonParseError(text, "输出为空")

  const direct = tryParse<T>(trimmed)
  if (direct.ok) return direct.value

  const unfenced = stripCodeFences(trimmed)
  if (unfenced !== trimmed) {
    const r = tryParse<T>(unfenced.trim())
    if (r.ok) return r.value
  }

  // 逐个 "{" 尝试平衡扫描 + 截断修复（杂文中的大括号会被自然跳过）
  let syntaxError: Error | null = null
  let sawBrace = false
  for (let start = unfenced.indexOf("{"); start !== -1; start = unfenced.indexOf("{", start + 1)) {
    sawBrace = true
    const balanced = extractBalancedObject(unfenced, start)
    if (balanced !== null) {
      const r = tryParse<T>(balanced)
      if (r.ok) return r.value
      syntaxError = r.error
      const noCommas = stripTrailingCommas(balanced)
      if (noCommas !== balanced) {
        const r2 = tryParse<T>(noCommas)
        if (r2.ok) return r2.value
      }
      continue
    }
    const repaired = repairTruncatedJson(unfenced, start)
    if (repaired !== null) {
      const r = tryParse<T>(repaired)
      if (r.ok) return r.value
      const noCommas = stripTrailingCommas(repaired)
      const r2 = tryParse<T>(noCommas)
      if (r2.ok) return r2.value
    }
  }
  if (!sawBrace) throw new LlmJsonParseError(text, "未找到 JSON 对象")
  if (syntaxError) throw new LlmJsonParseError(text, `语法错误：${summarizeJsonError(syntaxError)}`)
  throw new LlmJsonParseError(text, "输出不完整（疑似被 max_tokens 截断）且无法自动补全")
}

/**
 * 组装纠错重试（nudge）：解析失败带原因与原文片段；字段校验失败带
 * 校验错误信息；截断（finish_reason=length）额外注入精简指令。
 */
export function buildJsonRetryNudge(
  reason: string,
  opts?: { rawSnippet?: string; truncated?: boolean },
): string {
  const parts = [reason]
  if (opts?.rawSnippet) parts.push(`原文片段：${opts.rawSnippet.slice(0, 120)}`)
  if (opts?.truncated) {
    parts.push("上次输出疑似达到 max_tokens 上限被截断，请大幅精简：只保留必需字段、压缩每项文本长度、不要输出任何分析或思考过程")
  }
  return parts.join("；")
}
