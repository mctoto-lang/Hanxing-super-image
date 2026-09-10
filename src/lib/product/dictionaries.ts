/**
 * 商品主图 V2 字典（平台 / 语言 / 复刻程度）
 *
 * 代码内置常量：变更频率低且需要随代码审查；方向池与尺寸规范才是
 * 超管运营数据（DB 配置）。
 */

/** 子功能模式（四个 tab + templateInfo.mode） */
export const PRODUCT_MODES = ["suite", "detail", "replicate", "refine"] as const
export type ProductMode = (typeof PRODUCT_MODES)[number]

export const PRODUCT_MODE_LABELS: Record<ProductMode, string> = {
  suite: "商品套图",
  detail: "A+详情页",
  replicate: "爆款复刻",
  refine: "产品精修",
}

/**
 * 产品精修快捷优化项固定集（数组顺序即展示顺序，与种子脚本一致）。
 *
 * 固定项不可新增/停用/改名/改排序，仅可修改各项使用的提示词模板
 * （platform-product 守卫 + product-v2 数据过滤三处共用本常量）。
 */
export const REFINE_FIXED_KEYS = [
  "enhance_gloss",
  "repair_scratches",
  "enhance_clarity",
  "color_correction",
  "fix_perspective",
] as const

/** 上架平台（promptSegment 注入规则见各字段注释） */
export interface PlatformDef {
  value: string
  label: string
  /** 注入「首屏主视觉」类方向（hero_visual）的平台主图规范 */
  heroPromptSegment?: string
  /** 注入所有方向的通用平台偏好（可空） */
  generalPromptSegment?: string
}

export const PLATFORMS: PlatformDef[] = [
  {
    value: "amazon",
    label: "亚马逊",
    heroPromptSegment:
      "Amazon main image rules: pure white background (#FFFFFF), no logos, watermarks or extra props, product fills 85%+ of the frame. ",
    generalPromptSegment:
      "Follow Amazon A+ content visual guidelines: clean and informative layout, readable typography, consistent brand colors, minimal decorative clutter, no pricing or promotional text in the imagery. ",
  },
  {
    value: "temu",
    label: "Temu",
    heroPromptSegment:
      "Temu main image rules: clean bright background, product clearly lit and dominant in frame, no watermarks, borders or overlaid promotional text. ",
    generalPromptSegment:
      "Follow Temu listing style: vivid colors, strong price-value feel, attention-grabbing but tidy composition, bright even lighting, clear information hierarchy. ",
  },
  {
    value: "shein",
    label: "SHEIN",
    heroPromptSegment:
      "SHEIN main image rules: clean bright background, product sharply lit and dominant in frame, no watermarks or graphic clutter. ",
    generalPromptSegment:
      "Follow SHEIN listing style: trendy, youthful, fashion-forward visual mood, soft editorial lighting, cohesive on-trend palette. ",
  },
  {
    value: "tiktok_shop",
    label: "TikTok Shop",
    heroPromptSegment:
      "TikTok Shop main image rules: clean background, product dominant and clearly lit, no watermarks, borders or misleading overlays. ",
    generalPromptSegment:
      "Follow TikTok Shop style: dynamic, social-media-native, bold and engaging composition with a clear high-contrast focal point. ",
  },
]

export function getPlatformDef(value: string): PlatformDef | null {
  return PLATFORMS.find((p) => p.value === value) ?? null
}

/** 语言（生图 prompt 的图内文字语言指令 + AI 帮写输出语言） */
export interface LanguageDef {
  value: string
  label: string
  /** AI 帮写输出语言名（喂给对话模型） */
  outputName: string
  /** 生图图内文字指令 */
  imageDirective: string
}

export const LANGUAGES: LanguageDef[] = [
  {
    value: "en",
    label: "English",
    outputName: "English",
    imageDirective: "All text overlay in the image must be in English. ",
  },
  {
    value: "zh",
    label: "中文",
    outputName: "Simplified Chinese",
    imageDirective: "All text overlay in the image must be in Simplified Chinese. ",
  },
  {
    value: "ja",
    label: "日本語",
    outputName: "Japanese",
    imageDirective: "All text overlay in the image must be in Japanese. ",
  },
  {
    value: "de",
    label: "Deutsch",
    outputName: "German",
    imageDirective: "All text overlay in the image must be in German. ",
  },
  {
    value: "es",
    label: "Español",
    outputName: "Spanish",
    imageDirective: "All text overlay in the image must be in Spanish. ",
  },
]

export function getLanguageDef(value: string): LanguageDef | null {
  return LANGUAGES.find((l) => l.value === value) ?? null
}

/**
 * 套图结构配置（仅套图 tab 的 ⑤ 区块）
 *
 * 两种模式二选一：智能匹配（AI 规划）/ 自定义配置。
 * 自定义配置直接列出套图方向池（超管在「图片方向-商品套图」配置的选项），
 * 「其他」行由 AI 从未手动选中的方向中补充；提交均走 directions: [{key, count}]。
 */
export interface SuiteStructureModeDef {
  value: "smart" | "custom"
  label: string
  description: string
}

export const SUITE_STRUCTURE_MODES: SuiteStructureModeDef[] = [
  {
    value: "smart",
    label: "智能匹配",
    description: "AI 智能分析商品图，匹配最佳 Listing 套图",
  },
  {
    value: "custom",
    label: "自定义配置",
    description: "自由勾选方向与张数，可用「其他」AI 补充，至少一张",
  },
]

/** 自定义配置的「其他」行（从未手动选中的方向中 AI 智能匹配填充） */
export interface SuiteOtherCategoryDef {
  key: "other"
  label: string
  description: string
  /** 张数上限 */
  maxCount: number
}

export const SUITE_OTHER_CATEGORY: SuiteOtherCategoryDef = {
  key: "other",
  label: "其他",
  description: "对比图、多角度、尺寸图等，由 AI 从未选方向中智能补充",
  maxCount: 6,
}

/** 复刻程度（爆款复刻 tab 的二选一） */
export interface ReplicateLevelDef {
  value: "style" | "strict"
  label: string
  description: string
  promptSegment: string
}

export const REPLICATE_LEVELS: ReplicateLevelDef[] = [
  {
    value: "style",
    label: "参考风格",
    description: "借鉴参考图的风格与氛围，构图自由发挥",
    promptSegment:
      "Match the visual style, mood and color palette of the style reference image, while composing an original layout featuring the provided product. ",
  },
  {
    value: "strict",
    label: "高度复刻",
    description: "尽量还原参考图的构图、版式与文字布局",
    promptSegment:
      "Closely replicate the composition, layout, text placement and overall design of the style reference image, substituting the product with the provided one. ",
  },
]

export function getReplicateLevelDef(
  value: string,
): ReplicateLevelDef | null {
  return REPLICATE_LEVELS.find((r) => r.value === value) ?? null
}
