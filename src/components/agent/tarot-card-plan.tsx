"use client"

/**
 * draft 阶段：78 张画面提示词清单——AI 提示词设计师逐张撰写画面内容
 * （100-140 字，约 120 字），系统在写回时把固定风格提示词（选定方向风格
 * 总述，约 100 字，整套逐字统一）与无边框句确定性拼接到提示词末尾（整体
 * 约 220 字），在此展示，用户可直接查看/修改/重新生成；全部就绪后确认
 * 直接进入生图与评审（art 阶段）。牌义为 AI 内部参考（只读），不再参与
 * 用户编辑。
 */
import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Check, Loader2, RefreshCw, Save, Search, Sparkles, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { isPromptItemReady } from "@/lib/agent/cards/plan"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

type PlanItem = TemplateWorkspaceData["items"][number]

/** 提示词就绪门槛（与服务端 SINGLE_PROMPT_MIN_CHARS 一致；撰写目标 80-130 字） */
const PROMPT_MIN_CHARS = 60

/**
 * 来源徽标：initial + errorMessage = AI 撰写失败（红，可一键重试）；
 * initial 无错 = 待写（撰写进行中显示「撰写中」）；其余为 AI/手动成稿。
 */
function sourceBadge(item: PlanItem, writing: boolean) {
  if (item.promptSource === "ai") return { text: "AI", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-300" }
  if (item.promptSource === "manual") return { text: "手动", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-300" }
  if (item.promptSource === "final") return { text: "AI 终稿", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" }
  if (item.errorMessage) return { text: "失败", cls: "bg-red-500/15 text-red-600 dark:text-red-400" }
  return { text: writing ? "撰写中" : "待写", cls: "bg-zinc-500/10 text-zinc-500" }
}

export function TarotCardPlan({
  data,
  busy,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  onRefresh: () => Promise<unknown>
}) {
  const {
    confirmTarotCardDrafts,
    updateTarotCardPlanItem,
    regenerateCardPrompts,
    regenerateStyleSpec,
  } = useWorkspaceActions()
  const [query, setQuery] = useState("")
  const [activeId, setActiveId] = useState<string | null>(data.items[0]?.id ?? null)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
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
  const [meaning, setMeaning] = useState(active?.meaning ?? "")
  const [prompt, setPrompt] = useState(active?.currentPrompt ?? "")
  /** 编辑框脏标记：用户改过即置位，轮询数据不回写以免打字被覆盖；
   *  切卡 / 保存成功 / 提交 AI 重新生成成功后复位，让编辑框随最新数据同步。 */
  const [dirty, setDirty] = useState(false)

  // 当前卡数据刷新（轮询/手动 refresh）且编辑框非脏时同步 state：AI 重新
  // 生成的新稿随轮询自动回填编辑框，防止随后的 save() 把旧 state 全量
  // 写回覆盖新稿（服务端 updateTarotCardPlanItem 为无条件全量覆盖）
  useEffect(() => {
    if (dirty || !active) return
    setMeaning(active.meaning ?? "")
    setPrompt(active.currentPrompt ?? "")
  }, [active, dirty])

  const direction =
    data.run.directions?.find((item) => item.id === data.run.selectedDirectionId) ?? null
  // 固定风格提示词（系统逐字拼接到每张提示词末尾）：选定方向的风格总述，
  // 存量方向缺省时回退色板
  const fixedStylePrompt = direction?.visualLanguage || direction?.palette || ""
  const designing = busy && data.run.pendingAction?.kind === "design_drafts"
  const speculating = busy && data.run.pendingAction?.kind === "gen_style_spec"
  const writing = designing || speculating
  // 就绪 = AI 已写完或用户手动编辑过（与服务端 isPromptItemReady 同口径）；
  // 待写/撰写中/失败的卡不计入——进度条与实际生成过程一致
  const writtenCount = data.items.filter((item) => isPromptItemReady(item)).length
  const pendingCount = data.items.length - writtenCount
  const allReady = data.items.length === 78 && pendingCount === 0
  const failedItems = writing ? [] : data.items.filter((item) => item.errorMessage)
  const failedCount = failedItems.length

  const choose = (id: string) => {
    const item = data.items.find((candidate) => candidate.id === id)
    if (!item) return
    setActiveId(id)
    setDirty(false)
    setMeaning(item.meaning ?? "")
    setPrompt(item.currentPrompt ?? "")
  }

  const save = async () => {
    if (!active) return
    if (prompt.trim().length < PROMPT_MIN_CHARS) {
      toast.error(`画面提示词至少 ${PROMPT_MIN_CHARS} 字（画面内容建议 100-140 字 + 系统拼接的固定风格），请补充主体与场景描述`)
      return
    }
    setSaving(true)
    try {
      // 业务失败（阶段/运行态守卫等）以返回值传达：生产环境 Server Action
      // 抛错会被抹为 #441 占位文案
      const result = await updateTarotCardPlanItem({ runId: data.run.id, itemId: active.id, meaning, visualBrief: prompt })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${active.name} 已保存`)
      setDirty(false)
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const regenOne = async () => {
    if (!active) return
    setSubmitting(true)
    try {
      const result = await regenerateCardPrompts({ runId: data.run.id, itemIds: [active.id] })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`已提交「${active.name}」的 AI 重新撰写`)
      setDirty(false)
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const regenAll = async () => {
    if (!window.confirm("将用 AI 重新撰写全部 78 张画面提示词（消耗少量模型调用积分，已手动修改的会被覆盖），确定？")) {
      return
    }
    setSubmitting(true)
    try {
      const result = await regenerateCardPrompts({ runId: data.run.id })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("已提交全部 78 张的 AI 重新撰写")
      setDirty(false)
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const retryFailed = async () => {
    if (failedItems.length === 0) return
    setSubmitting(true)
    try {
      const result = await regenerateCardPrompts({ runId: data.run.id, itemIds: failedItems.map((item) => item.id) })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`已提交 ${failedItems.length} 张失败提示词的 AI 重新撰写`)
      setDirty(false)
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const restyle = async () => {
    const feedback = window.prompt(
      "可选：告诉风格策划你想怎么调整（留空 = 完全重新拟定）。注意：重新拟定会生成 3 个新候选方向（各附 1 张示例图，消耗生图积分）并重置当前选择，重新选定后全部提示词会被重写。",
      "",
    )
    if (feedback === null) return
    setSubmitting(true)
    try {
      await regenerateStyleSpec({ runId: data.run.id, feedback: feedback.trim() || undefined })
      toast.success("已提交重新拟定 3 个风格规范方向")
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
      const result = await confirmTarotCardDrafts({ runId: data.run.id })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("画面提示词已确认，开始生成风格小样")
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败")
    } finally {
      setSaving(false)
    }
  }

  const bodyLen = prompt.trim().length
  const source = active ? sourceBadge(active, writing) : null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              78 张画面提示词
              <Badge variant="secondary" className={cn("text-[10px]", writtenCount === 78 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : undefined)}>
                {writtenCount}/78 已就绪
              </Badge>
              {failedCount > 0 && (
                <Badge variant="secondary" className="bg-red-500/15 text-[10px] text-red-600 dark:text-red-400">
                  失败 {failedCount}
                </Badge>
              )}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {writing
                ? "AI 团队正在撰写画面提示词，完成后可在此查看与修改。"
                : failedCount > 0
                  ? "存在 AI 撰写失败的提示词（提示词必须经 AI 生成），可一键重试失败卡或手动修改后保存。"
                  : "逐张确认画面提示词（首次撰写即终稿，可修改或让 AI 重新撰写），确认后直接开始生图。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {failedCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || submitting}
                onClick={() => void retryFailed()}
                className="border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                title="仅重新 AI 撰写生成失败的提示词"
              >
                <RefreshCw className="size-3.5" />
                一键重试失败（{failedCount} 张）
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || submitting}
              onClick={() => void restyle()}
              title="重新拟定 3 个候选《风格规范书》（各附 1 张示例图；重置当前选择，重新选定后重写全部提示词）"
            >
              <Wand2 className="size-3.5" />
              重新拟定风格方向
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || submitting}
              onClick={() => void regenAll()}
              title="由提示词设计师（AI）重新撰写全部 78 张画面提示词"
            >
              <RefreshCw className="size-3.5" />
              全部重新生成
            </Button>
          </div>
        </div>

        {fixedStylePrompt && (
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2">
            <p className="text-[11px] font-medium text-violet-600 dark:text-violet-300">
              固定风格提示词（系统逐字拼接到每张提示词末尾，整套 78 张统一，用于固定画面风格）：
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{fixedStylePrompt}</p>
          </div>
        )}

        {(designing || speculating) && (
          <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2">
            <p className="flex items-center gap-2 text-xs text-violet-600 dark:text-violet-300">
              <Loader2 className="size-3.5 animate-spin" />
              {speculating ? "风格策划正在重新拟定风格方向与示例图（完成后回到方向选择）…" : `AI 正在撰写画面提示词（已就绪 ${writtenCount}/78）…`}
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-violet-500/15">
              <div
                className="h-full rounded-full bg-violet-500 transition-all"
                style={{ width: `${data.items.length ? Math.round((writtenCount / data.items.length) * 100) : 0}%` }}
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
              const badge = sourceBadge(item, writing)
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
                    {isPromptItemReady(item) && <Check className="size-3.5 text-emerald-500" />}
                    {badge.text === "失败" && <AlertCircle className="size-3.5 text-red-500" />}
                    <Badge variant="secondary" className={cn("px-1.5 text-[10px]", badge.cls)}>
                      {badge.text}
                    </Badge>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：当前卡提示词编辑 */}
        <div className="space-y-4">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  第 {active.index + 1} 张 · {active.name}
                </p>
                {source && (
                  <Badge variant="secondary" className={cn("text-[10px]", source.cls)}>
                    {source.text}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {active.status === "pending" ? "待确认" : active.status}
                </span>
              </div>

              {active.errorMessage && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-red-500" />
                  <p className="text-xs leading-relaxed text-red-600 dark:text-red-400">
                    {active.errorMessage}——可点击右下角「AI 重新生成此张」重试，或直接手动修改后保存。
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs font-medium">牌义（AI 参考，不可编辑）</label>
                <p className="min-h-10 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  {active.meaning || "（暂无）"}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="card-prompt" className="text-xs font-medium">
                    画面提示词（画面内容 + 系统拼接的固定风格）
                  </label>
                  <span
                    className={cn(
                      "text-[11px] tabular-nums",
                      bodyLen >= PROMPT_MIN_CHARS ? "text-muted-foreground" : "text-red-500",
                    )}
                  >
                    {bodyLen} 字{bodyLen < PROMPT_MIN_CHARS ? `（至少 ${PROMPT_MIN_CHARS} 字）` : "（画面内容约 120 字 + 固定风格约 100 字，整体约 220 字）"}
                  </span>
                </div>
                <Textarea
                  id="card-prompt"
                  value={prompt}
                  onChange={(event) => {
                    setPrompt(event.target.value)
                    setDirty(true)
                  }}
                  className="min-h-36"
                  disabled={busy || saving}
                  placeholder="画面内容（主体/动作神态/道具/场景氛围/光影，约 120 字）——固定风格提示词与无边框句由系统自动拼接在末尾。权杖/圣杯/宝剑/星币 Ace-10 需写明对应数量的花色物品（如「五只圣杯」），摆放位置交给生图 AI 自由发挥。"
                />
                <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  提示词 = 画面内容（AI 逐卡撰写）+ 固定风格提示词（整套逐字统一）+ 无边框句——后两者由系统拼接，
                  手动编辑时请保留末尾的风格与结尾句以维持整套风格一致。
                </p>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={busy || saving || submitting}
                  onClick={() => void regenOne()}
                  title="让提示词设计师（AI）重新撰写这一张"
                >
                  <Sparkles className="size-4" />
                  AI 重新生成此张
                </Button>
                <Button variant="outline" disabled={busy || saving} onClick={() => void save()}>
                  <Save className="size-4" />
                  保存此张
                </Button>
                <Button
                  disabled={busy || saving || submitting || !allReady}
                  title={allReady ? undefined : failedCount > 0 ? `有 ${failedCount} 张提示词生成失败，请先重试或手动修改` : `还有画面提示词未就绪（AI 已写/手动编辑 ≥${PROMPT_MIN_CHARS} 字），待写 ${pendingCount} 张`}
                  onClick={() => void confirm()}
                >
                  {(saving || submitting) && <Loader2 className="size-4 animate-spin" />}
                  确认提示词，开始生图
                </Button>
              </div>
            </>
          ) : (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              暂无卡牌清单
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
