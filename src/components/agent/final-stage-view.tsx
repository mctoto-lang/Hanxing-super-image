"use client"

/**
 * final 阶段：78 张结构化终稿清单——终稿细化师把初稿细化为
 * 「[1] 画面风格（整套统一）+ [2] 画面内容（逐张细化）」的终稿在此展示。
 * 终稿只读（要改就改初稿后重细化）；支持单张/全部重新细化与可选反馈，
 * 全部就绪后确认进入生图与评审。
 */
import { useMemo, useState } from "react"
import { Check, ChevronDown, Loader2, RefreshCw, Search, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { DRAFT_PROMPT_MIN_CHARS, FINAL_CONTENT_MIN_CHARS, splitFinalPromptSegments } from "@/lib/agent/cards/plan"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

export function FinalStageView({
  data,
  busy,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  onRefresh: () => Promise<unknown>
}) {
  const { confirmTarotCardFinals, regenerateCardPrompts } = useWorkspaceActions()
  const [query, setQuery] = useState("")
  const [activeId, setActiveId] = useState<string | null>(data.items[0]?.id ?? null)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)

  const items = useMemo(
    () =>
      data.items.filter(
        (item) =>
          !query.trim() ||
          (item.name ?? "").includes(query.trim()) ||
          String(item.index + 1) === query.trim(),
      ),
    [data.items, query],
  )
  const active = data.items.find((item) => item.id === activeId) ?? items[0]

  const refining = busy && data.run.pendingAction?.kind === "design_finals"
  // 与服务端 validateTarotFinalPlan 同门槛：结构化终稿看 [画面内容] 段
  // ≥ FINAL_CONTENT_MIN_CHARS；存量旧式提示词（无两段标记）trim 长度
  // ≥ DRAFT_PROMPT_MIN_CHARS 即视为已就绪，避免存量 run 确认按钮被禁用
  const refinedCount = data.items.filter((item) => {
    const segments = splitFinalPromptSegments(item.currentPrompt ?? "")
    return segments
      ? segments.content.length >= FINAL_CONTENT_MIN_CHARS
      : (item.currentPrompt ?? "").trim().length >= DRAFT_PROMPT_MIN_CHARS
  }).length
  const pendingCount = data.items.length - refinedCount
  const allReady = data.items.length === 78 && pendingCount === 0

  const activeSegments = active?.currentPrompt ? splitFinalPromptSegments(active.currentPrompt) : null

  const choose = (id: string) => setActiveId(id)

  const regenOne = async () => {
    if (!active) return
    const feedback = window.prompt(
      `可选：告诉终稿细化师这张「${active.name}」要怎么调整（留空 = 按初稿重新细化）。`,
      "",
    )
    if (feedback === null) return
    setSubmitting(true)
    try {
      await regenerateCardPrompts({ runId: data.run.id, itemIds: [active.id], feedback: feedback.trim() || undefined })
      toast.success(`已提交「${active.name}」的终稿重细化`)
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const regenAll = async () => {
    if (!window.confirm("将用 AI 把全部 78 张初稿重新细化为终稿（消耗少量模型调用积分），确定？")) {
      return
    }
    setSubmitting(true)
    try {
      await regenerateCardPrompts({ runId: data.run.id })
      toast.success("已提交全部 78 张的终稿重细化")
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const confirm = async () => {
    setSaving(true)
    try {
      await confirmTarotCardFinals({ runId: data.run.id })
      toast.success("终稿已确认，开始生成风格小样")
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              78 张画面提示词终稿
              <Badge variant="secondary" className={cn("text-[10px]", allReady ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : undefined)}>
                {refinedCount}/78 已细化
              </Badge>
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              终稿结构固定为「[1] 画面风格（整套统一）+ [2] 画面内容（逐张细化）」；
              中文表述、不带负向提示词。确认后进入生图与评审，评审不通过会从初稿带修改意见重新细化。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || submitting}
            onClick={() => void regenAll()}
            title="由终稿细化师（AI）把全部 78 张初稿重新细化为终稿"
          >
            <RefreshCw className="size-3.5" />
            全部重新细化
          </Button>
        </div>

        {refining && (
          <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2">
            <p className="flex items-center gap-2 text-xs text-violet-600 dark:text-violet-300">
              <Loader2 className="size-3.5 animate-spin" />
              终稿细化师正在把初稿细化为结构化终稿（已完成 {refinedCount}/78）…
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-violet-500/15">
              <div
                className="h-full rounded-full bg-violet-500 transition-all"
                style={{ width: `${data.items.length ? Math.round((refinedCount / data.items.length) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* 左：搜索 + 清单 */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索牌名或序号"
              className="pl-8"
            />
          </div>
          <div className="max-h-[520px] space-y-1 overflow-y-auto pr-1">
            {items.map((item) => {
              const structured = splitFinalPromptSegments(item.currentPrompt ?? "") !== null
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => choose(item.id)}
                  className={`flex w-full items-center justify-between gap-1 rounded-md px-2.5 py-2 text-left text-xs ${
                    item.id === active?.id ? "bg-violet-500/10 text-violet-700" : "hover:bg-muted"
                  }`}
                >
                  <span className="truncate">
                    {item.index + 1}. {item.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {structured ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      (item.currentPrompt ?? "").trim().length > 0 ? (
                        <ChevronDown className="size-3.5 text-amber-500" />
                      ) : null
                    )}
                    <Badge
                      variant="secondary"
                      className={cn(
                        "px-1.5 text-[10px]",
                        structured
                          ? "bg-violet-500/15 text-violet-600 dark:text-violet-300"
                          : "bg-zinc-500/10 text-zinc-500",
                      )}
                    >
                      {structured ? "终稿" : "待细化"}
                    </Badge>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：当前卡终稿（初稿对照 + 两段结构渲染） */}
        <div className="space-y-4">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  第 {active.index + 1} 张 · {active.name}
                </p>
                <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                  {activeSegments ? "结构化终稿" : "待细化 / 旧式提示词"}
                </Badge>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium">画面初稿（重细化基准 · 不可编辑）</p>
                <details className="group rounded-lg border bg-muted/40">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs text-muted-foreground select-none">
                    <ChevronDown className="mr-1 inline size-3.5 transition-transform group-open:rotate-0" />
                    {(active.visualBrief ?? "（暂无）").slice(0, 60)}
                    {(active.visualBrief ?? "").length > 60 ? "…" : ""}
                  </summary>
                  <p className="px-3 pb-3 text-xs leading-relaxed text-muted-foreground">
                    {active.visualBrief || "（暂无）"}
                  </p>
                </details>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium">画面终稿（生图直接使用 · 只读）</p>
                {activeSegments ? (
                  <div className="space-y-2 rounded-lg border p-3 text-xs leading-relaxed">
                    <div>
                      <p className="mb-1 font-medium text-violet-600 dark:text-violet-300">[1] 画面风格</p>
                      <p className="text-muted-foreground">{activeSegments.style}</p>
                    </div>
                    <div className="border-t pt-2">
                      <p className="mb-1 font-medium text-violet-600 dark:text-violet-300">[2] 画面内容</p>
                      <p className="whitespace-pre-wrap text-foreground/90">{activeSegments.content}</p>
                    </div>
                  </div>
                ) : (
                  <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                    {active.currentPrompt ?? "（暂无，等待终稿细化师处理）"}
                  </pre>
                )}
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={busy || submitting}
                  onClick={() => void regenOne()}
                  title="以初稿为基准，让终稿细化师（AI）重新细化这一张（可附修改意见）"
                >
                  <Sparkles className="size-4" />
                  重新细化此张
                </Button>
                <Button
                  disabled={busy || saving || submitting || !allReady}
                  title={allReady ? undefined : `还有终稿未就绪，待细化 ${pendingCount} 张`}
                  onClick={() => void confirm()}
                >
                  {(saving || submitting) && <Loader2 className="size-4 animate-spin" />}
                  确认终稿，开始生图
                </Button>
              </div>
            </>
          ) : (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              暂无卡牌计划
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
