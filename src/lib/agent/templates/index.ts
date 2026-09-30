/**
 * 卡牌模板注册表（Deck Template Registry · 纯数据 + 纯函数，零运行时依赖）
 *
 * 模板 = 一条产品线的完整创作规格：元数据 + 五阶段流程 + 角色编制 +
 * 交付物清单 + 澄清清单 + 提示词守则 + 卡牌骨架。通用类型统一在本文件
 * 声明，具体模板数据在各自文件提供（当前仅 ./tarot）；新增方向（oracle /
 * poker）时建对应模板文件并在 DECK_TEMPLATES 注册即可，不改既有文件。
 *
 * 与既有系统的关系（只读复用，不反向修改）：
 * - meta.key 复用 graph.AgentDirection；角色映射 graph.AgentRole / AgentNodeType；
 * - 卡牌骨架复用 pipelines.tarotSkeleton()，顺序与牌名严格一致。
 *
 * 消费方式：统一从本入口导入（@/lib/agent/templates），不直达具体模板文件。
 */
import type { AgentDirection, AgentNodeType } from "../graph"
import { TAROT_TEMPLATE } from "./tarot"

export * from "./tarot"

// ---------------------------------------------------------------------------
// 通用类型（各方向模板共用；具体模板在各自文件做字面量收窄）
// ---------------------------------------------------------------------------

/** 模板元数据 */
export interface DeckTemplateMeta {
  /** 模板 key（与 graph.AgentDirection 对齐，按方向查注册表） */
  key: AgentDirection
  name: string
  version: string
  description: string
  /** 成品卡张数（不含边框/牌背/牌盒等套件资产） */
  cardCount: number
  /** 小样代表卡序号（两阶段模式先跑这几张确认风格） */
  sampleIndexes: number[]
}

/** 流程阶段（当前固定五段） */
export interface DeckTemplateStage {
  id: string
  /** 展示顺序（1 起） */
  order: number
  name: string
  /** 阶段目标（一句话） */
  goal: string
  /** 参与角色 id */
  roleIds: string[]
  /** 输入（用户输入或上游产物） */
  inputs: string[]
  /** 输出产物 */
  outputs: string[]
  /** 进入下一阶段前必须满足的门槛 */
  exitCriteria: string[]
}

/** 角色编制分组（策划 / 制作 / 质检 / 交付 / 总控） */
export type DeckTemplateRoleGroup = "planning" | "production" | "qa" | "delivery" | "control"

export interface DeckTemplateRole {
  id: string
  name: string
  group: DeckTemplateRoleGroup
  /** 一行职责 */
  duty: string
  /** 角色提示词（system prompt；引擎会追加输出格式指令） */
  systemPrompt: string
  /** 对应 graph.ts 节点类型；null = 暂无对应执行节点（如合成师） */
  engineNodeType: AgentNodeType | null
  /** 对应 graph.ts 流水线角色（style/structure/copywriter）；null = 无 */
  engineRole: string | null
}

/** 交付物类型（逐卡成品 1 种 + 套件资产 6 种） */
export type DeliverableKind =
  | "card" // 成品卡牌面（逐张 × cardCount）
  | "card_border" // 卡牌边框
  | "back" // 牌背
  | "box_front" // 牌盒正面
  | "box_back" // 牌盒背面
  | "box_side" // 牌盒侧面
  | "box_top" // 牌盒顶面

export interface DeckTemplateDeliverable {
  kind: DeliverableKind
  name: string
  description: string
  /** 交付数量（卡 = cardCount，套件资产 = 1） */
  count: number
  /** 责任阶段 id（该交付物在此阶段进入交付清单） */
  stageId: string
  /** 是否逐张随卡生成 */
  perCard: boolean
  /** 验收要点（合成/交付核对用） */
  acceptance: string
}

/** 澄清问题（需求澄清阶段逐条向用户确认） */
export interface ClarificationQuestion {
  id: string
  question: string
  /** 该答案影响哪些下游决策（为什么必须问） */
  why: string
  /** 必答项：未答不可进入下一阶段 */
  required: boolean
  /** 快捷选项；空数组 = 自由文本 */
  options: string[]
  /** 用户未答复时采用的默认取向 */
  fallback: string
}

export interface ClarificationSection {
  id: string
  title: string
  questions: ClarificationQuestion[]
}

/** 卡面提示词守则（负面禁令 + 可直接拼接的负面提示词片段） */
export interface PromptGuardrail {
  id: string
  /** 规则原文（写进角色提示词） */
  rule: string
  /** 违反后果说明（给 agent 解释为什么） */
  reason: string
  /** 生图负面提示词片段 */
  negativePrompt: string
}

/** 套件资产（边框/牌背/牌盒）提示词规则 */
export interface AssetPromptRule {
  deliverableKind: DeliverableKind
  /** 资产提示词写作规则（逐条） */
  rules: string[]
  /** 提示词骨架；{style} = 风格规范书要点占位 */
  promptTemplate: string
  /** 该资产的专属负面提示词 */
  negativePrompt: string
}

/** 卡牌骨架基类（具体模板扩展结构化字段，如塔罗的 arcana/suit/rank） */
export interface DeckCardSkeleton {
  /** 全套序号（0 起，顺序与 pipelines.tarotSkeleton 一致） */
  index: number
  name: string
  /** 原骨架一句话提示 */
  hint: string
}

/** 模板（一条产品线的完整创作规格） */
export interface DeckTemplate {
  meta: DeckTemplateMeta
  stages: DeckTemplateStage[]
  roles: DeckTemplateRole[]
  deliverables: DeckTemplateDeliverable[]
  clarification: ClarificationSection[]
  guardrails: PromptGuardrail[]
  assetRules: AssetPromptRule[]
  cards: DeckCardSkeleton[]
}

// ---------------------------------------------------------------------------
// 注册表与查找
// ---------------------------------------------------------------------------

/** 已注册模板（新增方向在此追加） */
export const DECK_TEMPLATES: readonly DeckTemplate[] = [TAROT_TEMPLATE]

/** 按方向查模板；尚未注册的方向（如 oracle / poker）返回 null */
export function getDeckTemplate(direction: AgentDirection): DeckTemplate | null {
  return DECK_TEMPLATES.find((t) => t.meta.key === direction) ?? null
}

/** 已注册模板的元数据列表（模板选择页用） */
export function listDeckTemplateMetas(): DeckTemplateMeta[] {
  return DECK_TEMPLATES.map((t) => t.meta)
}

/** 模板交付物总件数（塔罗 = 78 卡 + 6 套件资产 = 84） */
export function totalDeliverableCount(template: DeckTemplate): number {
  return template.deliverables.reduce((sum, d) => sum + d.count, 0)
}
