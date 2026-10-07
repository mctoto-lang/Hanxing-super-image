"use client"

/* 参考图 URL 来自受控上传接口（本地存储或 COS），使用原生 img 兼容两类地址。 */
/* eslint-disable @next/next/no-img-element */

/**
 * 塔罗模板 · 阶段 1「需求对齐」
 *
 * 对话流已改为「向用户提问」的引导式体验（参考大厂 onboarding / Typeform）：
 * - 弹窗逐题作答（ClarifyQuestionDialog），一次一题、可跳过、可自定义；
 * - 弹窗外是对齐面板：轮次进度、AI 分析摘要、已答记录、快捷操作；
 * - 《设计简报》生成后在简报弹窗（BriefConfirmDialog）中查看/修改并确认；
 * - 提交仍走 appendTemplateMessageAction（问题：答案 逐行拼装），后端零改动。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import {
  BadgeCheck,
  ChevronDown,
  FileText,
  Loader2,
  MessageCircleQuestion,
  PenLine,
  Sparkles,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DEFAULT_TAROT_TEMPLATE_CONFIG } from "@/lib/agent/pipelines"
import type { AgentClarifyQuestion } from "@/lib/agent/graph"
import {
  BriefConfirmDialog,
} from "./brief-confirm-dialog"
import {
  ClarifyQuestionDialog,
  EMPTY_QUIZ_STATE,
  type ClarifyQuizState,
} from "./clarify-question-dialog"
import { useWorkspaceActions } from "./workspace-actions"
import type { TemplateWorkspaceData } from "./use-template-workspace"

export type RunTemplateAction = (fn: () => Promise<unknown>, successMessage?: string) => Promise<boolean>

type Message = TemplateWorkspaceData["messages"][number]

/** 澄清追问轮次上限兜底（实际以工作台数据下发的 clarifyMaxRounds 为准，管理员可配置） */
const CLARIFY_MAX_ROUNDS_FALLBACK = DEFAULT_TAROT_TEMPLATE_CONFIG.clarifyMaxRounds

/** 最新一条未被回答的追问（其后没有新的用户消息即视为待答） */
function latestPendingClarify(messages: Message[]): {
  round: number
  analysis?: string
  questions: AgentClarifyQuestion[]
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === "user") return null
    if (message.meta?.kind === "clarify") {
      return { round: message.meta.round, analysis: message.meta.analysis, questions: message.meta.questions }
    }
  }
  return null
}

/** 已回答的澄清轮次（clarify 问题 + 紧随其后的用户回答原文） */
function answeredRounds(messages: Message[]): { round: number; reply: string }[] {
  const rounds: { round: number; reply: string }[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (message.role !== "assistant" || message.meta?.kind !== "clarify") continue
    const next = messages[i + 1]
    if (next?.role === "user") rounds.push({ round: message.meta.round, reply: next.content })
  }
  return rounds
}

export function ClarifyStage({
  data,
  busy,
  runAction,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  runAction: RunTemplateAction
}) {
  const { appendTemplateMessage, requestBrief, saveTemplateBrief } = useWorkspaceActions()
  const { run, messages } = data
  // 轮次上限跟随管理员配置下发（工作台数据缺省时用内置兜底）
  const clarifyMaxRounds = data.clarifyMaxRounds ?? CLARIFY_MAX_ROUNDS_FALLBACK
  const pending = useMemo(() => latestPendingClarify(messages), [messages])
  const answered = useMemo(() => answeredRounds(messages), [messages])
  const opener = messages.find((message) => message.role === "user")
  const creativeDirectorBusy =
    busy && (run.pendingAction?.kind === "clarify_turn" || run.pendingAction?.kind === "finalize_brief")
  const hasNewQuestions = !!pending && !creativeDirectorBusy

  // ---- 提问弹窗（状态提升到本组件，关闭不丢已答） ----
  const [quizOpen, setQuizOpen] = useState(false)
  const [quizState, setQuizState] = useState<ClarifyQuizState>(EMPTY_QUIZ_STATE)
  const [submitting, setSubmitting] = useState(false)
  const autoOpenedRound = useRef<number | null>(null)
  const dismissedRound = useRef<number | null>(null)
  const pendingRound = pending?.round ?? 0

  // 挂载后首次出现待答问题自动弹出；后续轮次只在 CTA 上高亮提醒
  useEffect(() => {
    if (
      !quizOpen &&
      pending &&
      !creativeDirectorBusy &&
      autoOpenedRound.current === null &&
      dismissedRound.current !== pending.round
    ) {
      autoOpenedRound.current = pending.round
      setQuizState(EMPTY_QUIZ_STATE)
      setQuizOpen(true)
    }
  }, [pending, creativeDirectorBusy, quizOpen])

  const closeQuiz = (open: boolean) => {
    if (!open && pending) dismissedRound.current = pending.round
    setQuizOpen(open)
    if (open) autoOpenedRound.current = pendingRound
  }

  const submitQuiz = async (answers: Record<string, string>, extra: string) => {
    if (!pending) return
    const lines = pending.questions
      .filter((question) => (answers[question.id] ?? "").trim().length > 0)
      .map((question) => `${question.question}：${answers[question.id]!.trim()}`)
    if (extra.trim()) lines.push(extra.trim())
    if (lines.length === 0) return
    setSubmitting(true)
    const ok = await runAction(
      () => appendTemplateMessage({ runId: run.id, content: lines.join("\n") }),
      "已提交，创意总监正在分析你的回答",
    )
    setSubmitting(false)
    if (ok) {
      setQuizOpen(false)
      setQuizState(EMPTY_QUIZ_STATE)
      dismissedRound.current = null
    }
  }

  // ---- 简报弹窗（新简报出现 / 重新生成后自动弹出） ----
  const [briefOpen, setBriefOpen] = useState(false)
  const latestBriefId = [...messages].reverse().find((m) => m.meta?.kind === "brief")?.id ?? "none"
  const seenBriefId = useRef<string | null>(null)
  useEffect(() => {
    if (seenBriefId.current === null) {
      // 挂载快照：已有简报不弹，避免回访打扰
      seenBriefId.current = latestBriefId
      return
    }
    if (latestBriefId !== seenBriefId.current) {
      seenBriefId.current = latestBriefId
      if (latestBriefId !== "none") setBriefOpen(true)
    }
  }, [latestBriefId])

  const confirmBrief = async (brief: string) => {
    await runAction(
      () => saveTemplateBrief({ runId: run.id, brief }),
      "简报已确认，风格策划开始构思内容方向",
    )
  }

  const totalAnsweredQuestions = answered.reduce(
    (sum, item) => sum + (item.reply?.split("\n").filter((line) => line.trim()).length ?? 0),
    0,
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <MessageCircleQuestion className="size-4 text-violet-500" />
            和创意总监对齐需求
            <Badge variant="secondary" className="bg-violet-500/10 text-violet-600 dark:text-violet-300">
              {pendingRound > 0 ? `第 ${Math.min(pendingRound, clarifyMaxRounds)}/${clarifyMaxRounds} 轮` : "准备中"}
            </Badge>
          </CardTitle>
          <CardDescription>
            创意总监会用几个关键问题收敛你的想法，回答越具体，后续 78 张牌的设计越贴合预期。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {run.input.referenceImages.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">风格参考图</span>
              {run.input.referenceImages.map((url, index) => (
                <img
                  key={url}
                  src={url}
                  alt={`风格参考图 ${index + 1}`}
                  className="size-14 rounded-md border object-cover"
                />
              ))}
            </div>
          )}

          {/* 对齐进度摘要 */}
          <div className="space-y-1.5 rounded-xl border border-violet-500/25 bg-violet-500/[0.04] p-4">
            {creativeDirectorBusy ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin text-violet-500" />
                {run.pendingAction?.kind === "finalize_brief"
                  ? "创意总监正在整理《设计简报》…"
                  : "创意总监正在分析你的回答…"}
              </p>
            ) : (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <BadgeCheck className="size-4 text-emerald-500" />
                  已对齐 {totalAnsweredQuestions} 个要点
                </span>
                {pending && <span className="text-muted-foreground">还有 {pending.questions.length} 个新问题等你回答</span>}
              </p>
            )}
            {pending?.analysis && !creativeDirectorBusy && (
              <p className="pl-6 text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground/70">AI 分析：</span>
                {pending.analysis}
              </p>
            )}
          </div>

          {/* 已答记录 */}
          {(answered.length > 0 || opener) && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">对齐记录</p>
              {opener && (
                <Collapsible className="rounded-xl border bg-muted/20">
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm">
                    <span className="min-w-0 truncate">你的初始需求</span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="whitespace-pre-wrap border-t px-4 py-3 text-xs leading-6 text-muted-foreground">
                      {opener.content}
                    </p>
                  </CollapsibleContent>
                </Collapsible>
              )}
              {answered.map((item) => (
                <Collapsible key={item.round} className="rounded-xl border bg-muted/20">
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm">
                    <span className="min-w-0 truncate">
                      第 {item.round} 轮 · 你回答了{" "}
                      {item.reply.split("\n").filter((line) => line.trim()).length} 个问题
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="whitespace-pre-wrap border-t px-4 py-3 text-xs leading-6 text-muted-foreground">
                      {item.reply}
                    </p>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}

          {/* 操作区 */}
          <div className="flex flex-wrap items-center gap-2">
            {hasNewQuestions ? (
              <Button
                disabled={busy || submitting}
                className={pending ? "ring-2 ring-violet-500/40" : undefined}
                onClick={() => {
                  setQuizState(EMPTY_QUIZ_STATE)
                  closeQuiz(true)
                }}
              >
                <PenLine className="size-4" />
                回答创意总监的问题
                <Badge variant="secondary" className="ml-1 bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">
                  {pending.questions.length} 个新问题
                </Badge>
              </Button>
            ) : (
              <Button variant="outline" disabled={busy || !pending} onClick={() => closeQuiz(true)}>
                <PenLine className="size-4" />
                继续回答
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runAction(() => requestBrief(run.id), "已请创意总监整理简报")}
            >
              <FileText className="size-3.5" />
              {run.brief ? "重新生成简报" : "信息够了，生成创作简报"}
            </Button>
            {run.brief && (
              <Button
                variant="outline"
                className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
                disabled={busy}
                onClick={() => setBriefOpen(true)}
              >
                <Sparkles className="size-3.5" />
                查看设计简报
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {run.brief && (
        <Card className="border-emerald-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Sparkles className="size-4 text-emerald-500" />
              《设计简报》已生成
              <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                待确认
              </Badge>
            </CardTitle>
            <CardDescription>
              简报已就绪。确认后进入内容方向阶段，风格策划会据此构思 3 个方向。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" disabled={busy} onClick={() => setBriefOpen(true)}>
              查看并确认简报
            </Button>
          </CardContent>
        </Card>
      )}

      <ClarifyQuestionDialog
        open={quizOpen}
        onOpenChange={closeQuiz}
        questions={pending?.questions ?? []}
        round={pending?.round ?? 1}
        maxRounds={clarifyMaxRounds}
        state={quizState}
        onStateChange={setQuizState}
        submitting={submitting || creativeDirectorBusy}
        onSubmit={(answers, extra) => void submitQuiz(answers, extra)}
      />

      {run.brief && (
        <BriefConfirmDialog
          open={briefOpen}
          onOpenChange={setBriefOpen}
          initialBrief={run.brief}
          busy={busy}
          onConfirm={(brief) => void confirmBrief(brief)}
        />
      )}
    </div>
  )
}
