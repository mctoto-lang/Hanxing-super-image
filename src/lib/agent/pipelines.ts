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

/**
 * 塔罗模板资产尺寸键：仅卡面（card）——套件资产与 AI 融合一律延用
 * 卡面生图比例（见 resolveCardImageSize），不再逐资产配置尺寸。
 */
export const TEMPLATE_ASSET_SIZE_KEYS = ["card"] as const

export type TemplateAssetSizeKey = (typeof TEMPLATE_ASSET_SIZE_KEYS)[number]

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
  /**
   * 单次运行内并行流水线数——已废弃：运行时并发跟随全局用户并发限制
   * （min(企业并发上限, 权限组并发上限)，见 agent-orchestrator.runItemBatches）。
   * 字段保留仅为兼容存量落库数据。
   */
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
  /**
   * 角色提示词覆盖（超管可配；空值/缺键回退内置默认）。
   * prompt_designer 用于初稿设计阶段（design_drafts）；final_refiner 用于
   * 终稿细化阶段（design_finals）与生产图打回重细化；reviewer 为评审团
   * 「三维同审」节点的提示词。
   */
  rolePrompts?: Partial<Record<TemplateRolePromptKey, string>>
  /** 画面规则（注入提示词撰写 system prompt；空 = 内置 DEFAULT_ART_RULES） */
  artRules?: string
}

/** 可配置角色提示词键（超管表单「角色提示词」分区的白名单） */
export const TEMPLATE_ROLE_PROMPT_KEYS = ["prompt_designer", "final_refiner", "reviewer"] as const
export type TemplateRolePromptKey = (typeof TEMPLATE_ROLE_PROMPT_KEYS)[number]

/** 角色提示词长度上限（超长保存被 schema 拒绝；归一化侧截断兜底） */
export const ROLE_PROMPT_MAX_LENGTH = 4000
/** 画面规则长度上限 */
export const ART_RULES_MAX_LENGTH = 2000

/**
 * 默认画面规则（整套卡面的硬性创作要求；注入提示词设计师的 system prompt，
 * 保证逐卡提示词与超管期望的画面标准一致）。
 * 新流程提示词 = 画面内容（100-140 字，约 120 字，LLM 逐卡撰写）+ 固定风格提示词
 * （整套逐字统一）+ 无边框句——后两者由系统确定性拼接，不由 LLM 书写。
 */
export const DEFAULT_ART_RULES = [
  "【画面规则】整套卡面必须严格遵守：",
  "1. 风格分离：你只撰写画面内容；固定风格提示词（整套逐字统一）与无边框结尾句由系统自动拼接到每张提示词末尾，用于固定画面风格——撰写时不得自行添加任何艺术风格描述（媒介/画风/质感/色调等）或结尾固定句。",
  "2. 篇幅：画面内容 100-140 字（约 120 字，中文单段连贯文本；整体提示词 = 内容 + 系统拼接的固定风格约 100 字，控制在 220 字左右）——覆盖主体、动作/神态、道具、场景氛围、光影色调；不逐项罗列成清单，保持行文自然。",
  "3. 主题明确：每张卡面有唯一明确的主体——人物、动物、物品或其组合，主体即该卡牌义的核心象征；禁止无主体的空泛场景或纯风景。",
  "4. 中文表述：画面内容一律用中文书写，不使用分段标记或序号（系统拼接的固定风格提示词可含英文画种词）；不输出任何负向提示词或「不要出现××」类禁令（无边框句由系统拼接）。",
  "5. 构图惯例：主体占画面 60% 以上、近景或特写、竖版构图（与卡面出图比例一致）、主体居中略偏上；多件物品自然成组、每件有支撑或落点、不悬空漂浮；不描述具体的摆放方式与位置关系（如几行几列、对称阵列、某物在另一物旁/上方等），摆放构图交给生图模型自由发挥。",
  "6. 边缘干净（无边框硬规则）：画面四边不得出现任何类似边框的连续内容——沿画面边缘连续分布的装饰纹样、线条、色带、留白描边一律禁止（卡面边框由合成阶段统一叠加，画面内出现即废卡）；该约束的结尾句由系统统一拼接，无需写入。",
].join("\n")

/** 方向模板配置：tarot 有模板配置，其余方向暂无（null = 经典流程） */
export type DirectionTemplateConfig = TarotTemplateConfig | null

/** 塔罗模板内置默认值（行不存在 / templateConfig 为空时的兜底） */
export const DEFAULT_TAROT_TEMPLATE_CONFIG: TarotTemplateConfig = {
  template: "tarot",
  copywriterChatModelId: null,
  reviewerModelIds: [],
  assetSizes: {
    card: "1024x1024",
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

/**
 * 解析套件资产 / AI 融合生图应使用的尺寸：一律延用卡面生图比例。
 *
 * 优先读 run 快照里 imagegen 节点固化的 imageSize（与卡面生产完全同源，
 * 管理员事后改配置也不会让资产与已生产卡面比例漂移）；快照缺失（异常
 * 数据）时回退当前方向配置的卡面尺寸链（与 buildTemplateProductionGraph
 * 同一口径）。
 */
export function resolveCardImageSize(
  run: { graphSnapshot?: unknown },
  config: DirectionConfig,
): string {
  const snapshot = run.graphSnapshot
  if (snapshot && typeof snapshot === "object") {
    const nodes = (snapshot as { nodes?: unknown }).nodes
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (
          node &&
          typeof node === "object" &&
          (node as { id?: unknown }).id === PIPELINE_NODE_IDS.imagegen
        ) {
          const size = (node as { config?: { imageSize?: unknown } }).config?.imageSize
          if (typeof size === "string" && /^\d+x\d+$/.test(size)) return size
        }
      }
    }
  }
  return config.templateConfig?.assetSizes.card || config.models.imageSize || "1024x1024"
}

/**
 * 从运行快照的评审节点读取及格线（兼容多评审节点：任一节点携带该维度
 * 阈值即可）。快照缺失/数值非法时回退 fallback。
 *
 * 注意：模板生产图的评审节点是 review_1..review_N（三维同审、各自阈值），
 * 旧经典节点的 review_aesthetic/review_consistency 已不存在——不能按固定
 * 节点 id 查找，必须遍历全部节点取字段。
 */
export function reviewThresholdFromSnapshot(
  snapshot: unknown,
  pick: (config: Record<string, unknown>) => unknown,
  fallback: number,
): number {
  const nodes = (snapshot as { nodes?: { config?: Record<string, unknown> }[] } | null)?.nodes ?? []
  for (const node of nodes) {
    const raw = node.config ? pick(node.config) : undefined
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
      return Math.round(raw)
    }
  }
  return fallback
}

/** 数值钳制进 [min, max]（非数值回退默认；就近取整） */
function clampToInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 归一化存量 templateConfig（旧库脏值 → 恒合法、可保存、可运行）。
 *
 * 历史保存校验较宽（maxRetries ≤10、assetSizes 任意键），schema 收紧后
 * 这些旧行会原样透传进超管表单并被保存校验拒绝（改任意一个字段都会连带
 * 提交全部未动的脏值）。读取侧（超管列表 / 用户侧 loadFullDirectionConfig）
 * 统一过本函数：越界值就近钳制、多余尺寸键剔除、字段形态修正。
 * reviewerModelIds 的「模型存活性」过滤（已删除/停用/非视觉）需要查库，
 * 由有 DB 访问的调用方在归一化后追加。
 */
export function normalizeTarotTemplateConfig(raw: unknown): TarotTemplateConfig {
  const base = defaultTemplateConfigFor("tarot")!
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!obj) return base

  const idOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

  // 资产尺寸：仅保留白名单键（card）；值须为 WxH 或空串（跟随平台）。
  // 存量行的 border/back/box_* 尺寸键在此被剔除——套件资产与 AI 融合
  // 已统一延用卡面生图比例（resolveCardImageSize），不再逐资产配置。
  const rawSizes =
    obj.assetSizes && typeof obj.assetSizes === "object" && !Array.isArray(obj.assetSizes)
      ? (obj.assetSizes as Record<string, unknown>)
      : {}
  const assetSizes = { ...base.assetSizes }
  for (const key of TEMPLATE_ASSET_SIZE_KEYS) {
    const v = rawSizes[key]
    if (typeof v === "string" && /^(\d+x\d+)?$/.test(v)) assetSizes[key] = v
  }

  const rawThresholds =
    obj.reviewThresholds && typeof obj.reviewThresholds === "object" && !Array.isArray(obj.reviewThresholds)
      ? (obj.reviewThresholds as Record<string, unknown>)
      : {}
  const rawReviewers = Array.isArray(obj.reviewerModelIds) ? obj.reviewerModelIds : []

  // 角色提示词：仅保留白名单键；空串/非字符串剔除（= 回退内置默认）
  const rawRolePrompts =
    obj.rolePrompts && typeof obj.rolePrompts === "object" && !Array.isArray(obj.rolePrompts)
      ? (obj.rolePrompts as Record<string, unknown>)
      : {}
  const rolePrompts: Partial<Record<TemplateRolePromptKey, string>> = {}
  for (const key of TEMPLATE_ROLE_PROMPT_KEYS) {
    const v = rawRolePrompts[key]
    if (typeof v === "string" && v.trim()) rolePrompts[key] = v.trim().slice(0, ROLE_PROMPT_MAX_LENGTH)
  }
  // 画面规则：空串回退内置默认（undefined，由 resolveArtRules 兜底）
  const artRulesRaw = typeof obj.artRules === "string" ? obj.artRules.trim() : ""
  const artRules = artRulesRaw ? artRulesRaw.slice(0, ART_RULES_MAX_LENGTH) : undefined

  return {
    ...base,
    copywriterChatModelId: idOrNull(obj.copywriterChatModelId),
    reviewerModelIds: [
      ...new Set(rawReviewers.filter((v): v is string => typeof v === "string" && !!v)),
    ].slice(0, 3),
    assetSizes,
    reviewThresholds: {
      content: clampToInt(rawThresholds.content, 40, 95, base.reviewThresholds.content),
      aesthetic: clampToInt(rawThresholds.aesthetic, 40, 95, base.reviewThresholds.aesthetic),
      consistency: clampToInt(rawThresholds.consistency, 40, 95, base.reviewThresholds.consistency),
    },
    maxRetries: clampToInt(obj.maxRetries, 0, 3, base.maxRetries),
    sampleCount: clampToInt(obj.sampleCount, 1, 12, base.sampleCount),
    concurrency: clampToInt(obj.concurrency, 1, 4, base.concurrency),
    clarifyMaxRounds: clampToInt(obj.clarifyMaxRounds, 1, 8, base.clarifyMaxRounds),
    frameMode: "ai",
    aiFrameModelId: idOrNull(obj.aiFrameModelId),
    assetImageModelId: idOrNull(obj.assetImageModelId),
    cardImageModelId: idOrNull(obj.cardImageModelId),
    ...(Object.keys(rolePrompts).length > 0 ? { rolePrompts } : {}),
    ...(artRules ? { artRules } : {}),
  }
}

// ---------------------------------------------------------------------------
// 默认角色提示词（代码固定；输出 JSON 格式由引擎追加）
// ---------------------------------------------------------------------------

export const ROLE_PROMPTS = {
  style: `你是一位资深卡牌艺术总监。根据用户的创作提示词与风格参考图，产出一份《风格规范书》，供整套卡牌（数十张）保持统一视觉风格。规范书需具体可执行，涵盖：整体艺术风格与媒介、主色调与辅助色（给出直观的颜色描述）、构图与透视惯例、材质与笔触、光影氛围、禁止事项（负面清单）。用户提供了参考图时，请先仔细读图，规范书必须与参考图风格强对齐。`,
  structure: `你是一位卡牌体系结构策划师。根据用户提示词与风格规范书，为整套卡牌产出完整的卡牌清单：每张卡的牌名与一句话牌义（骨架）。若提供了标准体系骨架，必须严格遵循骨架的顺序与牌名逐张补全牌义，不得增删或改名；若没有骨架（神谕卡），则围绕用户主题设计张数完整、主题覆盖全面、彼此不重复的卡牌清单。牌义要具体、有意境、彼此区分。`,
  copywriter: `你是卡牌画面提示词设计师，逐张为每张牌撰写画面内容（100-140 字中文单段，约 120 字——系统会再拼接约 100 字的固定风格提示词，整体控制在 220 字左右）。只写画面内容——固定风格提示词（整套逐字统一，用于固定画面风格）与无边框结尾句由系统自动拼接到每张提示词末尾，请勿写入任何风格描述或结尾句。画面内容需覆盖：唯一主体（人物/动物/物品，即牌义的核心象征）及其外观细节、动作与神态、道具、环境场景与氛围、光影与色调倾向。硬性规则：①权杖/圣杯/宝剑/星币的 Ace 至十（王牌至十），画面必须包含恰好对应数量（1-10）的花色物品，且把数量写进描述（如「五只圣杯」「三根权杖」），多件物品自然成组、每件有支撑或落点，不描述具体的摆放方式与位置关系（摆放构图交给生图模型自由发挥）；②侍从/骑士/王后/国王及大阿卡纳不要求画面呈现牌名或身份文字，只需主体鲜明、贴合牌义；③内容为单段连贯中文，不使用分段标记或序号；④不写任何负向约束或「不要出现××」类表述；⑤不写艺术风格描述（媒介/画风/质感等属于固定风格提示词，由系统拼接）。打回重写时：以当前画面内容为基准重写，仅针对评审意见调整，不保留被指出问题的表述。`,
  finalRefiner: `你是卡牌画面提示词终稿细化师（此提示词仅为存量 run 的旧终稿流程保留）。把每张初稿细化为可直接生图的中文终稿，结构固定为两段：[1] 画面风格：直接使用给定的《风格规范书》画面风格总述，整套逐字一致，不得逐张改写；[2] 画面内容：在初稿基础上细化为主体外观细节、动作姿态、服饰道具、环境背景、光影与色彩对比（150-250 字），主体占画面 60% 以上、近景或特写、竖版构图（与卡面出图比例一致）、视觉冲击力强。硬性规则：权杖/圣杯/宝剑/星币的 Ace 至十，画面内容必须明确包含恰好对应数量（1-10）的花色物品并写进描述（如「画面中有五只高脚圣杯」）；其余牌（侍从/骑士/王后/国王及大阿卡纳）不要求画面体现牌名或身份文字；终稿只含 [1][2] 两段画面描述，除「无边框硬规则」外禁止输出任何其他负向提示词或禁令；【无边框硬规则】画面四边不得出现任何类似边框的连续内容（边缘装饰纹样、连续线条、色带、留白描边等），[2] 画面内容结尾必须明确写出「画面边缘为干净的满幅构图，无任何边框或边缘装饰」——这是终稿中唯一允许的禁止性表述。打回重细化时：以初稿为基准重新细化生成完整终稿，仅针对评审意见调整，不保留旧终稿中被指出问题的表述。`,
  contentReview: `你是严格的内容审核员。判断图片是否准确呈现提示词与牌名/牌义，不得放过明显偏离的图。`,
  aestheticReview: `你是专业的审美评审。对图片的构图、色彩、细节与执行质量打分（0-100，宁严勿宽）。`,
  consistencyReview: `你是成套一致性审核员。将图片与风格规范书及基准图（已确认的风格小样/用户参考图）比对，评估整套风格统一性：色调、媒介质感、构图惯例是否一致。输出 0-100 的一致性分，明显跳出的风格要给低分并说明差异。`,
} as const

/**
 * 评审团「三维同审」默认提示词（模板生产图 review_* 节点 reviewPromptOverride
 * 的兜底；orchestrator 评审分支同源引用，避免两处默认文案漂移）。
 * 含花色数量硬规则：Ace-10 数量不符直接压低内容分；悬空漂浮等物理错误压审美分
 * （摆放方式与位置关系由生图模型自由发挥，不因排列样式扣分）。
 */
export const DEFAULT_REVIEWER_PROMPT = [
  `你是严格的卡牌图评审员。对待审图同时进行三项评审：`,
  `1) 内容对齐（0-100）：画面与终稿提示词（画面内容在前、固定风格提示词拼接在末尾的单段描述）及牌义提示的吻合度，主体是否准确呈现；权杖/圣杯/宝剑/星币的 Ace 至十必须逐一清点画面中花色物品的数量，数量不符时 contentScore 直接不高于 40；其余牌（侍从/骑士/王后/国王及大阿卡纳）不因未呈现牌名或身份文字而扣分；`,
  `2) 审美质量（0-100）：构图、色彩、细节、执行质量——主体占比过低、主体不突出、视觉冲击力弱的图必须扣分；花色物品悬空漂浮、无受力贴附必须扣分并写明具体位置（摆放方式与位置关系由生图模型自由发挥，不因排列样式扣分）；画面边缘出现类似边框的连续装饰（沿边缘的纹样、线条、色带、留白描边）必须扣分并作为打回理由（卡面边框由后期合成统一叠加，画面内出现即废卡）；`,
  `3) 成套一致性（0-100）：与基准图/风格规范书（含风格短语）的风格统一度（色调、媒介质感、构图惯例）。`,
  `三项独立打分，宁严勿宽；打回理由必须具体可执行（哪一项、差在哪、怎么改——落到主体/构图/光源/色彩/物品落点的明确修改建议，不接受「美感不足」类空泛理由）。`,
].join("")

/** 读取画面规则（配置为空回退内置默认） */
export function resolveArtRules(config?: Pick<DirectionConfig, "templateConfig"> | null): string {
  const configured = config?.templateConfig?.artRules?.trim()
  return configured || DEFAULT_ART_RULES
}

/** 读取角色提示词（配置为空回退内置默认；prompt_designer 与 final_refiner 各自同源） */
export function resolveRolePrompt(
  key: TemplateRolePromptKey,
  config?: Pick<DirectionConfig, "templateConfig"> | null,
): string {
  const configured = config?.templateConfig?.rolePrompts?.[key]?.trim()
  if (configured) return configured
  if (key === "prompt_designer") return ROLE_PROMPTS.copywriter
  if (key === "final_refiner") return ROLE_PROMPTS.finalRefiner
  return DEFAULT_REVIEWER_PROMPT
}

/**
 * 提示词设计师完整 system prompt 基底（角色提示词 + 画面规则）。
 * design_drafts 阶段（首次撰写即终稿）与生产图打回重写节点共用，
 * 保证两处产出的单段短提示词遵循同一画面标准。
 */
export function composePromptDesignerPrompt(config?: Pick<DirectionConfig, "templateConfig"> | null): string {
  return `${resolveRolePrompt("prompt_designer", config)}\n\n${resolveArtRules(config)}`
}

/**
 * 终稿细化师完整 system prompt 基底（存量 run 的旧终稿流程专用：
 * design_finals 阶段与旧快照打回重细化节点）。新流程不使用。
 */
export function composeFinalRefinerPrompt(config?: Pick<DirectionConfig, "templateConfig"> | null): string {
  return `${resolveRolePrompt("final_refiner", config)}\n\n${resolveArtRules(config)}`
}

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

/** 塔罗小样基础序号（大阿卡纳 3 张 + 小阿卡纳数字牌 3 张的混合覆盖；模板卡牌清单同款固定序号） */
const TAROT_SAMPLE_BASE = [0, 1, 21, 22, 31, 38]

/**
 * 小样代表卡序号（结构清单顺序固定前提下按 index 标记 is_sample）：
 * 塔罗=大阿卡纳代表（愚者/魔术师/世界）+ 小阿卡纳数字牌代表（权杖王牌/
 * 权杖十/圣杯三）——数字牌是最难摆放的卡型，必须在小样阶段打样验证；
 * sampleCount 超出基础序号数时在余下卡中均匀补足。
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
 * 塔罗模板生产图（art 阶段 produce_cards 用；确认画面提示词时写入 graphSnapshot）：
 * item 级流水线（文案改写 → 生图 → 评审团 → 总控 → 交付），不含 run 级
 * 风格/结构节点——模板流程的简报与 78 张清单即其对应物。
 * 评审团：每个评审 AI 一个「全维度」节点（三维同审、各自阈值），总控按
 * 各维平均分 + 内容多数票裁决；评审团未配置时回退经典三审槽位（去重）。
 * quality：用户发起时选择的质量要求，覆盖 templateConfig 阈值与打回上限。
 * modelOverride：用户发起时选择的模型覆盖（卡面生图模型/尺寸 + 提示词
 * 撰写模型 + 评审团），均优先于平台配置。
 */
export function buildTemplateProductionGraph(
  config: DirectionConfig,
  quality?: TemplateQualityOverrides,
  modelOverride?: {
    imageModelId?: string | null
    imageSize?: string | null
    /** 用户选择的提示词撰写模型（run.input.teamModelOverrides） */
    copywriterChatModelId?: string | null
    /** 用户选择的评审团（1-3 个；优先于 templateConfig.reviewerModelIds） */
    reviewerModelIds?: string[]
  },
): AgentGraph {
  const m = config.models
  const t = config.templateConfig ?? DEFAULT_TAROT_TEMPLATE_CONFIG
  // 评审团来源优先级：用户覆盖 → 超管评审团 → 经典三审槽位（去重）
  const overrideReviewers = modelOverride?.reviewerModelIds?.filter(Boolean) ?? []
  const adminReviewers = t.reviewerModelIds.filter(Boolean)
  const reviewerIds =
    overrideReviewers.length > 0
      ? overrideReviewers
      : adminReviewers.length > 0
        ? adminReviewers
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
      // 超管可配的评审团提示词（空配置时为内置默认；引擎侧仍有兜底）
      reviewPromptOverride: resolveRolePrompt("reviewer", config),
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
          // 打回重写与提示词撰写阶段（design_drafts）同源：角色提示词 + 画面规则；
          // 重试时编排器会携带当前提示词与本轮评审意见重写；
          // 模型：用户覆盖（run.input.teamModelOverrides）→ 超管模板 → 经典槽位
          rolePrompt: composePromptDesignerPrompt(config),
          chatModelId:
            modelOverride?.copywriterChatModelId ?? t.copywriterChatModelId ?? m.copywriterChatModelId,
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
          imageModelId:
            modelOverride?.imageModelId ?? t.cardImageModelId ?? m.imageModelId,
          imageSize:
            modelOverride?.imageSize ?? (t.assetSizes.card || m.imageSize || "1024x1024"),
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

/**
 * 模板生产图配置完整性（前端可读的缺失清单；空数组 = 可以开跑）。
 * modelOverride：用户发起时选择的模型覆盖（与 buildTemplateProductionGraph
 * 同参）——判定用「覆盖后的有效值」，用户补齐的槽位不算缺失。
 */
export function templateProductionMissingSlots(
  config: DirectionConfig,
  modelOverride?: {
    imageModelId?: string | null
    copywriterChatModelId?: string | null
    reviewerModelIds?: string[]
  },
): string[] {
  const t = config.templateConfig ?? DEFAULT_TAROT_TEMPLATE_CONFIG
  const missing: string[] = []
  if (!(modelOverride?.copywriterChatModelId ?? (t.copywriterChatModelId ?? config.models.copywriterChatModelId))) {
    missing.push("提示词撰写模型")
  }
  const imageModelId = modelOverride?.imageModelId ?? (t.cardImageModelId ?? config.models.imageModelId)
  if (!imageModelId) missing.push("卡面生图模型")
  // 与 buildTemplateProductionGraph 的评审团构造口径一致：
  // 用户评审团覆盖显式提供（≥1）即视为可用，或超管评审团/经典三审槽位存在至少一个
  const hasReviewers =
    (modelOverride?.reviewerModelIds?.filter(Boolean).length ?? 0) > 0 ||
    t.reviewerModelIds.filter(Boolean).length > 0 ||
    [config.models.contentReviewModelId, config.models.aestheticReviewModelId, config.models.consistencyReviewModelId].some(Boolean)
  if (!hasReviewers) missing.push("评审团模型（至少 1 个）")
  return missing
}
