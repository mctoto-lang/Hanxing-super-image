import { TAROT_ASSET_RULES, type TarotAssetRule } from "@/lib/agent/templates"
import { applyCardArtGuardrails, sanitizeDimensionWording } from "@/lib/agent/prompt-guardrails"
import type { AgentAssetKind } from "@/lib/agent/assets"

const KIND_MAP: Record<AgentAssetKind, TarotAssetRule["deliverableKind"]> = {
  border: "card_border",
  back: "back",
  box_front: "box_front",
  box_back: "box_back",
  box_side: "box_side",
  box_top: "box_top",
}

export function buildTarotAssetPrompt(input: { kind: AgentAssetKind; styleDoc?: string | null; direction?: string | null; frontImageUrl?: string | null }): string {
  const rule = TAROT_ASSET_RULES.find((item) => item.deliverableKind === KIND_MAP[input.kind])
  if (!rule) throw new Error(`未找到资产提示词规则：${input.kind}`)
  const style = input.styleDoc?.trim() || input.direction?.trim() || "与整套塔罗卡面统一的神秘、精致视觉风格"
  const reference = input.frontImageUrl ? "以提供的牌盒正面参考图保持纹样、材质和色调一致。" : ""
  const prompt = `${rule.promptTemplate.replace("{style}", style)}\n${rule.rules.join("\n")}\n${reference}\n${rule.negativePrompt}`
  // 非边框资产复用统一清洗（自造正则会漏删/误删且与护栏口径不一致）
  return input.kind === "border" ? applyCardArtGuardrails(prompt) : sanitizeDimensionWording(prompt)
}

export function assetGenerationOrder(): AgentAssetKind[] {
  return ["border", "back", "box_front", "box_back", "box_side", "box_top"]
}
