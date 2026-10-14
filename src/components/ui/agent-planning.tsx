"use client"

/**
 * AgentPlanning · 折叠式规划时间线卡片（通用 ui 组件）
 *
 * 参考 AI 规划面板模板落地：卡片头部（状态图标 + 标题 + 折叠箭头）点击
 * 展开/收起，展开区为纵向步骤时间线（每步可再点开查看内容）。
 * - 传 steps：按 PlanStep[] 渲染步骤时间线（success/active/error/pending 状态色）；
 * - 传 children：展开区改渲染自定义内容（如内嵌交互向导）；
 * - 折叠过渡播完后卸载展开区内容，避免隐藏期间保留轮询等副作用；
 * - headerIcon 覆盖头部状态图标（缺省按 steps 推导）。
 * 动画类依赖 tw-animate-css（animate-in / fade-in / slide-in-from-top-*）。
 */
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react"

import { cn } from "@/lib/utils"

export type PlanStepStatus = "pending" | "active" | "success" | "error"

export interface PlanStep {
  id: string
  title: string
  content?: ReactNode
  status: PlanStepStatus
  icon?: ReactNode
  duration?: string
  defaultExpanded?: boolean
}

export interface AgentPlanningProps {
  title?: string
  steps?: PlanStep[]
  /** 初始是否展开（默认 true） */
  defaultExpanded?: boolean
  /** 头部状态图标（缺省按 steps 推导：进行中 spinner / 全部完成 check / 其余 BrainCircuit） */
  headerIcon?: ReactNode
  /** 展开区自定义内容（提供时替代 steps 时间线渲染） */
  children?: ReactNode
  className?: string
}

/** 收起过渡时长（ms），播完后卸载展开区内容 */
const COLLAPSE_UNMOUNT_DELAY = 500

/** 步骤状态 → 圆底配色（模板样式；导出供向导时间线等组件复用同一视觉） */
export const PLAN_STEP_STATUS_CIRCLE_CLASS: Record<PlanStepStatus, string> = {
  success:
    "bg-emerald-100 text-emerald-600 ring-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-400",
  active:
    "bg-blue-100 text-blue-600 ring-blue-500/30 dark:bg-blue-500/20 dark:text-blue-400",
  error:
    "bg-rose-100 text-rose-600 ring-rose-500/20 dark:bg-rose-500/20 dark:text-rose-400",
  pending:
    "bg-secondary text-muted-foreground ring-border/50 dark:bg-secondary/50",
}

export function AgentPlanning({
  title = "Agent is planning",
  steps = [],
  defaultExpanded = true,
  headerIcon,
  children,
  className,
}: AgentPlanningProps) {
  const [isMainExpanded, setIsMainExpanded] = useState(defaultExpanded)
  // 展开区内容是否保持挂载（收起动画结束后卸载）
  const [shouldRenderContent, setShouldRenderContent] = useState(defaultExpanded)
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 单个步骤的展开态（仅 steps 模式；初始值取各步 defaultExpanded）
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>(() =>
    steps.reduce((acc, step) => {
      acc[step.id] = step.defaultExpanded || false
      return acc
    }, {} as Record<string, boolean>),
  )

  // 上面 useState 初始化器仅首次挂载执行：挂载后新增的步骤（如轮询推进
  // 产生的步骤）不在 expandedSteps 中，渲染取 undefined → 恒折叠，
  // defaultExpanded 被静默忽略。在此为新增 id 补初始化；
  // 既有 id（含用户已手动展开/折叠的）不覆盖。
  useEffect(() => {
    setExpandedSteps((prev) => {
      const added = steps.filter((step) => !(step.id in prev))
      if (added.length === 0) return prev
      return added.reduce(
        (acc, step) => {
          acc[step.id] = step.defaultExpanded || false
          return acc
        },
        { ...prev },
      )
    })
  }, [steps])

  useEffect(
    () => () => {
      if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current)
    },
    [],
  )

  const toggleMain = () => {
    if (unmountTimerRef.current) {
      clearTimeout(unmountTimerRef.current)
      unmountTimerRef.current = null
    }
    if (isMainExpanded) {
      setIsMainExpanded(false)
      // 等收起过渡播完再卸载内容
      unmountTimerRef.current = setTimeout(
        () => setShouldRenderContent(false),
        COLLAPSE_UNMOUNT_DELAY,
      )
    } else {
      setShouldRenderContent(true)
      setIsMainExpanded(true)
    }
  }

  const toggleStep = (id: string, e: MouseEvent) => {
    e.stopPropagation()
    setExpandedSteps((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const hasActive = steps.some((s) => s.status === "active")
  const allSuccess = steps.length > 0 && steps.every((s) => s.status === "success")

  const getStatusColor = (status: PlanStepStatus) =>
    PLAN_STEP_STATUS_CIRCLE_CLASS[status]

  return (
    <div
      className={cn(
        "mx-auto my-4 w-full max-w-2xl font-sans text-foreground",
        className,
      )}
    >
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all duration-300">
        {/* 头部（点击折叠/展开） */}
        <div
          onClick={toggleMain}
          className={cn(
            "flex cursor-pointer select-none items-center justify-between px-4 py-3.5 transition-colors",
            isMainExpanded
              ? "border-b border-border/50 bg-secondary/30"
              : "hover:bg-secondary/30",
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 items-center justify-center">
              {headerIcon != null ? (
                headerIcon
              ) : hasActive ? (
                <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
              ) : allSuccess ? (
                <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <BrainCircuit className="h-4 w-4 text-muted-foreground" />
              )}
            </div>

            <span className="text-[15px] font-semibold tracking-tight text-foreground/90">
              {title}
            </span>
          </div>

          <div className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary">
            {isMainExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
        </div>

        {/* 展开区（grid-rows 过渡高度） */}
        <div
          className={cn(
            "grid bg-card transition-all duration-500 ease-in-out",
            isMainExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col p-5">
              {children != null
                ? shouldRenderContent && children
                : shouldRenderContent &&
                  steps.map((step, index) => {
                    const isStepExpanded = expandedSteps[step.id]
                    const isLast = index === steps.length - 1

                    return (
                      <div
                        key={step.id}
                        className={cn(
                          "relative flex animate-in fade-in slide-in-from-top-4 fill-mode-both duration-500 gap-4",
                          step.status === "pending"
                            ? "opacity-60 grayscale"
                            : "opacity-100",
                        )}
                        style={{ animationDelay: `${index * 80}ms` }}
                      >
                        {/* 时间线连接线 */}
                        {!isLast && (
                          <div className="absolute bottom-[-10px] left-[11px] top-7 z-0 w-[2px] bg-border/60" />
                        )}

                        {/* 图标列 */}
                        <div className="relative z-10 mt-0.5 h-6 w-6 flex-none">
                          <div
                            className={cn(
                              "flex h-full w-full items-center justify-center rounded-full ring-4 ring-card transition-colors duration-300",
                              getStatusColor(step.status),
                            )}
                          >
                            {step.status === "success" ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : step.status === "active" ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              step.icon || (
                                <div className="h-1.5 w-1.5 rounded-full bg-current" />
                              )
                            )}
                          </div>
                        </div>

                        {/* 内容列 */}
                        <div className="flex-1 pb-6">
                          <div
                            className={cn(
                              "group -mx-2 flex items-center justify-between rounded-md px-2 py-1 transition-colors",
                              step.content ? "cursor-pointer hover:bg-secondary/50" : "",
                            )}
                            onClick={(e) => step.content && toggleStep(step.id, e)}
                          >
                            <span
                              className={cn(
                                "text-sm tracking-tight transition-colors duration-200",
                                step.status === "active"
                                  ? "font-semibold text-foreground"
                                  : step.status === "error"
                                    ? "font-semibold text-rose-600 dark:text-rose-400"
                                    : "font-medium text-foreground/80 group-hover:text-foreground",
                              )}
                            >
                              {step.title}
                            </span>

                            <div className="flex items-center gap-3">
                              {step.duration && (
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                  {step.duration}
                                </span>
                              )}
                              {step.content && (
                                <div className="text-muted-foreground/40 transition-colors group-hover:text-muted-foreground">
                                  {isStepExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 步骤展开内容 */}
                          {step.content && (
                            <div
                              className={cn(
                                "grid transition-all duration-400 ease-in-out",
                                isStepExpanded
                                  ? "mt-2 grid-rows-[1fr] opacity-100"
                                  : "mt-0 grid-rows-[0fr] opacity-0",
                              )}
                            >
                              <div className="overflow-hidden">
                                <div className="pb-2 pt-1">{step.content}</div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AgentPlanning
