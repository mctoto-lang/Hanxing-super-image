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

/** 无 LLM 参与时的确定性兜底画面描述（design_drafts/design_prompts 失败批回退用） */
export function fallbackCardBody(card: { name: string; hint: string }): string {
  return `${card.name}：以${card.hint}为画面意象，明确单一的主体（人物/动物/物品），主体占画面大部分、近景构图、细节丰富、光影对比强烈，环境氛围衬托主体。`
}

/** 【新流程】确定性兜底终稿（design_finals 失败批回退用：风格总述 + 兜底画面描述） */
export function fallbackFinalPrompt(card: { name: string; hint: string }, styleSummary: string): string {
  return composeFinalPrompt(styleSummary, fallbackCardBody(card))
}

export function buildTarotCardPlan(input: {
  brief: string | null
  direction: AgentTemplateDirection | null
  meanings?: Record<string, string>
  visualBriefs?: Record<string, string>
}): TarotCardPlanItem[] {
  return TAROT_CARDS.map((card) => {
    const meaning = input.meanings?.[card.name]?.trim() || `${card.name}的核心象征与成长课题`
    const visualBrief = input.visualBriefs?.[card.name]?.trim() || fallbackCardBody(card)
    return {
      index: card.index,
      name: card.name,
      meaning,
      visualBrief,
      // 新流程拼装口径：初稿直通（无风格前缀、无负向约束）——若 design_drafts
      // 整体失败中断，这些兜底初稿直接流入生产也不会带旧式负向段
      prompt: composeDraftPrompt(visualBrief),
    }
  })
}

/** 【新流程】初稿确认门槛：78 张齐备且每张初稿 ≥ DRAFT_PROMPT_MIN_CHARS 字 */
export function validateTarotDraftPlan(items: readonly { index: number; name: string; visualBrief: string }[]): void {
  if (items.length !== 78) throw new Error(`塔罗卡牌清单必须为 78 张，当前 ${items.length} 张`)
  for (const [index, item] of items.entries()) {
    const expected = TAROT_CARDS[index]
    if (!expected || item.index !== index || item.name !== expected.name) {
      throw new Error(`第 ${index + 1} 张卡牌顺序或牌名不正确`)
    }
    if (item.visualBrief.trim().length < DRAFT_PROMPT_MIN_CHARS) {
      throw new Error(`「${item.name}」的初稿过短（至少 ${DRAFT_PROMPT_MIN_CHARS} 字，建议 40-80 字），请补充主体与场景描述`)
    }
  }
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
