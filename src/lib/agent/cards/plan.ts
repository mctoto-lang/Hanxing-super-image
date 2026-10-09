import { stripGuardrailMarker } from "@/lib/agent/prompt-guardrails"
import { TAROT_CARDS } from "@/lib/agent/templates"
import type { AgentTemplateDirection } from "@/lib/agent/graph"

export interface TarotCardPlanItem {
  index: number
  name: string
  meaning: string
  visualBrief: string
  prompt: string
}

/** 【新流程】初稿直通：初稿即提示词正文（中文、无负向约束，不拼接任何前缀） */
export function composeDraftPrompt(body: string): string {
  return stripGuardrailMarker(body).trim()
}

/** 终稿两段结构的段标记 */
export const FINAL_PROMPT_STYLE_LABEL = "[1] 画面风格"
export const FINAL_PROMPT_CONTENT_LABEL = "[2] 画面内容"

/** 【新流程】终稿拼装：[1] 画面风格（整套统一）+ [2] 画面内容（逐张细化） */
export function composeFinalPrompt(styleSummary: string, content: string): string {
  const style = stripGuardrailMarker(styleSummary).trim()
  const body = stripGuardrailMarker(content).trim()
  return `${FINAL_PROMPT_STYLE_LABEL}：${style}\n${FINAL_PROMPT_CONTENT_LABEL}：${body}`
}

/** 解析终稿两段结构；非结构化文本返回 null（存量 run 旧提示词等场景） */
export function splitFinalPromptSegments(prompt: string): { style: string; content: string } | null {
  const text = prompt.trim()
  const styleIdx = text.indexOf(FINAL_PROMPT_STYLE_LABEL)
  const contentIdx = text.indexOf(FINAL_PROMPT_CONTENT_LABEL)
  if (styleIdx < 0 || contentIdx < 0 || contentIdx < styleIdx) return null
  const style = text.slice(styleIdx + FINAL_PROMPT_STYLE_LABEL.length, contentIdx).replace(/^[：:\s]+/, "").trim()
  const content = text.slice(contentIdx + FINAL_PROMPT_CONTENT_LABEL.length).replace(/^[：:\s]+/, "").trim()
  if (!style || !content) return null
  return { style, content }
}

/**
 * 归一化 LLM 产出的终稿：已含两段标记则原样（截去标记前杂文），
 * 否则包一层两段结构（LLM 偶发漏标记时的兜底，保证落库结构一致）。
 */
export function normalizeFinalPrompt(raw: string, styleSummary: string): string {
  const segments = splitFinalPromptSegments(raw)
  if (segments) {
    const styleIdx = raw.indexOf(FINAL_PROMPT_STYLE_LABEL)
    return raw.slice(styleIdx).trim()
  }
  return composeFinalPrompt(styleSummary, raw)
}

/** 判断 currentPrompt 是否已是结构化终稿（两段标记齐备） */
export function isStructuredFinalPrompt(prompt: string | null | undefined): boolean {
  return !!prompt && splitFinalPromptSegments(prompt) !== null
}

/** 【新流程】初稿最小字数（简洁明了 40-80 字，过短生图效果差） */
export const DRAFT_PROMPT_MIN_CHARS = 20

/** 【新流程】终稿[画面内容]段最小字数（细化目标 150-250 字） */
export const FINAL_CONTENT_MIN_CHARS = 60

// ---------------------------------------------------------------------------
// 单段短提示词（四阶段流程：画面内容 + 固定风格提示词系统拼接）
// ---------------------------------------------------------------------------

/** 单段提示词最小字数（确认门槛下限；整体 ≈ 内容 120 字 + 固定风格 ≈ 100 字 + 结尾句 ≈ 220 字） */
export const SINGLE_PROMPT_MIN_CHARS = 60

/** 画面内容撰写目标（「120 字左右」；不含系统拼接的固定风格提示词与无边框句——整体提示词控制在 220 字左右） */
export const CONTENT_TARGET = { min: 100, max: 140 } as const

/** 画面内容 AI 撰写闸门（低于此值判不合格，标记失败待重试） */
export const CONTENT_MIN_CHARS = 80

/** 无边框硬规则结尾句（系统统一拼接的唯一禁止性表述） */
export const SINGLE_PROMPT_BORDER_SUFFIX = "画面边缘干净，无任何边框或边缘装饰"

/**
 * 【四阶段流程】提示词拼装（确定性，不经 LLM）：画面内容 + 固定风格提示词
 * （整套逐字一致，用于固定画面风格）+ 无边框句。风格由系统拼接而非让 LLM
 * 逐张抄写，杜绝整套 78 张的风格漂移。
 */
export function composeStyleFixedPrompt(content: string, stylePrompt: string): string {
  const body = stripGuardrailMarker(content).trim().replace(/[。]+$/, "")
  const style = stripGuardrailMarker(stylePrompt).trim().replace(/[。；;，,]+$/, "")
  return `${body}，${style}。${SINGLE_PROMPT_BORDER_SUFFIX}`
}

/**
 * 【四阶段流程】单卡提示词就绪判据（进度条/确认门槛的统一口径）：
 * promptSource="initial"（待写/生成中/失败——建清单即为此态，撰写失败保留
 * 此态并落 errorMessage）不算就绪；其余来源（final=AI 终稿、manual=用户
 * 编辑、ai/auto_revise=生产期改写）文本达标即就绪。存量结构化两段终稿
 * （final 归并的 run）按两段结构判定。
 */
export function isPromptItemReady(item: {
  promptSource?: string | null
  currentPrompt?: string | null
}): boolean {
  if (item.promptSource === "initial") return false
  const text = (item.currentPrompt ?? "").trim()
  return isStructuredFinalPrompt(text) || text.length >= SINGLE_PROMPT_MIN_CHARS
}

/**
 * 【四阶段流程】提示词确认门槛：78 张齐备、顺序牌名精确、每张提示词达标。
 * 兼容三种形态：拼接式单段提示词（新流程，≥60 字）、结构化两段终稿（存量，
 * [画面内容] ≥60 字）、旧式自由文本（存量过渡，同 ≥60 字）。
 */
export function validateTarotPromptPlan(
  items: readonly { index: number; name: string; prompt: string }[],
): void {
  if (items.length !== 78) throw new Error(`塔罗卡牌清单必须为 78 张，当前 ${items.length} 张`)
  for (const [index, item] of items.entries()) {
    const expected = TAROT_CARDS[index]
    if (!expected || item.index !== index || item.name !== expected.name) {
      throw new Error(`第 ${index + 1} 张卡牌顺序或牌名不正确`)
    }
    const prompt = item.prompt.trim()
    const segments = splitFinalPromptSegments(prompt)
    if (segments) {
      if (segments.content.length < FINAL_CONTENT_MIN_CHARS) {
        throw new Error(`「${item.name}」的提示词过短，请先完成撰写（可用「重新生成此张」）`)
      }
    } else if (prompt.length < SINGLE_PROMPT_MIN_CHARS) {
      throw new Error(
        `「${item.name}」的提示词过短（画面内容建议 ${CONTENT_TARGET.min}-${CONTENT_TARGET.max} 字，固定风格提示词由系统拼接）`,
      )
    }
  }
}

export function buildTarotCardPlan(input: {
  brief: string | null
  direction: AgentTemplateDirection | null
  meanings?: Record<string, string>
  visualBriefs?: Record<string, string>
}): TarotCardPlanItem[] {
  return TAROT_CARDS.map((card) => {
    const meaning = input.meanings?.[card.name]?.trim() || `${card.name}的核心象征与成长课题`
    // 画面提示词不预填任何兜底：必须由 AI 撰写（promptSource="initial"、
    // 正文为空 = 待写），失败以 errorMessage 留痕供一键重试
    const visualBrief = input.visualBriefs?.[card.name]?.trim() ?? ""
    return {
      index: card.index,
      name: card.name,
      meaning,
      visualBrief,
      prompt: composeDraftPrompt(visualBrief),
    }
  })
}

/**
 * 【新流程】终稿确认门槛：78 张齐备且提示词非空。结构化两段为佳
 * （[画面内容] ≥ FINAL_CONTENT_MIN_CHARS 字）；存量 run 的旧式提示词
 * （无两段标记）只要长度达标即放行，不阻断过渡期项目。
 */
export function validateTarotFinalPlan(
  items: readonly { index: number; name: string; prompt: string }[],
): void {
  if (items.length !== 78) throw new Error(`塔罗卡牌清单必须为 78 张，当前 ${items.length} 张`)
  for (const [index, item] of items.entries()) {
    const expected = TAROT_CARDS[index]
    if (!expected || item.index !== index || item.name !== expected.name) {
      throw new Error(`第 ${index + 1} 张卡牌顺序或牌名不正确`)
    }
    const segments = splitFinalPromptSegments(item.prompt)
    if (segments) {
      // 结构化终稿：确认门槛与 AI 撰写门槛一致（60 字），兜底/截断稿不放行
      if (segments.content.length < FINAL_CONTENT_MIN_CHARS) {
        throw new Error(`「${item.name}」的终稿过短，请先完成细化（可用「重新细化此张」）`)
      }
    } else if (item.prompt.trim().length < DRAFT_PROMPT_MIN_CHARS) {
      // 存量旧式提示词（无两段结构）：维持宽松下限，不阻断过渡期项目
      throw new Error(`「${item.name}」的终稿过短，请先完成细化（可用「重新细化此张」）`)
    }
  }
}
