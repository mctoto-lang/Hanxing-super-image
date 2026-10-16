/**
 * 工作台 Agent workflow.input 的服务端扩展读取
 *
 * workspace_agent_workflow.input 落库形状是共享契约 WorkspaceAgentInput
 * （@/lib/workspace/agent-types，禁止在本域重复声明）。发起后的流程游标
 * （冻结配置/想象力档位/主题批次/风格确认时间）作为扩展字段随同一 jsonb
 * 落库：写入时以扩展对象赋给 input 列（结构兼容，超集可赋值）；读取时用
 * readWorkflowInput 收窄回扩展类型。扩展字段名即落库事实，改名需迁移数据。
 */
import type {
  WorkspaceAgentFrozenConfig,
  WorkspaceAgentInput,
} from "@/lib/workspace/agent-types"
import { DEFAULT_REVIEW_THRESHOLD } from "@/lib/workspace/agent-templates"

/** 想象力档位（选想象力步骤；三档措辞见 run.ts 的 IMAGINATION_PROMPTS） */
export const WORKSPACE_AGENT_IMAGINATION_LEVELS = [
  "conservative",
  "balanced",
  "bold",
] as const
export type WorkspaceAgentImaginationLevel =
  (typeof WORKSPACE_AGENT_IMAGINATION_LEVELS)[number]

export function isWorkspaceAgentImaginationLevel(
  value: unknown,
): value is WorkspaceAgentImaginationLevel {
  return (
    typeof value === "string" &&
    (WORKSPACE_AGENT_IMAGINATION_LEVELS as readonly string[]).includes(value)
  )
}

/** input 列的服务端扩展形状（jsonb 超集，随 input 落库） */
export interface WorkspaceAgentInputExt extends WorkspaceAgentInput {
  /** 发起时冻结配置（模板默认 + 用户选择快照） */
  frozenConfig?: WorkspaceAgentFrozenConfig
  /** 想象力档位（选主题后、生成方向前选定） */
  imaginationLevel?: WorkspaceAgentImaginationLevel
  /** 第一轮（主题）批次的方向 id 留档：区分主题行与第二轮方向行 */
  themeDirectionIds?: string[]
  /** 第二轮（创作方向）批次的方向 id 留档：回退到落地方向时按批恢复候选 */
  directionBatchIds?: string[]
  /** 回退到主题选择时记录的原选中主题 id（UI 显示「上次选择」徽标） */
  lastSelectedThemeId?: string
  /** 回退到落地方向时记录的原选中方向 id（UI 显示「上次选择」徽标） */
  lastSelectedDirectionId?: string
  /** 回退次数（单调递增；前端据此把视图步骤跟随服务端推导回跳） */
  rollbackCount?: number
  /** 风格确认时间（ISO；确认后才触发主题生成） */
  styleConfirmedAt?: string
}

export function readWorkflowInput(
  workflow: { input: WorkspaceAgentInput },
): WorkspaceAgentInputExt {
  return workflow.input as WorkspaceAgentInputExt
}

/**
 * 读阈值辅助（frozenConfig 优先，回退 input.quality / 平台默认 75）。
 * qualityThreshold 为生图评审循环的唯一通过口径（加权总分 ≥ 该线），
 * 存量冻结配置缺省该字段时回退 DEFAULT_REVIEW_THRESHOLD（75）。
 */
export function readQualityThresholds(input: WorkspaceAgentInputExt): {
  contentThreshold: number
  aestheticThreshold: number
  consistencyThreshold: number
  qualityThreshold: number
  maxRetries: number
} {
  return {
    contentThreshold: input.frozenConfig?.quality.contentThreshold ?? input.quality?.contentThreshold ?? 75,
    aestheticThreshold: input.frozenConfig?.quality.aestheticThreshold ?? input.quality?.aestheticThreshold ?? 75,
    consistencyThreshold: input.frozenConfig?.quality.consistencyThreshold ?? input.quality?.consistencyThreshold ?? 75,
    qualityThreshold:
      input.frozenConfig?.quality.qualityThreshold ??
      input.quality?.qualityThreshold ??
      DEFAULT_REVIEW_THRESHOLD,
    maxRetries: input.frozenConfig?.quality.maxRetries ?? input.quality?.maxRetries ?? 2,
  }
}
