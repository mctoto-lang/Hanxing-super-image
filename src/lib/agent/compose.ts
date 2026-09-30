import { applyCardArtGuardrails, stripGuardrailMarker } from "@/lib/agent/prompt-guardrails"

export function buildAiFramePrompt(input: { cardName?: string | null; meaning?: string | null }): string {
  // 卡名/牌义为用户可编辑文本，先剥离护栏标记防伪造
  const cardNote = input.cardName ? `这是「${stripGuardrailMarker(input.cardName)}」卡面。` : ""
  const meaningNote = input.meaning ? `画面含义：${stripGuardrailMarker(input.meaning)}` : ""
  return applyCardArtGuardrails(
    `将参考图 2 的无框卡面完整融合到参考图 1 的透明卡牌边框镂空区域。保持参考图 1 的边框纹样、颜色、位置、透明区域和装饰细节不变，不重新绘制或增加边框。卡面主体保持完整并与边框自然对齐。${cardNote}${meaningNote}只输出融合后的完整卡面图。`
  )
}

export const AI_FRAME_PREVIEW_COUNT = 3
