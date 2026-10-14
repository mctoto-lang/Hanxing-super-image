/**
 * 工作台 Agent 模板服务端薄适配（canonical 注册表见 @/lib/workspace/agent-templates）
 *
 * 模板数据、默认阈值/尺寸、冻结配置构建与阶段状态映射的单一事实来源是
 * @/lib/workspace/agent-templates（纯数据 + 纯函数，可进客户端 bundle）。
 * 本文件只补服务端侧的小适配：key 校验、canonical 查找的非空包装、
 * 骨架语义 → 交付卡类（workspace_agent_card.kind）映射与阈值步进校验，
 * 避免重复声明任何模板骨架。
 */
import {
  WORKSPACE_AGENT_TEMPLATE_KEYS,
  type WorkspaceAgentCardKind,
  type WorkspaceAgentCardSkeleton,
  type WorkspaceAgentTemplateKey,
} from "@/lib/workspace/agent-types"
import { getWorkspaceAgentTemplate as getTemplate } from "@/lib/workspace/agent-templates"

export {
  buildFrozenConfig,
  defaultQuality,
  DEFAULT_TEMPLATE_SIZES,
  DEFAULT_REVIEW_THRESHOLD,
  DEFAULT_MAX_RETRIES,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  MAX_RETRIES_MIN,
  MAX_RETRIES_MAX,
  listWorkspaceAgentTemplateMetas,
  promptWritingRulesFor,
  templateCardCount,
  templateSizeOf,
} from "@/lib/workspace/agent-templates"

export function isWorkspaceAgentTemplateKey(value: unknown): value is WorkspaceAgentTemplateKey {
  return (
    typeof value === "string" &&
    (WORKSPACE_AGENT_TEMPLATE_KEYS as readonly string[]).includes(value)
  )
}

/** 取模板（meta + 骨架）；未注册抛错（action 层已先行校验 key） */
export function requireWorkspaceAgentTemplate(key: WorkspaceAgentTemplateKey) {
  const template = getTemplate(key)
  if (!template) throw new Error(`未注册的工作台 Agent 模板：${key}`)
  return template
}

/** 骨架是否为牌面卡（参与牌面语义与数量规则；牌背/边框/牌盒套件不参与） */
export function isFaceCard(skeleton: WorkspaceAgentCardSkeleton): boolean {
  return skeleton.kind !== "back" && skeleton.kind !== "border" && skeleton.kind !== "box"
}

/**
 * 骨架语义 → 交付卡类（workspace_agent_card.kind）映射：
 * back → back（牌背）/ border → border（卡框）/ box → box（牌盒）；
 * 牌面与替换牌面 → face（替换牌面与标准牌面同规格，共用卡面管线）。
 */
export function skeletonKindToCardKind(skeleton: WorkspaceAgentCardSkeleton): WorkspaceAgentCardKind {
  switch (skeleton.kind) {
    case "back":
      return "back"
    case "border":
      return "border"
    case "box":
      return "box"
    default:
      return "face"
  }
}

// ---------------------------------------------------------------------------
// 发起表单校验（create action 与发起弹窗共用口径）
// ---------------------------------------------------------------------------

/** 质量阈值合法：40-95（canonical THRESHOLD_MIN/MAX）且 5 的倍数 */
export function isValidThresholdValue(value: number): boolean {
  return (
    Number.isInteger(value) && value >= 40 && value <= 95 && value % 5 === 0
  )
}

/** 打回上限合法：1-3（canonical MAX_RETRIES_MIN/MAX 收窄为 1 起，UI 同口径） */
export function isValidMaxRetriesValue(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 3
}

/** 尺寸值合法："WxH" */
export function isValidSizeValue(value: unknown): value is string {
  return typeof value === "string" && /^\d{2,5}x\d{2,5}$/.test(value)
}
