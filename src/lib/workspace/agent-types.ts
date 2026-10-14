/**
 * 工作台 Agent 共享类型（客户端/服务端通用，零运行时依赖）
 *
 * 工作台内的 AI Agent 域（/workspace 内嵌 Agent：批量生图工作台的
 * 智能化扩展）。留痕结构对齐 /agent 卡牌工坊（workflow/direction/card/
 * round/review/event）并适配工作台多租户体系：全部业务表带 enterpriseId
 * + userId 双过滤，产出物（prompt card / card image / generation task）
 * 通过外键回链工作台既有表。
 *
 * 三方共用：db/schema/workspace-agent.ts（varchar $type / jsonb $type）、
 * server actions、前端组件。命名对齐 @/lib/agent/graph 的既有约定。
 */

// ---------------------------------------------------------------------------
// 工作流状态（workspace_agent_workflow.status）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_WORKFLOW_STATUSES = [
  "queued", // 排队中（等待 worker 拉起）
  "running", // 运行中
  "waiting_human", // 等待用户确认（方向选择 / 小样确认 / 失败卡处理）
  "completed", // 完成
  "failed", // 失败
  "cancelled", // 已取消
] as const
export type WorkspaceAgentStatus = (typeof WORKSPACE_AGENT_WORKFLOW_STATUSES)[number]

// ---------------------------------------------------------------------------
// 方向（workspace_agent_direction.status）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_DIRECTION_STATUSES = [
  "candidate", // 候选（Agent 产出待选）
  "selected", // 用户已选定
  "rejected", // 用户已淘汰
] as const
export type WorkspaceAgentDirectionStatus =
  (typeof WORKSPACE_AGENT_DIRECTION_STATUSES)[number]

/** 方向示例卡（workspace_agent_direction.sampleCards 数组元素） */
export interface WorkspaceAgentSampleCard {
  name: string
  scene: string
}

// ---------------------------------------------------------------------------
// 单卡状态（workspace_agent_card.status；对齐 agent_run_item）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_CARD_STATUSES = [
  "pending", // 排队（等待撰写）
  "drafting", // 文案起草/改写中
  "generating", // 生图中
  "reviewing", // 审核中
  "waiting_human", // 等待人工确认
  "approved_by_ai", // AI 通过（无人工关卡即终态）
  "fallback", // 打回耗尽，自动选历史最优兜底
  "confirmed", // 人工已确认（终态）
  "failed", // 失败（终态）
  "cancelled", // 随工作流取消（终态）
] as const
export type WorkspaceAgentCardStatus =
  (typeof WORKSPACE_AGENT_CARD_STATUSES)[number]

// ---------------------------------------------------------------------------
// 卡类（workspace_agent_card.kind）与锁定（workspace_agent_card.isLocked）
// ---------------------------------------------------------------------------

/**
 * 卡类 = DB 卡片行的交付用途（产品确认四类）。
 * face/back/box/border 生产管线不同（尺寸/模板/评审口径各异），同一生产
 * 批次禁止混类：批量任务在 workspace_agent_job.cardKind 声明卡类，应用层
 * 校验目标卡片 kind 与之一致后才能入队。
 */
export const WORKSPACE_AGENT_CARD_KINDS = [
  "face", // 卡面（常规牌面/内容卡；逐张撰写 + 生图 + 评审）
  "back", // 牌背（成套交付物的统一背面图）
  "box", // 牌盒（盒面主视觉，横版）
  "border", // 卡框（边框素材，交付阶段与卡面叠加）
] as const
export type WorkspaceAgentCardKind =
  (typeof WORKSPACE_AGENT_CARD_KINDS)[number]

// ---------------------------------------------------------------------------
// prompt 来源（workspace_agent_card.promptSource / workspace_agent_round.promptSource）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_PROMPT_SOURCES = [
  "initial", // 初稿
  "auto_revise", // 审核打回后自动改写
  "manual", // 用户手工编辑
  "ai", // 对话式 Agent 改写
  "final", // 终稿
] as const
export type WorkspaceAgentPromptSource =
  (typeof WORKSPACE_AGENT_PROMPT_SOURCES)[number]

// ---------------------------------------------------------------------------
// 预览图（workspace_agent_preview）
// ---------------------------------------------------------------------------

/** 预览用途（kind） */
export const WORKSPACE_AGENT_PREVIEW_KINDS = [
  "style", // 风格小样（风格基准图）
  "direction", // 方向示例图（方向卡片配图）
  "card", // 单卡试生图（确认前预览）
] as const
export type WorkspaceAgentPreviewKind =
  (typeof WORKSPACE_AGENT_PREVIEW_KINDS)[number]

export const WORKSPACE_AGENT_PREVIEW_STATUSES = [
  "pending",
  "generating",
  "completed",
  "failed",
] as const
export type WorkspaceAgentPreviewStatus =
  (typeof WORKSPACE_AGENT_PREVIEW_STATUSES)[number]

// ---------------------------------------------------------------------------
// 审核 / 裁决（workspace_agent_review）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_REVIEW_KINDS = ["review", "verdict"] as const
export type WorkspaceAgentReviewKind =
  (typeof WORKSPACE_AGENT_REVIEW_KINDS)[number]

/** 审核维度（consistency = 与风格基准图/规范书比对，成套一致性） */
export type WorkspaceAgentReviewDimension =
  | "content"
  | "aesthetic"
  | "consistency"

/** 审核结果（workspace_agent_review.result；单维度一条） */
export interface WorkspaceAgentReviewPayload {
  dimension: WorkspaceAgentReviewDimension
  /** 内容维度：是否通过 */
  pass: boolean | null
  /** 审美维度：评分 0-100 */
  score: number | null
  /** 必须给理由：打回时文案改写的唯一依据（ai-card-studio 契约） */
  reason: string
}

/**
 * 单评审员一轮的合并三维结论（review_image 循环落库形状；kind = "review"，
 * nodeKey 携带评审员 id：`review_panel:<chatApiId>`，读取侧按 reviewer 聚合）。
 */
export interface WorkspaceAgentReviewerReviewPayload {
  reviewerId: string
  reviewerName: string | null
  scores: WorkspaceAgentDimensionScores
  /** 违规项 key（text/numerals/border/watermark…；仅信息留档，不参与通过判定） */
  violations: string[]
  reasons: Partial<Record<WorkspaceAgentReviewDimension, string>>
  /** 该评审员口径下的加权总分（0.4 审美 + 0.3 一致性 + 0.3 内容） */
  weightedTotalScore: number | null
}

/** 裁决结果（workspace_agent_review kind = verdict） */
export interface WorkspaceAgentVerdictPayload {
  verdict: "approve" | "retry" | "fallback"
  contentPass: boolean
  aestheticScore: number | null
  consistencyScore: number | null
  roundsUsed: number
  maxRetries: number
  detail: string
  /** review_image 循环扩展（存量行可缺省）：内容维度聚合分 */
  contentScore?: number | null
  /** review_image 循环扩展（存量行可缺省）：加权总分（通过判定的唯一口径） */
  weightedTotalScore?: number | null
  /** review_image 循环扩展（存量行可缺省）：质量及格线（0-100） */
  qualityThreshold?: number | null
}

// ---------------------------------------------------------------------------
// 神谕卡文案（workspace_agent_oracle_copy）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_ORACLE_COPY_STATUSES = [
  "draft", // Agent 草稿（待用户确认）
  "confirmed", // 已定稿
  "outdated", // 用户改写提示词后待重写
] as const
export type WorkspaceAgentOracleCopyStatus =
  (typeof WORKSPACE_AGENT_ORACLE_COPY_STATUSES)[number]

// ---------------------------------------------------------------------------
// 用量（workspace_agent_usage）
// ---------------------------------------------------------------------------

export const WORKSPACE_AGENT_USAGE_KINDS = ["llm", "image"] as const
export type WorkspaceAgentUsageKind =
  (typeof WORKSPACE_AGENT_USAGE_KINDS)[number]

export const WORKSPACE_AGENT_USAGE_STATUSES = [
  "success",
  "failure",
  "timeout",
] as const
export type WorkspaceAgentUsageStatus =
  (typeof WORKSPACE_AGENT_USAGE_STATUSES)[number]

// ---------------------------------------------------------------------------
// 异步任务（workspace_agent_job）
// ---------------------------------------------------------------------------

/**
 * 任务类型（workspace_agent_job.jobType）。
 * 开放集合：新增类型无需迁移（DB 无 check 约束），读取侧按需收敛。
 */
export const WORKSPACE_AGENT_JOB_TYPES = [
  "gen_directions", // 产出候选方向
  "analyze_reference_style", // 从参考图提取艺术风格描述
  "gen_previews", // 生成预览图（风格/方向/单卡）
  "write_prompts", // 批量撰写卡牌提示词
  "write_oracle_copy", // 批量撰写神谕卡文案
  "produce_cards", // 批量生产卡图（sample = 小样；full = 全套）
  "revise_card", // 按审核意见/用户反馈改写单卡
  "regen_image", // 单卡重新生图
  "translate_copy", // 文案翻译（中英）
  "review_image", // 生图终态触发的自动评审（打回循环：评审→改写→重生成→耗尽兜底）
] as const
export type WorkspaceAgentJobType =
  (typeof WORKSPACE_AGENT_JOB_TYPES)[number]

export const WORKSPACE_AGENT_JOB_STATUSES = [
  "queued",
  "processing",
  "completed",
  "failed",
] as const
export type WorkspaceAgentJobStatus =
  (typeof WORKSPACE_AGENT_JOB_STATUSES)[number]

/** 任务入参（workspace_agent_job.payload） */
export interface WorkspaceAgentJobPayload {
  /** 发起来源：用户指令原文 / 自动打回等 */
  reason?: string
  /** 用户反馈（重新生成时携带） */
  feedback?: string
  directionId?: string
  cardIds?: string[]
  /** produce_cards：本轮生产批次（sample = 风格小样；full = 全套） */
  phase?: "sample" | "full"
  locale?: "zh" | "en"
  requestedAt: string
  [key: string]: unknown
}

/** 任务结果（workspace_agent_job.result；按 jobType 自定义） */
export interface WorkspaceAgentJobResult {
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// 运行输入 / 结果结构（jsonb 落库形状）
// ---------------------------------------------------------------------------

/** 用户发起时的质量要求（覆盖平台默认；存 workflow.input.quality） */
export interface WorkspaceAgentQuality {
  /** 内容对齐及格线（0-100，10 分一档） */
  contentThreshold: number
  /** 审美及格线（0-100，10 分一档） */
  aestheticThreshold: number
  /** 成套一致性及格线（0-100，10 分一档） */
  consistencyThreshold: number
  /**
   * 加权总分及格线（0-100）：生图评审循环的唯一通过口径——
   * 总分 = round(0.4×审美 + 0.3×一致性 + 0.3×内容)，仅以总分 ≥ 该线通过，
   * 任何单项不得一票否决。缺省沿用 DEFAULT_REVIEW_THRESHOLD（75）；
   * 存量冻结配置无此字段时读取侧回退默认值（jsonb 免迁移）。
   */
  qualityThreshold?: number
  /** 打回上限（0-3；越高单卡最多生成轮数越多，费用相应增加） */
  maxRetries: number
}

/** 工作流运行输入（workspace_agent_workflow.input） */
export interface WorkspaceAgentInput {
  /** 内容描述（主题/题材/画面内容方向；不含艺术风格） */
  prompt: string
  /** 艺术风格描述（可选；与参考图共同构成风格输入） */
  stylePrompt?: string
  /** 卡牌张数 */
  cardCount: number
  /** 风格参考图 URL（≤4，仅用于提取艺术风格样式；不进入生图请求） */
  referenceImages: string[]
  /** 参考图视觉分析出的艺术风格描述，独立留档并可供用户编辑确认 */
  referenceStyleAnalysis?: string
  /** 参考图风格分析状态；缺省表示尚未请求 */
  referenceStyleAnalysisStatus?: "pending" | "completed" | "failed"
  /** 最近一次参考图风格分析错误（用于向导重试提示） */
  referenceStyleAnalysisError?: string
  /** 质量要求（缺省用平台默认值） */
  quality?: WorkspaceAgentQuality
  /** 用户选择的卡面生图模型（null/缺省 = 平台默认配置） */
  imageModelId?: string | null
  /** 卡面尺寸（"WxH"，取该模型启用预设） */
  imageSize?: string | null
  /** 主控对话模型（chat_api_config id；null/缺省 = 平台默认配置） */
  chatModelId?: string | null
  /** 评审模型（1-3 个支持视觉的对话模型；缺省 = 平台默认配置） */
  reviewerChatModelIds?: string[]
  /**
   * 成套卡牌模板 key（三产品线见 WORKSPACE_AGENT_TEMPLATE_KEYS；
   * 缺省 = 自由张数模式，不套模板骨架）。
   */
  templateKey?: WorkspaceAgentTemplateKey | null
}

/** 生图候选（workspace_agent_round.candidates 数组元素；多候选评分选优留档） */
export interface WorkspaceAgentCandidate {
  url: string
  /** 审美评分（0-100；未评分为 null） */
  score: number | null
  /** 内容对齐是否通过（未评为 null） */
  contentPass: boolean | null
}

// ---------------------------------------------------------------------------
// 成套卡牌模板（模板 key / 骨架 / 元数据；模板数据与纯函数在 ./agent-templates）
// ---------------------------------------------------------------------------

/**
 * 模板 key = 产品线 + 成品张数（牌面 + 套件交付物，逐张入骨架）：
 * - tarot81：塔罗 81 = 78 牌面（22 大阿卡纳 + 56 小阿卡纳）+ 牌背 + 边框 + 牌盒（3/4 视图）；
 * - poker58：扑克 58 = 54 标准牌（4 花色 × 13 + 大小王）+ 替换牌面 + 牌背 + 边框 + 牌盒；
 * - oracle58：神谕 58 = 55 牌面（5 组 × 11 位置）+ 牌背 + 边框 + 牌盒。
 */
export const WORKSPACE_AGENT_TEMPLATE_KEYS = [
  "tarot81",
  "poker58",
  "oracle58",
] as const
export type WorkspaceAgentTemplateKey = (typeof WORKSPACE_AGENT_TEMPLATE_KEYS)[number]

/**
 * 模板卡片类型（骨架判别字段；与上面的 WorkspaceAgentCardKind 是两层概念：
 * 那个是 DB 卡片行的交付用途 face/back/box/border，这个是模板骨架的牌面语义
 * + 套件交付物）：
 * - tarot81：major / number / court + back / border / box；
 * - poker58：number / court / joker + replacement / back / border / box；
 * - oracle58：position + back / border / box。
 */
export const WORKSPACE_AGENT_TEMPLATE_CARD_KINDS = [
  "major", // 塔罗 · 大阿卡纳（22）
  "number", // 塔罗王牌-十 / 扑克 A、2-10（点数牌，带数量硬规则）
  "court", // 塔罗侍从-国王 / 扑克 J-Q-K（人物牌）
  "joker", // 扑克大小王
  "position", // 神谕组内位置牌（5 组 × 11 位置）
  "back", // 套件 · 牌背（整副一份）
  "border", // 套件 · 卡牌边框（整副一份，交付阶段叠加）
  "box", // 套件 · 牌盒（整副一份；塔罗为 3/4 视图）
  "replacement", // 套件 · 替换牌面（扑克印制备用，与标准牌面同规格）
] as const
export type WorkspaceAgentTemplateCardKind =
  (typeof WORKSPACE_AGENT_TEMPLATE_CARD_KINDS)[number]

/** 模板元数据（模板选择 / workflow 详情头用） */
export interface WorkspaceAgentTemplateMeta {
  key: WorkspaceAgentTemplateKey
  name: string
  description: string
  /** 成品张数（牌面 + 套件交付物；与骨架长度一致） */
  cardCount: number
  /** 套件交付物张数（牌背/边框/牌盒/替换牌面，不参与牌面语义与数量规则） */
  kitCount: number
}

/**
 * 卡片骨架基类（具体模板的结构化收窄在 ./agent-templates 声明，
 * 如塔罗的 arcana/suit/rank、扑克的花色点数、神谕的组/位置）。
 */
export interface WorkspaceAgentCardSkeleton {
  /** 全套序号（0 起，与模板出牌顺序严格一致；落库到 workspace_agent_card.cardIndex） */
  index: number
  /** 模板内稳定 key（ASCII；导入导出 / CSV 对账 / 事件留痕关联用） */
  key: string
  /** 展示名（如「愚者」「黑桃A」「组一 · 启程」） */
  name: string
  /** 骨架一句话提示（文案撰写与审核的语义锚点） */
  hint: string
  kind: WorkspaceAgentTemplateCardKind
}

/** 模板（meta + 骨架；注册表与查找函数见 ./agent-templates） */
export interface WorkspaceAgentTemplate {
  meta: WorkspaceAgentTemplateMeta
  cards: readonly WorkspaceAgentCardSkeleton[]
}

// ---------------------------------------------------------------------------
// 模板阶段（四阶段推进游标；命名对齐 @/lib/agent/graph 的模板阶段）
// ---------------------------------------------------------------------------

/**
 * 模板阶段：需求澄清（方向候选/选定 + 风格规范书）→ 卡面提示词（逐张撰写，
 * 用户可编辑，确认后直达生图）→ 生图评审（加权聚合 + 打回重写循环）→
 * 交付（终审确认与定稿回写 prompt_card）。
 */
export const WORKSPACE_AGENT_STAGES = [
  "clarify", // 需求澄清（方向候选/选定；workflow 级，不落单卡状态）
  "draft", // 卡面提示词（逐张撰写画面内容 + 神谕卡文案）
  "art", // 生图与评审（多评审员加权聚合；不通过按意见重写）
  "compose", // 交付（终审等待 / 确认定稿 / 套件交付物装配）
] as const
export type WorkspaceAgentStage = (typeof WORKSPACE_AGENT_STAGES)[number]

/** 阶段展示状态（阶段条着色：locked 未到 / active 进行中 / done 已完成） */
export type WorkspaceAgentStageStatus = "locked" | "active" | "done"

// ---------------------------------------------------------------------------
// 四类尺寸（卡面 / 牌背 / 边框 / 牌盒；value = "WxH"，与模型尺寸预设同格式）
// ---------------------------------------------------------------------------

/**
 * 尺寸类别（套件资产一律延用卡面比例，不逐资产另配）：
 * card 卡面（逐张生图主尺寸）/ back 牌背 / border 卡牌边框（与卡面同比例，
 * 交付阶段叠加）/ box 牌盒（横版盒面主视觉）。
 */
export const WORKSPACE_AGENT_SIZE_KINDS = ["card", "back", "border", "box"] as const
export type WorkspaceAgentSizeKind = (typeof WORKSPACE_AGENT_SIZE_KINDS)[number]

export type WorkspaceAgentTemplateSizes = Record<WorkspaceAgentSizeKind, string>

// ---------------------------------------------------------------------------
// 评审聚合 / 评审记录（多评审员加权聚合的输入输出形状见 ./agent-templates）
// ---------------------------------------------------------------------------

/** 三维度得分；null = 该维度未评分 */
export interface WorkspaceAgentDimensionScores {
  content: number | null
  aesthetic: number | null
  consistency: number | null
}

/** 总控裁决（纯规则：approve 放行 / retry 打回 / fallback 耗尽兜底） */
export const WORKSPACE_AGENT_VERDICTS = ["approve", "retry", "fallback"] as const
export type WorkspaceAgentVerdict = (typeof WORKSPACE_AGENT_VERDICTS)[number]

/**
 * 评审记录（同一评审员对同卡同轮的三维合并展示形状；落库按维度拆行存
 * workspace_agent_review kind = "review"，读取侧按 reviewer + round 聚合成本形状）。
 */
export interface WorkspaceAgentReviewRecord {
  id: string
  workflowId: string
  cardId: string
  roundNumber: number
  /** 评审员（chat_api_config id + 展示名） */
  reviewerId: string
  reviewerName: string | null
  scores: WorkspaceAgentDimensionScores
  /** 内容维度结论（数值分见 scores.content）；展示侧可缺省——通过与否只看加权总分 */
  contentPass?: boolean
  /** 违规项 key（text/numerals/border/watermark…；文案映射沿用 agent 域词表） */
  violations: string[]
  /** 该评审员结论（多数评审员无裁决权，为 null；总控裁决单独落 verdict 行） */
  verdict: WorkspaceAgentVerdict | null
  /** 必填理由：打回时文案改写的唯一依据（ai-card-studio 契约） */
  reason: string
  /** ISO 时间 */
  createdAt: string
}

// ---------------------------------------------------------------------------
// 冻结配置（发起时快照；此后模板/平台默认值变更不影响进行中的 workflow）
// ---------------------------------------------------------------------------

/**
 * 冻结配置（workflow 发起时由模板默认值 + 用户选择合成，随 input 落 jsonb；
 * 纯函数构建器与钳制范围见 ./agent-templates.buildFrozenConfig）。
 */
export interface WorkspaceAgentFrozenConfig {
  templateKey: WorkspaceAgentTemplateKey
  /** 成品张数（含附加卡；来自发起时的模板骨架长度） */
  cardCount: number
  /** 质量要求（三维及格线 + 打回上限；默认 75/2） */
  quality: WorkspaceAgentQuality
  /** 四类尺寸（卡面/牌背/边框/牌盒） */
  sizes: WorkspaceAgentTemplateSizes
  /** 冻结时间（ISO；发起动作发生时刻） */
  frozenAt: string
}

// ---------------------------------------------------------------------------
// 进度 / 统计（workflow 详情头、阶段条与交付总览共用）
// ---------------------------------------------------------------------------

/** 阶段进度（total = 0 表示该阶段无逐卡单元，如 clarify 为 workflow 级） */
export interface WorkspaceAgentStageProgress {
  stage: WorkspaceAgentStage
  total: number
  completed: number
  failed: number
  inFlight: number
}

/** workflow 进度快照（轮询载荷；stages 顺序与 WORKSPACE_AGENT_STAGES 一致） */
export interface WorkspaceAgentRunProgress {
  currentStage: WorkspaceAgentStage
  stages: WorkspaceAgentStageProgress[]
  updatedAt: string | null
}

/** 整副统计（交付总览 / 验收报表） */
export interface WorkspaceAgentDeckStats {
  templateKey: WorkspaceAgentTemplateKey
  cardCount: number
  /** 已过审（approved_by_ai）张数 */
  completed: number
  failed: number
  /** 兜底放行（fallback）张数 */
  fallback: number
  /** 至少经历一次打回的卡片数 */
  retriedCards: number
  /** 打回总轮次（所有卡累计） */
  totalRetries: number
  /** 过审率（0-1；completed / cardCount，cardCount = 0 时为 0） */
  passRate: number
  /** 三维度均分（null = 尚无任何已评卡片） */
  averageScores: WorkspaceAgentDimensionScores
  /** 按模板卡片类型的张数分布（骨架 kind 计数） */
  kindCounts: Partial<Record<WorkspaceAgentTemplateCardKind, number>>
}

// ---------------------------------------------------------------------------
// 角色状态（团队看板 / 阶段条旁的角色脉搏）
// ---------------------------------------------------------------------------

/**
 * 固定编制（七角色；命名对齐 @/lib/agent/templates 的模板编制）：
 * creative_director 创意总监 / style_director 风格策划 / prompt_designer
 * 提示词设计师 / artist 画师 / review_panel 评审团 / compositor 合成师 /
 * supervisor 总控。
 */
export const WORKSPACE_AGENT_ROLE_IDS = [
  "creative_director",
  "style_director",
  "prompt_designer",
  "artist",
  "review_panel",
  "compositor",
  "supervisor",
] as const
export type WorkspaceAgentRoleId = (typeof WORKSPACE_AGENT_ROLE_IDS)[number]

export const WORKSPACE_AGENT_ROLE_STATUSES = [
  "idle", // 空闲（未到参与阶段或当前无任务）
  "active", // 执行中
  "waiting", // 等待输入（评审团等生图、总监等用户答复）
  "done", // 本 workflow 职责完成
  "failed", // 执行出错（可重试）
] as const
export type WorkspaceAgentRoleStatus = (typeof WORKSPACE_AGENT_ROLE_STATUSES)[number]

/** 角色运行时状态（团队看板一行；由进度事件推导，不直接落库） */
export interface WorkspaceAgentRoleState {
  roleId: WorkspaceAgentRoleId
  status: WorkspaceAgentRoleStatus
  /** 当前处理卡片（workspace_agent_card.id；null = 无逐卡任务在身） */
  currentCardId: string | null
  /** 已完成单元数（卡 / 资产 / 裁决，按角色口径） */
  completedUnits: number
  /** ISO 时间；null = 尚未活动 */
  updatedAt: string | null
}
