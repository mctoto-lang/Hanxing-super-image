/**
 * 流水线定义（塔罗模板生产流程；经典全流程已下线）
 *
 * 用户不可编辑流程：模板阶段推进 + 确认清单后按 buildTemplateProductionGraph
 * 生成的固定图执行；管理员仅可配置各角色模型与阈值（agent_direction_config）。
 *
 * 团队编制（模板生产图）：
 *   文案（逐张，按打回反馈改写）/ 生图（逐张，透传参考图）
 *   评审团（内容 / 审美 / 一致性，一致性对照规范书与基准图）
 *   总控：纯规则裁决（打回上限 / 耗尽选历史最优）
 */
import type {
  AgentGraph,
  AgentThinkingLevel,
  AgentDirection,
} from "./graph"

// ---------------------------------------------------------------------------
// 方向配置（agent_direction_config 落库形状；管理员可改，其余固定）
// ---------------------------------------------------------------------------

export interface DirectionModelConfig {
  styleChatModelId: string | null
  structureChatModelId: string | null
  copywriterChatModelId: string | null
  copywriterThinkingLevel: AgentThinkingLevel
  imageModelId: string | null
  imageSize: string
  contentReviewModelId: string | null
  aestheticReviewModelId: string | null
  consistencyReviewModelId: string | null
}

export interface DirectionThresholds {
  /** 审美及格线 0-100 */
  aestheticThreshold: number
  /** 一致性及格线 0-100（与基准比对的相似度下限） */
  consistencyThreshold: number
}

export interface DirectionConfig {
  direction: AgentDirection
  enabled: boolean
  /** 两阶段模式：先出小样等用户确认风格，再跑全套 */
  sampleEnabled: boolean
  sampleCount: number
  maxRetries: number
  thresholds: DirectionThresholds
  models: DirectionModelConfig
  /** 塔罗模板专属配置；其他方向为空 */
  templateConfig?: TarotTemplateConfig
}

export const DEFAULT_DIRECTION_CONFIGS: DirectionConfig[] = (
  ["tarot", "oracle", "poker"] as AgentDirection[]
).map((direction) => ({
  direction,
  enabled: true,
  sampleEnabled: true,
  sampleCount: 6,
  maxRetries: 2,
  thresholds: { aestheticThreshold: 75, consistencyThreshold: 70 },
  models: {
    styleChatModelId: null,
    structureChatModelId: null,
    copywriterChatModelId: null,
    copywriterThinkingLevel: "medium",
    imageModelId: null,
    imageSize: "1024x1024",
    contentReviewModelId: null,
    aestheticReviewModelId: null,
    consistencyReviewModelId: null,
  },
}))

// ---------------------------------------------------------------------------
// 塔罗模板配置（agent_direction_config.templateConfig jsonb 落库形状）
// ---------------------------------------------------------------------------

/** 塔罗模板资产尺寸键：卡面 + 固定资产 kinds（与 graph.AGENT_ASSET_KINDS 对齐） */
export const TEMPLATE_ASSET_SIZE_KEYS = [
  "card",
  "border",
  "back",
  "box_front",
  "box_back",
  "box_side",
  "box_top",
] as const

export type TemplateAssetSizeKey = (typeof TEMPLATE_ASSET_SIZE_KEYS)[number]

/** 固定资产部分（除卡面外的全部资产，对应 graph.AgentAssetKind） */
export type TemplateAssetKindKey = Exclude<TemplateAssetSizeKey, "card">

export type TemplateAssetSizes = Record<TemplateAssetSizeKey, string>

/** 塔罗模板评审阈值（0-100；及格线下限 40、上限 95，见 server/schemas/agent） */
export interface TemplateReviewThresholds {
  /** 内容对齐（画面是否呈现牌名/牌义） */
  content: number
  /** 审美评分 */
  aesthetic: number
  /** 成套一致性（与风格基准/规范书比对） */
  consistency: number
}

/**
 * 塔罗模板配置（方向配置向模板化迁移的扩展形状；经典三审槽位等
 * 旧字段保留兼容——模板流程评审团改由 reviewerModelIds 承载）。
 */
export interface TarotTemplateConfig {
  /** 模板 key（当前仅 tarot；新增方向时扩展联合） */
  template: "tarot"
  /** 文案改写模型（打回时改写提示词；null = 回退经典 models.copywriterChatModelId） */
  copywriterChatModelId: string | null
  /** 评审团：1-3 个支持视觉的对话模型 id（每个评审 AI 三维同审） */
  reviewerModelIds: string[]
  /** 资产尺寸（"宽x高"；值应取自对应生图模型的尺寸预设） */
  assetSizes: TemplateAssetSizes
  reviewThresholds: TemplateReviewThresholds
  /** 打回上限（逐卡计数） */
  maxRetries: number
  /** 小样张数（两阶段模式先跑这些卡确认风格） */
  sampleCount: number
  /** 单次运行内并行流水线数（1-4） */
  concurrency: number
  /** 澄清阶段最大追问轮数（1-8；超限强制收敛出简报） */
  clarifyMaxRounds: number
  /** 卡框模式（默认 local：使用内置边框合成） */
  frameMode: "ai"
  /** AI 卡框生成模型（frameMode = "ai" 时必填；model 表生图模型 id） */
  aiFrameModelId: string | null
  /** 套件资产生图模型（边框/卡背/牌盒四面；model 表 id） */
  assetImageModelId: string | null
  /** 卡面生图模型（model 表 id；null = 回退经典 imageModelId） */
  cardImageModelId: string | null
}

/** 方向模板配置：tarot 有模板配置，其余方向暂无（null = 经典流程） */
export type DirectionTemplateConfig = TarotTemplateConfig | null

/** 塔罗模板内置默认值（行不存在 / templateConfig 为空时的兜底） */
export const DEFAULT_TAROT_TEMPLATE_CONFIG: TarotTemplateConfig = {
  template: "tarot",
  copywriterChatModelId: null,
  reviewerModelIds: [],
  assetSizes: {
    card: "1024x1024",
    border: "1024x1024",
    back: "1024x1024",
    box_front: "1024x1024",
    box_back: "1024x1024",
    box_side: "1024x1024",
    box_top: "1024x1024",
  },
  reviewThresholds: { content: 75, aesthetic: 75, consistency: 70 },
  maxRetries: 2,
  sampleCount: 6,
  concurrency: 2,
  clarifyMaxRounds: 4,
  frameMode: "ai",
  aiFrameModelId: null,
  assetImageModelId: null,
  cardImageModelId: null,
}

/** 按方向取模板配置默认值（tarot 给默认模板，其余方向 null） */
export function defaultTemplateConfigFor(direction: AgentDirection): DirectionTemplateConfig {
  if (direction !== "tarot") return null
  return {
    ...DEFAULT_TAROT_TEMPLATE_CONFIG,
    reviewerModelIds: [],
    assetSizes: { ...DEFAULT_TAROT_TEMPLATE_CONFIG.assetSizes },
    reviewThresholds: { ...DEFAULT_TAROT_TEMPLATE_CONFIG.reviewThresholds },
  }
}

// ---------------------------------------------------------------------------
// 默认角色提示词（代码固定；输出 JSON 格式由引擎追加）
// ---------------------------------------------------------------------------

export const ROLE_PROMPTS = {
  style: `你是一位资深卡牌艺术总监。根据用户的创作提示词与风格参考图，产出一份《风格规范书》，供整套卡牌（数十张）保持统一视觉风格。规范书需具体可执行，涵盖：整体艺术风格与媒介、主色调与辅助色（给出直观的颜色描述）、构图与透视惯例、材质与笔触、边框与装饰纹样、字体气质（如需文字）、光影氛围、禁止事项（负面清单）。用户提供了参考图时，请先仔细读图，规范书必须与参考图风格强对齐。`,
  structure: `你是一位卡牌体系结构策划师。根据用户提示词与风格规范书，为整套卡牌产出完整的卡牌清单：每张卡的牌名与一句话牌义（骨架）。若提供了标准体系骨架，必须严格遵循骨架的顺序与牌名逐张补全牌义，不得增删或改名；若没有骨架（神谕卡），则围绕用户主题设计张数完整、主题覆盖全面、彼此不重复的卡牌清单。牌义要具体、有意境、彼此区分。`,
  copywriter: `你是一位资深卡牌文案策划师。根据结构清单中该卡的牌名与牌义骨架、风格规范书，为这一张卡撰写生图提示词：以规范书的视觉语言为前缀，画面具体可画、细节丰富、符合牌义意象。打回改写时，认真针对本轮审核反馈调整提示词，只修改反馈指出的问题，不要推翻已通过的部分。`,
  contentReview: `你是严格的内容审核员。判断图片是否准确呈现提示词与牌名/牌义，不得放过明显偏离的图。`,
  aestheticReview: `你是专业的审美评审。对图片的构图、色彩、细节与执行质量打分（0-100，宁严勿宽）。`,
  consistencyReview: `你是成套一致性审核员。将图片与风格规范书及基准图（已确认的风格小样/用户参考图）比对，评估整套风格统一性：色调、媒介质感、边框装饰、构图惯例是否一致。输出 0-100 的一致性分，明显跳出的风格要给低分并说明差异。`,
} as const

// ---------------------------------------------------------------------------
// 牌组标准骨架（结构策划的确定性输入；塔罗/扑克固定，神谕自由生成）
// ---------------------------------------------------------------------------

const TAROT_SUITS = [
  { suit: "权杖", element: "火 · 行动与创造" },
  { suit: "圣杯", element: "水 · 情感与关系" },
  { suit: "宝剑", element: "风 · 思维与冲突" },
  { suit: "星币", element: "土 · 物质与现实" },
] as const

const TAROT_MAJOR_NAMES = [
  "愚者", "魔术师", "女祭司", "女皇", "皇帝", "教皇", "恋人", "战车",
  "力量", "隐士", "命运之轮", "正义", "倒吊人", "死神", "节制", "恶魔",
  "塔", "星星", "月亮", "太阳", "审判", "世界",
] as const

const TAROT_MINOR_RANKS = [
  "王牌", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "侍从", "骑士", "王后", "国王",
] as const

/** 塔罗 78 张骨架（大阿卡纳 22 在前，顺序固定；小阿卡纳四花色各 14） */
export function tarotSkeleton(): { index: number; name: string; hint: string }[] {
  const cards: { index: number; name: string; hint: string }[] = []
  TAROT_MAJOR_NAMES.forEach((name, i) => {
    cards.push({ index: i, name: `${name}`, hint: "大阿卡纳" })
  })
  let idx = 22
  for (const { suit, element } of TAROT_SUITS) {
    for (const rank of TAROT_MINOR_RANKS) {
      cards.push({ index: idx, name: `${suit}${rank}`, hint: `小阿卡纳 · ${suit}（${element}）` })
      idx++
    }
  }
  return cards
}

/** 塔罗小样基础序号（大阿卡纳代表卡；模板卡牌清单同款固定序号） */
const TAROT_SAMPLE_BASE = [0, 1, 2, 5, 10, 21]

/**
 * 小样代表卡序号（结构清单顺序固定前提下按 index 标记 is_sample）：
 * 塔罗=大阿卡纳代表卡；sampleCount 超出基础序号数时在余下卡中均匀补足。
 */
export function sampleIndexes(direction: AgentDirection, cardCount: number, sampleCount: number): number[] {
  const count = Math.max(1, Math.min(sampleCount, cardCount))
  if (direction !== "tarot") return Array.from({ length: count }, (_, i) => i)
  if (count <= TAROT_SAMPLE_BASE.length) return TAROT_SAMPLE_BASE.slice(0, count)
  const chosen = new Set(TAROT_SAMPLE_BASE)
  const rest = Array.from({ length: cardCount }, (_, i) => i).filter((i) => !chosen.has(i))
  const extra = Math.min(count - TAROT_SAMPLE_BASE.length, rest.length)
  for (let k = 0; k < extra; k++) {
    const pos = Math.round((k * (rest.length - 1)) / Math.max(1, extra - 1))
    chosen.add(rest[pos]!)
  }
  return [...chosen].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 固定图构造（节点 id 全局约定，引擎/前端共用）
// ---------------------------------------------------------------------------

export const PIPELINE_NODE_IDS = {
  start: "start",
  style: "style",
  structure: "structure",
  copywriter: "copywriter",
  imagegen: "imagegen",
  reviewContent: "review_content",
  reviewAesthetic: "review_aesthetic",
  reviewConsistency: "review_consistency",
  supervisor: "supervisor",
  end: "end",
} as const

/** 用户质量覆盖（发起弹窗提交；缺省项回退 templateConfig 默认） */
export interface TemplateQualityOverrides {
  contentThreshold?: number
  aestheticThreshold?: number
  consistencyThreshold?: number
  maxRetries?: number
}

/**
 * 塔罗模板生产图（art 阶段 produce_cards 用；确认卡牌清单时写入 graphSnapshot）：
 * item 级流水线（文案改写 → 生图 → 评审团 → 总控 → 交付），不含 run 级
 * 风格/结构节点——模板流程的简报与 78 张清单即其对应物。
 * 评审团：每个评审 AI 一个「全维度」节点（三维同审、各自阈值），总控按
 * 各维平均分 + 内容多数票裁决；评审团未配置时回退经典三审槽位（去重）。
 * quality：用户发起时选择的质量要求，覆盖 templateConfig 阈值与打回上限。
 */
export function buildTemplateProductionGraph(
  config: DirectionConfig,
  quality?: TemplateQualityOverrides,
): AgentGraph {
  const m = config.models
  const t = config.templateConfig ?? DEFAULT_TAROT_TEMPLATE_CONFIG
  const reviewerIds =
    t.reviewerModelIds.filter(Boolean).length > 0
      ? t.reviewerModelIds.filter(Boolean)
      : [
          ...new Set(
            [m.contentReviewModelId, m.aestheticReviewModelId, m.consistencyReviewModelId].filter(
              (id): id is string => Boolean(id),
            ),
          ),
        ]
  const thresholds = {
    content: quality?.contentThreshold ?? t.reviewThresholds.content,
    aesthetic: quality?.aestheticThreshold ?? t.reviewThresholds.aesthetic,
    consistency: quality?.consistencyThreshold ?? t.reviewThresholds.consistency,
  }
  const maxRetries = quality?.maxRetries ?? t.maxRetries

  const reviewerNodes: AgentGraph["nodes"] = reviewerIds.map((modelId, i) => ({
    id: `review_${i + 1}`,
    type: "review" as const,
    position: { x: 780, y: 40 + i * 140 },
    config: {
      title: `评审 ${i + 1}`,
      dimensions: ["content", "aesthetic", "consistency"] as const,
      aestheticThreshold: thresholds.aesthetic,
      contentThreshold: thresholds.content,
      consistencyThreshold: thresholds.consistency,
      chatModelId: modelId,
      reviewPromptOverride: "",
    },
  }))
  const reviewerEdges: AgentGraph["edges"] = [
    ...reviewerNodes.map((node) => ({
      id: `tp-e-to-${node.id}`,
      source: PIPELINE_NODE_IDS.imagegen,
      target: node.id,
      sourceHandle: "main" as const,
    })),
    ...reviewerNodes.map((node) => ({
      id: `tp-e-from-${node.id}`,
      source: node.id,
      target: PIPELINE_NODE_IDS.supervisor,
      sourceHandle: "main" as const,
    })),
  ]

  return {
    nodes: [
      {
        id: PIPELINE_NODE_IDS.start,
        type: "start",
        position: { x: 0, y: 320 },
        config: { title: "开始", theme: "", styleGuide: "", cardCount: 0, concurrency: t.concurrency },
      },
      {
        id: PIPELINE_NODE_IDS.copywriter,
        type: "agent",
        position: { x: 260, y: 320 },
        config: {
          title: "提示词设计师",
          rolePrompt: ROLE_PROMPTS.copywriter,
          chatModelId: t.copywriterChatModelId ?? m.copywriterChatModelId,
          candidateCount: 1,
          thinkingLevel: m.copywriterThinkingLevel,
          role: "copywriter",
        },
      },
      {
        id: PIPELINE_NODE_IDS.imagegen,
        type: "image_gen",
        position: { x: 520, y: 320 },
        config: {
          title: "画师生图",
          imageModelId: t.cardImageModelId ?? m.imageModelId,
          imageSize: t.assetSizes.card || m.imageSize || "1024x1024",
          candidateCount: 1,
        },
      },
      ...reviewerNodes,
      {
        id: PIPELINE_NODE_IDS.supervisor,
        type: "supervisor",
        position: { x: 1040, y: 233 },
        config: { title: "总控裁决", maxRetries, exhaustedStrategy: "fallback_best" },
      },
      {
        id: PIPELINE_NODE_IDS.end,
        type: "end",
        position: { x: 1300, y: 320 },
        config: { title: "交付" },
      },
    ],
    edges: [
      { id: "tp-e1", source: "start", target: "copywriter", sourceHandle: "main" },
      { id: "tp-e2", source: "copywriter", target: "imagegen", sourceHandle: "main" },
      ...reviewerEdges,
      { id: "tp-e9", source: "supervisor", target: "end", sourceHandle: "main" },
      { id: "tp-e-retry", source: "supervisor", target: "copywriter", sourceHandle: "retry" },
    ],
  }
}

/** 模板生产图配置完整性（前端可读的缺失清单；空数组 = 可以开跑） */
export function templateProductionMissingSlots(config: DirectionConfig): string[] {
  const t = config.templateConfig ?? DEFAULT_TAROT_TEMPLATE_CONFIG
  const missing: string[] = []
  if (!(t.copywriterChatModelId ?? config.models.copywriterChatModelId)) missing.push("文案改写模型")
  const imageModelId = t.cardImageModelId ?? config.models.imageModelId
  if (!imageModelId) missing.push("卡面生图模型")
  // 与 buildTemplateProductionGraph 的评审团构造口径一致：
  // 评审团显式配置了任意模型，或经典三审槽位存在至少一个即视为可用
  const hasReviewers =
    t.reviewerModelIds.filter(Boolean).length > 0 ||
    [config.models.contentReviewModelId, config.models.aestheticReviewModelId, config.models.consistencyReviewModelId].some(Boolean)
  if (!hasReviewers) missing.push("评审团模型（至少 1 个）")
  return missing
}
