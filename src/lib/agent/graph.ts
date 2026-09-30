/**
 * AI Agent 工作流图结构定义（纯类型 + 常量，零运行时依赖）
 *
 * 三方共用：db/schema/agent.ts（jsonb $type）、编排引擎（agent-orchestrator）、
 * 前端画布（@xyflow/react 节点/边）。借鉴 Dify 的「节点+连线」图模型与
 * ai-card-studio 的「生成→并行双审→裁决→打回循环」流水线语义。
 *
 * 图语义（v1 结构契约）：
 * - 恰好一个 start 与一个 end；普通边（sourceHandle = "main"）构成从 start
 *   可达 end 的 DAG；允许中间并行分支（如双审并行），在下游节点汇合；
 * - 仅 supervisor 节点可产生 retry 边（sourceHandle = "retry"），指回上游
 *   agent / image_gen 节点形成显式打回循环，受「打回上限」约束；
 * - human 节点为可选的人工终审关卡：执行到该节点时 item 挂起等待确认。
 */

/** 节点类型（v1 七种；类型色与图标在前端 NODE_TYPE_META 统一维护） */
export type AgentNodeType =
  | "start" // 开始：输入参数默认值（主题/风格约束/张数/并发）
  | "agent" // 智能体（LLM）：角色提示词 + 模型 + 候选数
  | "image_gen" // 生图：模型 + 尺寸 + 候选数
  | "review" // 审核（LLM vision）：内容对齐 / 审美评分
  | "supervisor" // 主管裁决（纯规则，不耗 LLM）：打回上限 + 耗尽策略
  | "human" // 人工确认（可选节点）：逐卡确认任意一轮为终版
  | "end" // 结束

/** 思考档位（与 chat 域七档一致；本地定义避免 schema 反向依赖） */
export type AgentThinkingLevel =
  | "off"
  | "low"
  | "medium"
  | "high"
  | "extra"
  | "max"
  | "ultracode"

/** 审核维度（consistency = 与风格基准图/规范书比对，成套一致性） */
export type ReviewDimension = "content" | "aesthetic" | "consistency"

/**
 * 产品方向（固定流水线）：塔罗 78 / 神谕卡可选张数 / 扑克 54
 */
export type AgentDirection = "tarot" | "oracle" | "poker"

export interface DirectionMeta {
  key: AgentDirection
  name: string
  description: string
  /** 固定张数（null = 用户可选） */
  fixedCount: number | null
  /** 可选张数档位（fixedCount = null 时生效） */
  countOptions?: number[]
  /** 默认张数 */
  defaultCount: number
  /** 小样代表卡说明 */
  sampleNote: string
}

export const AGENT_DIRECTIONS: DirectionMeta[] = [
  {
    key: "tarot",
    name: "塔罗牌",
    description: "标准 78 张塔罗（22 大阿卡纳 + 56 小阿卡纳），结构策划 Agent 按标准体系逐张补全牌义。",
    fixedCount: 78,
    defaultCount: 78,
    sampleNote: "小样取 6 张大阿卡纳代表卡（愚者/魔术师/女祭司/恋人/命运之轮/世界）",
  },
  {
    key: "oracle",
    name: "神谕卡",
    description: "主题化神谕卡组（24/36/44/64 张可选），由结构策划 Agent 围绕主题生成整套卡牌清单。",
    fixedCount: null,
    countOptions: [24, 36, 44, 64],
    defaultCount: 36,
    sampleNote: "小样取前 6 张代表卡",
  },
  {
    key: "poker",
    name: "扑克牌",
    description: "标准 54 张扑克（52 + 大小王），四花色 × 13 点数标准结构。",
    fixedCount: 54,
    defaultCount: 54,
    sampleNote: "小样取 6 张代表卡（黑桃A/红心K/方块Q/梅花J/大王/小王）",
  },
]

/**
 * 智能体角色（固定流水线编制）：
 * - style / structure 为 run 级（整套执行一次）；
 * - copywriter 为 item 级（逐张执行）
 */
export type AgentRole = "style" | "structure" | "copywriter"

// ---------------------------------------------------------------------------
// 节点配置（按类型）
// ---------------------------------------------------------------------------

export interface StartNodeConfig {
  title: string
  /** 运行输入默认值（运行弹窗可覆盖） */
  theme: string
  styleGuide: string
  /** 生成张数（每张独立走一遍流水线） */
  cardCount: number
  /** 单次运行内并行执行的流水线数 */
  concurrency: number
}

export interface AgentNodeConfig {
  title: string
  /** 角色提示词（system prompt；起草/改写由引擎追加格式指令） */
  rolePrompt: string
  /** chat_api_config 模型 id（null = 未配置，运行前校验拦截） */
  chatModelId: string | null
  /** 候选数：一次产出 N 版供下游选优（默认 1） */
  candidateCount: number
  thinkingLevel: AgentThinkingLevel
  /** 流水线角色：style/structure 为 run 级整套一次，copywriter 逐张 */
  role?: AgentRole
}

export interface ImageGenNodeConfig {
  title: string
  /** model 表生图模型 id（null = 未配置） */
  imageModelId: string | null
  imageSize: string
  /** 候选数：每轮生成 N 张，审核逐候选评分取最优（默认 1） */
  candidateCount: number
}

export interface ReviewNodeConfig {
  title: string
  /** 审核维度（可多开：评审团节点三维同审） */
  dimensions: ReviewDimension[]
  /** 审美及格线（0-100；兼作缺省内容/一致性阈值） */
  aestheticThreshold: number
  /** 内容对齐及格线（0-100；内容数值分达标线，缺省回退 aestheticThreshold） */
  contentThreshold?: number
  /** 一致性及格线（0-100；缺省回退 aestheticThreshold） */
  consistencyThreshold?: number
  /** chat_api_config 模型 id（必须 supportsVision = true） */
  chatModelId: string | null
  /** 审核提示词覆盖（空 = 引擎默认；自定义时不追加格式指令以外的内容） */
  reviewPromptOverride: string
}

export interface SupervisorNodeConfig {
  title: string
  /** 打回上限（0-10；每张卡独立计数） */
  maxRetries: number
  /** 打回耗尽策略：fallback_best = 选历史最优继续；mark_failed = 标记失败 */
  exhaustedStrategy: "fallback_best" | "mark_failed"
}

export interface HumanNodeConfig {
  title: string
}

export interface EndNodeConfig {
  title: string
}

export type AgentNodeConfigByType = {
  start: StartNodeConfig
  agent: AgentNodeConfig
  image_gen: ImageGenNodeConfig
  review: ReviewNodeConfig
  supervisor: SupervisorNodeConfig
  human: HumanNodeConfig
  end: EndNodeConfig
}

export type AnyAgentNodeConfig = AgentNodeConfigByType[AgentNodeType]

// ---------------------------------------------------------------------------
// 图结构
// ---------------------------------------------------------------------------

export interface AgentGraphNode {
  id: string
  type: AgentNodeType
  /** 画布坐标（@xyflow/react 布局用；引擎不关心） */
  position: { x: number; y: number }
  config: AnyAgentNodeConfig
}

export type AgentEdgeSourceHandle = "main" | "retry"

export interface AgentGraphEdge {
  id: string
  source: string
  target: string
  /** main = 普通连线；retry = supervisor 打回边（唯一允许的成环边） */
  sourceHandle: AgentEdgeSourceHandle
}

export interface AgentGraph {
  nodes: AgentGraphNode[]
  edges: AgentGraphEdge[]
}

// ---------------------------------------------------------------------------
// 运行时状态枚举（DB varchar 落库，前端状态色据此映射）
// ---------------------------------------------------------------------------

/** 运行状态（agent_run.status） */
export const AGENT_RUN_STATUSES = [
  "queued", // 排队中（等待 worker 拉起）
  "running", // 运行中
  "paused", // 已暂停（可恢复）
  "waiting_style", // 小样完成，等待用户确认风格（两阶段模式）
  "waiting_human", // 全部在途 item 等待人工确认
  "completed", // 完成
  "failed", // 失败
  "cancelled", // 已取消
] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

/** 运行阶段（两阶段模式：sample = 小样；full = 全套） */
export type AgentRunPhase = "sample" | "full"

/** 单卡状态（agent_run_item.status） */
export const AGENT_ITEM_STATUSES = [
  "pending", // 排队（等待起草）
  "drafting", // 文案起草/改写中
  "generating", // 生图中
  "reviewing", // 审核中
  "waiting_human", // 等待人工确认
  "approved_by_ai", // AI 通过（若无 human 节点即终态）
  "fallback", // 打回耗尽，自动选历史最优兜底
  "confirmed", // 人工已确认（终态）
  "failed", // 失败（终态）
  "cancelled", // 随运行取消（终态）
] as const
export type AgentItemStatus = (typeof AGENT_ITEM_STATUSES)[number]

/** 节点级聚合状态（agent_node_run.status；画布状态色数据源） */
export const AGENT_NODE_RUN_STATUSES = [
  "idle", // 未执行
  "running", // 执行中（蓝）
  "done", // 全部完成（绿）
  "failed", // 有失败（红）
  "skipped", // 跳过（半透明）
] as const
export type AgentNodeRunStatus = (typeof AGENT_NODE_RUN_STATUSES)[number]

/** prompt 来源（agent_round.promptSource；对齐 ai-card-studio 留痕设计） */
export const AGENT_PROMPT_SOURCES = ["initial", "auto_revise", "manual"] as const
export type AgentPromptSource = (typeof AGENT_PROMPT_SOURCES)[number]

// ---------------------------------------------------------------------------
// 模板化分阶段制作（tarot template stages；agent_run 扩列 + agent_asset / agent_message 留痕）
// ---------------------------------------------------------------------------

/** 模板阶段（agent_run.stage）：模板化分阶段制作的推进游标 */
export const AGENT_TEMPLATE_STAGES = [
  "clarify", // 需求澄清与创作简报
  "world", // 内容方向、世界观与风格定稿
  "prompt", // 卡面与套件资产提示词
  "art", // 生图与多评审员审核
  "compose", // 边框合成与交付
] as const
export type AgentTemplateStage = (typeof AGENT_TEMPLATE_STAGES)[number]

/** 卡框模式（agent_run.frameMode）：custom 时引用 agent_run.frameAssetId */
/** 新模板只创建 AI 模式；旧数据库中的 none/local/custom 由读取层归一化为 ai。 */
export const AGENT_FRAME_MODES = ["ai"] as const
export type AgentFrameMode = (typeof AGENT_FRAME_MODES)[number]
export type LegacyAgentFrameMode = "none" | "local" | "custom" | "ai"

/** 卡框合成状态（agent_run_item.frameStatus） */
export const AGENT_FRAME_STATUSES = [
  "pending", // 待合成
  "framing", // 合成中
  "framed", // 已套框
  "failed", // 合成失败
  "skipped", // 跳过（历史运行或无需套框）
] as const
export type AgentFrameStatus = (typeof AGENT_FRAME_STATUSES)[number]

/** 消息角色（agent_message.role） */
export const AGENT_MESSAGE_ROLES = ["user", "assistant", "system"] as const
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number]

/** 模板资产类型（agent_asset.kind）：边框、卡背与牌盒四面 */
export const AGENT_ASSET_KINDS = [
  "border",
  "back",
  "box_front",
  "box_back",
  "box_side",
  "box_top",
] as const
export type AgentAssetKind = (typeof AGENT_ASSET_KINDS)[number]

// ---------------------------------------------------------------------------
// 运行输入 / 结果结构（jsonb 落库形状）
// ---------------------------------------------------------------------------

/** 模板流程待执行动作（agent_run.pendingAction；worker 认领后执行并清空） */
export type AgentPendingAction = {
  kind:
    | "clarify_turn"
    | "finalize_brief"
    | "gen_directions"
    | "compose_preview"
    | "compose_batch"
    | "produce_cards"
  /** gen_directions 重新生成时携带的用户反馈 */
  feedback?: string
  itemId?: string
  borderAssetId?: string
  /** produce_cards：本轮生产批次（sample = 风格小样；full = 全套） */
  phase?: AgentRunPhase
  requestedAt: string
}

/** 澄清追问（agent_message.meta.questions 元素；工坊对话快捷选项） */
export interface AgentClarifyQuestion {
  id: string
  question: string
  options: string[]
}

/** 消息结构化元信息（agent_message.meta；按消息类型区分渲染与轮次统计） */
export type AgentMessageMeta =
  | { kind: "clarify"; round: number; analysis?: string; questions: AgentClarifyQuestion[]; ready: boolean }
  | { kind: "brief" }
  | { kind: "directions"; count: number }

/** 模板阶段可供用户选择的内容方向 */
export interface AgentTemplateDirection {
  id: string
  name: string
  description: string
  /** 一句话概念（方向卡片的首句卖点） */
  concept?: string
  /** 世界观概述（2-4 句） */
  worldview?: string
  /** 大阿卡纳（22 张）在该方向下的演绎思路 */
  majorArcana?: string
  /** 小阿卡纳四花色意象映射（权杖/圣杯/宝剑/星币） */
  suitMapping?: { suit: string; mapping: string }[]
  /** 主辅色描述 */
  palette?: string
  visualLanguage: string
  /** 示例卡（3 张）：牌名 + 该方向下的画面场景 */
  sampleCards: { name: string; scene: string }[]
}

/** 用户在发起时可选的质量要求（覆盖管理员默认；存 agent_run.input.quality） */
export interface AgentRunQuality {
  /** 内容对齐及格线（0-100，10 分一档） */
  contentThreshold: number
  /** 审美及格线（0-100，10 分一档） */
  aestheticThreshold: number
  /** 成套一致性及格线（0-100，10 分一档） */
  consistencyThreshold: number
  /** 打回上限（0-3；越高单卡最多生成轮数越多，费用相应增加） */
  maxRetries: number
}

/** 运行输入（agent_run.input；发起弹窗提交） */
export interface AgentRunInput {
  /** 创作提示词（主题 + 风格描述） */
  prompt: string
  /** 卡牌张数 */
  cardCount: number
  /** 单次运行内并行执行的流水线数 */
  concurrency: number
  /** 风格参考图 URL（≤4，生图与一致性审核引用） */
  referenceImages: string[]
  /** 质量要求（缺省用管理员配置的默认值） */
  quality?: AgentRunQuality
}

/** 生图候选（agent_round.candidates 数组元素；多候选评分选优留档） */
export interface RoundCandidate {
  url: string
  /** 审美评分（0-100；未评分为 null） */
  score: number | null
  /** 内容对齐是否通过（未评为 null） */
  contentPass: boolean | null
}

/** 审核结果（agent_review.result；单维度一条） */
export interface ReviewResultPayload {
  dimension: ReviewDimension
  /** 内容维度：是否通过 */
  pass: boolean | null
  /** 审美维度：评分 0-100 */
  score: number | null
  /** 必须给理由：打回时文案 Agent 改写的唯一依据（ai-card-studio 契约） */
  reason: string
}

/** 裁决结果（agent_review kind = verdict） */
export interface VerdictPayload {
  verdict: "approve" | "retry" | "fallback"
  contentPass: boolean
  aestheticScore: number | null
  consistencyScore: number | null
  roundsUsed: number
  maxRetries: number
  detail: string
}

/** 打回反馈（总控 → 上游文案改写；只传本轮，防 prompt 膨胀） */
export interface RetryFeedback {
  contentPass: boolean | null
  contentReason: string | null
  aestheticScore: number | null
  aestheticReason: string | null
  consistencyScore: number | null
  consistencyReason: string | null
}

/** 节点类型 → 默认标题（新增节点/模板展示用） */
export const NODE_TYPE_DEFAULT_TITLE: Record<AgentNodeType, string> = {
  start: "开始",
  agent: "智能体",
  image_gen: "生图",
  review: "审核",
  supervisor: "主管裁决",
  human: "人工确认",
  end: "结束",
}
