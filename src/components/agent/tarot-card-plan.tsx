"use client"

/**
 * draft 阶段：78 张画面提示词初稿清单——AI 初稿设计师逐张撰写的简洁初稿
 * （40-80 字）在此展示，用户可直接查看/修改/重新生成；全部就绪后确认进入
 * 终稿细化（final 阶段）。牌义为 AI 内部参考（只读），不再参与用户编辑。
 */
import { useEffect, useMemo, useState } from "react"
import { Check, Loader2, RefreshCw, Save, Search, Sparkles, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

/** 初稿字数门槛（与服务端 DRAFT_PROMPT_MIN_CHARS 一致；建议 40-80 字） */
const DRAFT_MIN_CHARS = 20

function sourceBadge(source: string | null | undefined) {
  if (source === "ai") return { text: "AI", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-300" }
  if (source === "manual") return { text: "手动", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-300" }
  if (source === "final") return { text: "终稿", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" }
  // initial：建清单时的模板兜底初稿（≥20 字即可用，非「待写」）
  return { text: "兜底", cls: "bg-zinc-500/10 text-zinc-500" }
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
  const [visualBrief, setVisualBrief] = useState(active?.visualBrief ?? "")
  /** 编辑框脏标记：用户改过即置位，轮询数据不回写以免打字被覆盖；
   *  切卡 / 保存成功 / 提交 AI 重新生成成功后复位，让编辑框随最新数据同步。 */
  const [dirty, setDirty] = useState(false)

  // 当前卡数据刷新（轮询/手动 refresh）且编辑框非脏时同步 state：AI 重新
  // 生成的新稿随轮询自动回填编辑框，防止随后的 save() 把旧 state 全量
  // 写回覆盖新稿（服务端 updateTarotCardPlanItem 为无条件全量覆盖）
  useEffect(() => {
    if (dirty || !active) return
    setMeaning(active.meaning ?? "")
    setVisualBrief(active.visualBrief ?? "")
  }, [active, dirty])

  const direction =
    data.run.directions?.find((item) => item.id === data.run.selectedDirectionId) ?? null
  const styleSummary = direction?.visualLanguage || direction?.palette || ""
  const designing = busy && data.run.pendingAction?.kind === "design_drafts"
  const speculating = busy && data.run.pendingAction?.kind === "gen_style_spec"
  const writtenCount = data.items.filter(
    (item) => (item.visualBrief ?? "").trim().length >= DRAFT_MIN_CHARS,
  ).length
  const pendingCount = data.items.length - writtenCount
  const allReady = data.items.length === 78 && pendingCount === 0

  const choose = (id: string) => {
    const item = data.items.find((candidate) => candidate.id === id)
    if (!item) return
    setActiveId(id)
    setDirty(false)
    setMeaning(item.meaning ?? "")
    setVisualBrief(item.visualBrief ?? "")
  }

  const save = async () => {
    if (!active) return
    if (visualBrief.trim().length < DRAFT_MIN_CHARS) {
      toast.error(`画面初稿至少 ${DRAFT_MIN_CHARS} 字（建议 40-80 字），请补充主体与场景描述`)
      return
    }
    setSaving(true)
    try {
      await updateTarotCardPlanItem({ runId: data.run.id, itemId: active.id, meaning, visualBrief })
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
      await regenerateCardPrompts({ runId: data.run.id, itemIds: [active.id] })
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
    if (!window.confirm("将用 AI 重新撰写全部 78 张画面初稿（消耗少量模型调用积分，已手动修改的会被覆盖），确定？")) {
      return
    }
    setSubmitting(true)
    try {
      await regenerateCardPrompts({ runId: data.run.id })
      toast.success("已提交全部 78 张的 AI 重新撰写")
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
      "可选：告诉风格策划你想怎么调整（留空 = 完全重新拟定）。注意：重新拟定会生成 3 个新候选方向并重置当前选择，重新选定后全部初稿会被重写。",
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
      await confirmTarotCardDrafts({ runId: data.run.id })
      toast.success("初稿已确认，终稿细化师开始细化结构化终稿")
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败")
    } finally {
      setSaving(false)
    }
  }

  const bodyLen = visualBrief.trim().length
  const source = sourceBadge(active?.promptSource)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              78 张画面提示词初稿
              <Badge variant="secondary" className={cn("text-[10px]", writtenCount === 78 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : undefined)}>
                {writtenCount}/78 已撰写
              </Badge>
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {designing || speculating
                ? "AI 团队正在撰写画面初稿，完成后可在此查看与修改。"
                : "逐张确认简洁的画面初稿（可修改或让 AI 重新撰写），确认后进入终稿细化。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || submitting}
              onClick={() => void restyle()}
              title="重新拟定 3 个候选《风格规范书》（重置当前选择，重新选定后重写全部初稿）"
            >
              <Wand2 className="size-3.5" />
              重新拟定风格方向
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || submitting}
              onClick={() => void regenAll()}
              title="由初稿设计师（AI）重新撰写全部 78 张画面初稿"
            >
              <RefreshCw className="size-3.5" />
              全部重新生成
            </Button>
          </div>
        </div>

        {styleSummary && (
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2">
            <p className="text-[11px] font-medium text-violet-600 dark:text-violet-300">
              《风格规范书》画面风格总述（终稿 [1] 段将整套沿用）：
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{styleSummary}</p>
          </div>
        )}

        {(designing || speculating) && (
          <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2">
            <p className="flex items-center gap-2 text-xs text-violet-600 dark:text-violet-300">
              <Loader2 className="size-3.5 animate-spin" />
              {speculating ? "风格策划正在重新拟定风格方向（完成后回到方向选择）…" : `AI 正在撰写画面初稿（已完成 ${writtenCount}/78）…`}
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
              const badge = sourceBadge(item.promptSource)
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
                    {(item.visualBrief ?? "").trim().length >= DRAFT_MIN_CHARS && (
                      <Check className="size-3.5 text-emerald-500" />
                    )}
                    <Badge variant="secondary" className={cn("px-1.5 text-[10px]", badge.cls)}>
                      {badge.text}
                    </Badge>
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：当前卡初稿编辑 */}
        <div className="space-y-4">
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  第 {active.index + 1} 张 · {active.name}
                </p>
                <Badge variant="secondary" className={cn("text-[10px]", source.cls)}>
                  {source.text}撰写
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {active.status === "pending" ? "待确认" : active.status}
                </span>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium">牌义（AI 参考，不可编辑）</label>
                <p className="min-h-10 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  {active.meaning || "（暂无）"}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="card-visual-brief" className="text-xs font-medium">
                    画面提示词初稿（主体 · 场景 · 氛围）
                  </label>
                  <span
                    className={cn(
                      "text-[11px] tabular-nums",
                      bodyLen >= DRAFT_MIN_CHARS ? "text-muted-foreground" : "text-red-500",
                    )}
                  >
                    {bodyLen} 字{bodyLen < DRAFT_MIN_CHARS ? `（至少 ${DRAFT_MIN_CHARS} 字）` : "（建议 40-80 字）"}
                  </span>
                </div>
                <Textarea
                  id="card-visual-brief"
                  value={visualBrief}
                  onChange={(event) => {
                    setVisualBrief(event.target.value)
                    setDirty(true)
                  }}
                  className="min-h-28"
                  disabled={busy || saving}
                  placeholder="一句话点明画面主体（人物/动物/物品），一句话交代场景与氛围。权杖/圣杯/宝剑/星币 Ace-10 需写明对应数量的花色物品（如「五只圣杯」）。"
                />
                <p className="rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  初稿简洁明了即可：终稿细化师会在下一阶段把它细化为「[1] 画面风格 + [2] 画面内容」结构终稿；
                  初稿与终稿均为中文、不带任何负向提示词。
                </p>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={busy || saving || submitting}
                  onClick={() => void regenOne()}
                  title="让初稿设计师（AI）重新撰写这一张"
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
                  title={allReady ? undefined : `还有画面初稿未就绪（≥${DRAFT_MIN_CHARS} 字），待写 ${pendingCount} 张`}
                  onClick={() => void confirm()}
                >
                  {(saving || submitting) && <Loader2 className="size-4 animate-spin" />}
                  确认初稿，开始细化终稿
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
