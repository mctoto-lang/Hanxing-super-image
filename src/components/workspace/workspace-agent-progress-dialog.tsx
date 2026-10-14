"use client"

/**
 * 工作台 · 智能体执行进度弹窗（受控 Dialog）
 *
 * 固定窗口高度（85vh）：标题固定，内容区内部滚动下滑查看更多。
 * 上半部为 3D 车间风格 BuildPipeline 展示严格四阶段流程（主题选择 →
 * 想象力程度 → 落地方向 → 提示词撰写）与各阶段日志（执行状态由流水线
 * 自身的站点状态色与运行状态统计卡呈现）；下方为参考 AgentPlanning 模板
 * 实现的「工作流向导」折叠区（点击展开完整交互向导，时间线亦为模板样式，
 * 默认收起，创建任务时自动展开）。
 *
 * stages 入参宽松：按顺序合并到固定四阶段上，缺失的补默认待命。阶段数据
 * 由父级（Agent 进度轮询视图）下发；向导区（WorkspaceAgentFlowTimeline）
 * 自行按 taskId 轮询，折叠收起即卸载停止轮询。
 */
import { useMemo } from "react"
import {
  Activity,
  Bot,
  Compass,
  Lightbulb,
  PenLine,
  Sparkles,
} from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { BuildPipeline, type PipelineStage } from "@/components/ui/build-pipeline"
import { AgentPlanning } from "@/components/ui/agent-planning"
import { WorkspaceAgentFlowTimeline } from "@/components/workspace/workspace-agent-flow-timeline"

/** 固定四阶段编制（严格阶段标题 + 语义图标；id 对齐 WORKSPACE_AGENT_STAGES） */
const DEFAULT_STAGES: PipelineStage[] = [
  { id: "clarify", name: "主题选择", icon: Lightbulb, status: "queued", logs: [] },
  { id: "draft", name: "想象力程度", icon: Sparkles, status: "queued", logs: [] },
  { id: "art", name: "落地方向", icon: Compass, status: "queued", logs: [] },
  { id: "compose", name: "提示词撰写", icon: PenLine, status: "queued", logs: [] },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 阶段数据（含状态与日志）；缺省/缺项按固定四阶段补「排队中」 */
  stages?: readonly PipelineStage[] | null
  /** 上下文条片段（如 任务标题 / 模板名 / #工作流ID） */
  context?: readonly string[]
  /** 工作流开始时间（ISO；页脚展示） */
  startedAt?: string | null
  /** 挂靠的工作台任务 id（向导区按此轮询；非 Agent 任务传 null） */
  taskId?: string | null
  /** 初建任务自动打开时置 true：向导区自动展开并从风格确认步骤开始 */
  startAtStyle?: boolean
}

export function WorkspaceAgentProgressDialog({
  open,
  onOpenChange,
  stages,
  context,
  startedAt,
  taskId,
  startAtStyle = false,
}: Props) {
  // 严格四阶段：按序合并入参（多出忽略、缺失补默认待命）
  const merged = useMemo(
    () =>
      DEFAULT_STAGES.map((def, index) => {
        const input = stages?.[index]
        return input
          ? {
              ...def,
              ...input,
              icon: input.icon ?? def.icon,
              logs: input.logs ?? [],
            }
          : def
      }),
    [stages],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 固定窗口高度：覆盖基类 grid/overflow/padding，头部固定 + 内容区滚动 */}
      <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-y-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 pb-3 pt-4 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-4 text-violet-500" />
            智能体执行进度
          </DialogTitle>
        </DialogHeader>

        {/* 滚动内容区：下滑查看更多（隐藏滚动条） */}
        <div className="scrollbar-hide min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <BuildPipeline
            stages={merged}
            title="四阶段流水线"
            subtitle="主题选择 → 想象力程度 → 落地方向 → 提示词撰写"
            context={context}
            startedAt={startedAt}
          />

          <AgentPlanning
            title="工作流向导"
            defaultExpanded={startAtStyle}
            headerIcon={<Bot className="size-4 text-violet-500" />}
            className="my-0 max-w-none"
          >
            <WorkspaceAgentFlowTimeline
              taskId={taskId ?? null}
              startAtStyle={startAtStyle}
            />
          </AgentPlanning>
        </div>
      </DialogContent>
    </Dialog>
  )
}
