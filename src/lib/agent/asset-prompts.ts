import { TAROT_ASSET_RULES, type TarotAssetRule } from "@/lib/agent/templates"
import { sanitizeDimensionWording } from "@/lib/agent/prompt-guardrails"
import type { AgentAssetKind } from "@/lib/agent/assets"

const KIND_MAP: Record<AgentAssetKind, TarotAssetRule["deliverableKind"]> = {
  border: "card_border",
  back: "back",
  box_front: "box_front",
  box_back: "box_back",
  box_side: "box_side",
  box_top: "box_top",
}

/** 与套件资产直接相关的风格规范书节（跳过卡面专用的花色映射/大阿卡纳与长篇创作简报） */
const STYLE_SECTION_RE = /^【(?:内容方向|世界观|视觉语言|色调)】/

/**
 * 卡面尺寸 → 构图措辞（提示词模板 {orientation} 占位符的取值）。
 * 宽高差 ≤10% 视作方形；非法尺寸串兜底方形（与默认 1024x1024 一致）。
 * 套件资产与 AI 融合一律延用卡面比例，构图措辞必须与实际出图比例一致，
 * 否则「竖版构图」+ 方形出图会让模型自行留白变形。
 */
export function orientationOfCardSize(size?: string | null): "竖版" | "横版" | "方形" {
  const match = /^(\d+)x(\d+)$/i.exec((size ?? "").trim())
  if (!match) return "方形"
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return "方形"
  if (height > width * 1.1) return "竖版"
  if (width > height * 1.1) return "横版"
  return "方形"
}

/** 风格要点注入长度上限：专门描述为主体，风格只作要点，不喧宾夺主 */
const STYLE_ESSENCE_MAX_LENGTH = 300

/**
 * 从《风格规范书》提炼资产生图专用的「风格要点」。
 *
 * 资产提示词是专门撰写的内容描述：风格只注入按节提炼的要点
 * （内容方向/世界观/视觉语言/色调），不整段搬策划方案文本。
 */
export function extractStyleEssence(
  styleDoc?: string | null,
  direction?: string | null,
): string {
  const doc = styleDoc?.trim()
  if (doc) {
    const lines = doc
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => STYLE_SECTION_RE.test(line))
    if (lines.length > 0) return lines.join("；").slice(0, STYLE_ESSENCE_MAX_LENGTH)
    // 无节结构（脏值/直传视觉语言文本）：截断后作为要点使用
    return doc.slice(0, 200)
  }
  return direction?.trim().slice(0, 200) || "与整套塔罗卡面统一的神秘、精致视觉风格"
}

export function buildTarotAssetPrompt(input: {
  kind: AgentAssetKind
  styleDoc?: string | null
  direction?: string | null
  frontImageUrl?: string | null
  /** 卡面出图尺寸（"WxH"；构图措辞 {orientation} 按此生成，缺省方形） */
  cardSize?: string | null
}): string {
  const rule = TAROT_ASSET_RULES.find((item) => item.deliverableKind === KIND_MAP[input.kind])
  if (!rule) throw new Error(`未找到资产提示词规则：${input.kind}`)
  const essence = extractStyleEssence(input.styleDoc, input.direction)
  const reference = input.frontImageUrl ? "以提供的牌盒正面参考图保持纹样、材质和色调一致。" : ""
  // 构图措辞与卡面比例一致（占位符写在模板与规则里，运行时按实际尺寸填充）
  const orientation = orientationOfCardSize(input.cardSize)
  const fill = (text: string): string => text.replaceAll("{orientation}", orientation)
  const prompt = [
    fill(rule.promptTemplate.replace("{style}", essence)),
    ...rule.rules.map((line, index) => `${index + 1}. ${fill(line)}`),
    reference,
    rule.negativePrompt ? `画面中避免出现：文字、字母、数字、水印、签名等任何可读符号。` : "",
  ]
    .filter((part) => part !== "")
    .join("\n")
  // 统一清洗尺寸措辞（各资产负向约束已改为中文转述句式，不复用卡面护栏——
  // 卡面护栏的 no border/no frame 禁令与边框资产的生成目标直接冲突）
  return sanitizeDimensionWording(prompt)
}

export function assetGenerationOrder(): AgentAssetKind[] {
  return ["border", "back", "box_front", "box_back", "box_side", "box_top"]
}

/** 取某项资产的硬性规则原文（AI 评审资产的打分依据） */
export function assetRuleOfKind(kind: AgentAssetKind): TarotAssetRule {
  const rule = TAROT_ASSET_RULES.find((item) => item.deliverableKind === KIND_MAP[kind])
  if (!rule) throw new Error(`未找到资产规则：${kind}`)
  return rule
}
