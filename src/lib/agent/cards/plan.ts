import { applyCardArtGuardrails, stripGuardrailMarker } from "@/lib/agent/prompt-guardrails"
import { TAROT_CARDS, type TarotCardSkeleton } from "@/lib/agent/templates"
import type { AgentTemplateDirection } from "@/lib/agent/graph"

export interface TarotCardPlanItem {
  index: number
  name: string
  meaning: string
  visualBrief: string
  prompt: string
}

export function buildTarotCardPrompt(input: {
  card: TarotCardSkeleton
  brief: string | null
  direction: AgentTemplateDirection | null
}): string {
  const direction = input.direction
  // 用户可控文本（brief）与可能回显它的 AI 产出先剥离护栏标记，防伪造 marker 关闭护栏
  const style = stripGuardrailMarker(direction?.visualLanguage || direction?.palette || "统一的塔罗牌视觉风格")
  const world = stripGuardrailMarker(direction?.worldview || input.brief || "围绕牌义展开的象征性世界观")
  return applyCardArtGuardrails(
    `${style}。${world}。${input.card.name}：${input.card.hint}。画面主体完整、象征清晰、适合后期人工排版。`
  )
}

export function buildTarotCardPlan(input: {
  brief: string | null
  direction: AgentTemplateDirection | null
  meanings?: Record<string, string>
  visualBriefs?: Record<string, string>
}): TarotCardPlanItem[] {
  return TAROT_CARDS.map((card) => {
    const meaning = input.meanings?.[card.name]?.trim() || `${card.name}的核心象征与成长课题`
    const visualBrief = input.visualBriefs?.[card.name]?.trim() || `${card.name}：以${card.hint}为画面意象，主体明确，构图完整。`
    return {
      index: card.index,
      name: card.name,
      meaning,
      visualBrief,
      prompt: buildTarotCardPrompt({ card, brief: input.brief, direction: input.direction }),
    }
  })
}

export function validateTarotCardPlan(items: readonly TarotCardPlanItem[]): TarotCardPlanItem[] {
  if (items.length !== 78) throw new Error(`塔罗卡牌清单必须为 78 张，当前 ${items.length} 张`)
  for (const [index, item] of items.entries()) {
    const expected = TAROT_CARDS[index]
    if (!expected || item.index !== index || item.name !== expected.name) {
      throw new Error(`第 ${index + 1} 张卡牌顺序或牌名不正确`)
    }
    if (!item.meaning.trim() || !item.visualBrief.trim() || !item.prompt.trim()) {
      throw new Error(`「${item.name}」缺少牌义、画面构想或提示词`)
    }
  }
  return [...items]
}
