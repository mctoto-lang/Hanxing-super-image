"use client"

/**
 * 需求澄清 · 逐题引导式提问弹窗（Typeform / 大厂 onboarding 风格）。
 *
 * 一轮问题（后端 LLM 生成，≤3 题）一次只显示一题：大尺寸选项卡点选、
 * 可切到自定义输入，最后一 步为补充说明；导航支持上一题 / 跳过。
 * 答题状态提升到 ClarifyStage（ClarifyQuizState），关闭弹窗不丢已答内容。
 */
import { Check, ChevronLeft, ChevronRight, Loader2, PenLine, SendHorizonal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { AgentClarifyQuestion } from "@/lib/agent/graph"
import { ResponsiveDialog } from "./responsive-dialog"

export interface ClarifyQuizState {
  /** 0..questions.length；最后一步（= questions.length）为补充说明 */
  step: number
  /** 问题 id -> 选项文本或自定义输入 */
  answers: Record<string, string>
  /** 问题 id -> 是否处于「自定义」输入模式 */
  custom: Record<string, boolean>
  /** 补充说明（最后一步，可空） */
  extra: string
}

export const EMPTY_QUIZ_STATE: ClarifyQuizState = { step: 0, answers: {}, custom: {}, extra: "" }

/** 选项 / 自定义选择卡：左侧圆圈指示，选中 violet 填充 */
function OptionCard({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
        selected
          ? "border-violet-500 bg-violet-500/[0.06] ring-1 ring-violet-500"
          : "hover:border-violet-400/60 hover:bg-violet-500/[0.03]",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-violet-500 bg-violet-500 text-white" : "border-muted-foreground/30",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

export function ClarifyQuestionDialog({
  open,
  onOpenChange,
  questions,
  round,
  maxRounds,
  state,
  onStateChange,
  submitting,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  questions: AgentClarifyQuestion[]
  round: number
  maxRounds: number
  state: ClarifyQuizState
  onStateChange: (next: ClarifyQuizState) => void
  submitting: boolean
  onSubmit: (answers: Record<string, string>, extra: string) => void
}) {
  const totalSteps = questions.length + 1
  const step = Math.max(0, Math.min(state.step, totalSteps - 1))
  const isSummaryStep = step >= questions.length
  const current = questions[step]
  const answeredCount = questions.filter((q) => (state.answers[q.id] ?? "").trim().length > 0).length
  const canSubmit = answeredCount > 0 || state.extra.trim().length > 0
  const currentAnswered = current ? (state.answers[current.id] ?? "").trim().length > 0 : true

  const choose = (qid: string, value: string) =>
    onStateChange({ ...state, answers: { ...state.answers, [qid]: value } })

  const toggleCustom = (qid: string) => {
    const nextCustom = { ...state.custom, [qid]: !state.custom[qid] }
    const nextAnswers = { ...state.answers }
    if (nextCustom[qid]) {
      // 从选项切到自定义时清掉旧选项，进入空输入
      nextAnswers[qid] = ""
    } else {
      delete nextAnswers[qid]
    }
    onStateChange({ ...state, answers: nextAnswers, custom: nextCustom })
  }

  const go = (next: number) =>
    onStateChange({ ...state, step: Math.max(0, Math.min(totalSteps - 1, next)) })

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="需求澄清"
      badge={
        <Badge variant="secondary" className="bg-violet-500/10 text-violet-600 dark:text-violet-300">
          第 {Math.max(round, 1)}/{maxRounds} 轮
        </Badge>
      }
      description={`创意总监为你准备了 ${questions.length} 个问题，逐题作答即可，也可以跳过。`}
      desktopClassName="sm:max-w-lg"
    >
      <div className="space-y-4">
        {/* 进度点 + 步数 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-hidden>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "rounded-full transition-all",
                  i < step
                    ? "size-2 bg-violet-500/50"
                    : i === step
                      ? "size-2.5 bg-violet-500"
                      : "size-2 bg-muted-foreground/25",
                )}
              />
            ))}
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {isSummaryStep ? "最后一步" : `第 ${step + 1}/${totalSteps} 步`} · 已答 {answeredCount}/
            {questions.length}
          </span>
        </div>

        {/* 题目 / 补充说明 */}
        {isSummaryStep ? (
          <div className="space-y-2">
            <p className="text-lg font-semibold leading-snug">还有什么想补充的吗？</p>
            <p className="text-xs leading-5 text-muted-foreground">
              可以描述参考图里的偏好、想避开的元素，或创意总监没有问到的想法（可不填，直接提交）。
            </p>
            <Textarea
              aria-label="补充说明"
              value={state.extra}
              onChange={(event) => onStateChange({ ...state, extra: event.target.value })}
              className="min-h-24 resize-y"
              placeholder="例如：整体希望偏暗色系、更神秘一些，不要太可爱……"
              disabled={submitting}
            />
          </div>
        ) : current ? (
          <div key={current.id} className="space-y-3">
            <p className="text-lg font-semibold leading-snug">{current.question}</p>
            <div className="grid gap-2">
              {current.options.map((option) => (
                <OptionCard
                  key={option}
                  selected={!state.custom[current.id] && state.answers[current.id] === option}
                  disabled={submitting}
                  onClick={() => {
                    // 再点一次取消选择；选选项时退出自定义模式
                    const isSelected =
                      !state.custom[current.id] && state.answers[current.id] === option
                    onStateChange({
                      ...state,
                      answers: { ...state.answers, [current.id]: isSelected ? "" : option },
                      custom: { ...state.custom, [current.id]: false },
                    })
                  }}
                >
                  {option}
                </OptionCard>
              ))}
              <OptionCard
                selected={!!state.custom[current.id]}
                disabled={submitting}
                onClick={() => toggleCustom(current.id)}
              >
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <PenLine className="size-3.5" />
                  其他，我想自己说
                </span>
              </OptionCard>
              {!!state.custom[current.id] && (
                <Input
                  autoFocus
                  aria-label="自定义答案"
                  value={state.answers[current.id] ?? ""}
                  onChange={(event) => choose(current.id, event.target.value)}
                  placeholder="一句话说明你的想法"
                  disabled={submitting}
                  className="pl-4"
                />
              )}
            </div>
          </div>
        ) : null}

        {/* 导航 */}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={step === 0 || submitting}
            onClick={() => go(step - 1)}
          >
            <ChevronLeft className="size-4" />
            上一题
          </Button>
          {isSummaryStep ? (
            <Button size="sm" disabled={!canSubmit || submitting} onClick={() => onSubmit(state.answers, state.extra)}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <SendHorizonal className="size-4" />}
              提交答案
            </Button>
          ) : (
            <Button
              size="sm"
              variant={currentAnswered ? "default" : "outline"}
              disabled={submitting}
              onClick={() => go(step + 1)}
            >
              {currentAnswered ? "下一题" : "跳过"}
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </ResponsiveDialog>
  )
}
