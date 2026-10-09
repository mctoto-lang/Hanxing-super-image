"use client"

/* 生成图 URL 可能来自本地存储或 COS，使用原生 img 兼容两类地址。 */
/* eslint-disable @next/next/no-img-element */

/**
 * 单卡逐轮回放弹窗（无条件三列布局，不做断点切换）：
 * - 左列 = 当前选中轮大图（固定列宽、与内容区等高，图片完整比例居中，可留白）；
 * - 中列 = 评分与裁决（提示词区域内滑动查看/评审卡/候选/裁决）；
 * - 右窄列 = 轮次缩略图列表（点击切换，终版标记 + 左缘状态色条）；
 * - 弹窗固定高度（85vh），三列各自内部滚动（隐藏滚动条），窄屏三列按比例压缩；
 * - 底部操作：确认当前轮为终版 / 手动重开。
 */
import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Circle, ExternalLink, Pencil, RefreshCcw, ShieldAlert, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Textarea } from "@/components/ui/textarea"
import type { getRunItemDetailAction } from "@/server/actions/agent"
import { ITEM_STATUS_META } from "./canvas-shared"
import { useWorkspaceActions } from "./workspace-actions"
import { ScoreSegmentsBar } from "./score-bar"
import {
  DEFAULT_SCORE_THRESHOLDS,
  SCORE_DIMENSION_LABELS,
  scoreTone,
} from "@/lib/agent/score"
import type { ReviewResultPayload, VerdictPayload } from "@/lib/agent/graph"

/** 隐藏滚动条（滚动可用但不渲染滚动条；globals.css 手写工具类，不依赖 Tailwind 任意值编译） */
const HIDE_SCROLLBAR = "scrollbar-hide"

type Detail = Awaited<ReturnType<typeof getRunItemDetailAction>>
type Round = Detail["rounds"][number]

const SOURCE_LABEL: Record<string, string> = {
  initial: "初稿",
  ai: "AI 撰写",
  final: "终稿",
  auto_revise: "打回改写",
  manual: "手动",
}

function VerdictBadge({ verdict }: { verdict: string }) {
  if (verdict === "approve") {
    return <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">放行</Badge>
  }
  if (verdict === "retry") {
    return <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-300">打回重试</Badge>
  }
  return <Badge variant="secondary" className="bg-red-500/15 text-red-600 dark:text-red-300">兜底/失败</Badge>
}

/** 轮次信息 chip：第 N 轮 · 来源 · 终版 · 候选数 */
function RoundInfoChip({ round, isFinal, className }: { round: Round; isFinal: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[10px] text-white backdrop-blur", className)}>
      第 {round.roundNumber} 轮
      <span className="text-white/60">· {SOURCE_LABEL[round.promptSource] ?? round.promptSource}</span>
      {isFinal && <span className="rounded-full bg-emerald-500/80 px-1.5 py-px font-medium">终版</span>}
      {round.candidates.length > 1 && <span className="text-white/60">· {round.candidates.length} 候选</span>}
    </span>
  )
}

export function RunItemDetailDialog({
  itemId,
  open,
  onOpenChange,
  onChanged,
}: {
  itemId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 确认/重开后通知父级刷新运行状态 */
  onChanged: () => void
}) {
  const { confirmItem, getRunItemDetail, regenItem, updateItemPrompt } = useWorkspaceActions()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null)
  // 终稿编辑态（编辑 item.currentPrompt；后续生图沿用编辑后版本）
  const [promptEditing, setPromptEditing] = useState(false)
  const [promptDraft, setPromptDraft] = useState("")
  const [promptSaving, setPromptSaving] = useState(false)

  const load = useCallback(
    async (id: string) => {
      setLoading(true)
      // 先清上一张卡的旧数据：加载期间不再闪现陈旧卡名/轮次/评分
      setDetail(null)
      // 同时丢弃上一张卡残留的提示词编辑态（组件常驻挂载，state 不随关弹窗销毁），
      // 防止 A 卡草稿被 savePrompt 静默写入 B 卡 currentPrompt
      setPromptEditing(false)
      setPromptDraft("")
      try {
        const next = await getRunItemDetail(id)
        setDetail(next)
        // 默认选中终版轮（已选定时不再跳回最新轮）；否则最新有图轮
        const finalRound = next.item.finalRoundId
          ? next.rounds.find((r) => r.id === next.item.finalRoundId)
          : null
        const withImage = [...next.rounds].reverse().find((r) => r.imageUrl)
        setActiveRoundId(
          (finalRound ?? withImage ?? next.rounds[next.rounds.length - 1])?.id ?? null,
        )
      } catch (error) {
        // 失败明确报错（与 doConfirm 一致），不再静默伪装成「还没有生成记录」
        toast.error(error instanceof Error ? error.message : "加载卡面详情失败")
        setDetail(null)
      } finally {
        setLoading(false)
      }
    },
    [getRunItemDetail],
  )

  useEffect(() => {
    if (open && itemId) void load(itemId)
  }, [open, itemId, load])

  const canConfirm =
    detail &&
    // failed 可改选：生图失败的卡若有历史成图轮，直接确认其一为终稿
    ["waiting_human", "fallback", "approved_by_ai", "confirmed", "failed"].includes(detail.item.status)
  const canRegen =
    detail &&
    !["pending", "drafting", "generating", "reviewing"].includes(detail.item.status)

  const doConfirm = async (roundId: string) => {
    if (!itemId) return
    setActing(true)
    try {
      await confirmItem({ itemId, roundId })
      toast.success("已确认该轮为终版")
      await load(itemId)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "确认失败")
    } finally {
      setActing(false)
    }
  }

  const doRegen = async () => {
    if (!itemId) return
    setActing(true)
    try {
      const result = await regenItem({ itemId })
      // 业务失败以返回值传达（生产环境 throw 会被抹为 #441 占位文案）
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("已重新提交该卡执行流水线")
      onOpenChange(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重开失败")
    } finally {
      setActing(false)
    }
  }

  const savePrompt = async () => {
    if (!itemId) return
    setPromptSaving(true)
    try {
      await updateItemPrompt({ itemId, prompt: promptDraft })
      toast.success("终稿已保存，后续生图将使用编辑后的版本")
      setPromptEditing(false)
      await load(itemId)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setPromptSaving(false)
    }
  }

  const statusMeta = detail ? ITEM_STATUS_META[detail.item.status] : null
  const roundsDesc = detail ? [...detail.rounds].reverse() : []
  const activeRound = detail?.rounds.find((r) => r.id === activeRoundId) ?? roundsDesc[0] ?? null
  const activeReviews = activeRound
    ? detail!.reviews.filter((r) => r.roundId === activeRound.id)
    : []
  const activeReviewRows = activeReviews.filter((r) => r.kind === "review")
  const activeVerdict = activeReviews.find((r) => r.kind === "verdict")
  // 评审分组（按快照评审节点顺序「评审 N · 模型名」；快照缺失/旧数据回退单组平铺）
  const reviewGroups = (() => {
    if (!detail) return []
    const groups = (detail.reviewModels ?? [])
      .map((m) => ({
        key: m.nodeKey,
        label: m.label,
        modelName: m.modelName,
        rows: activeReviewRows.filter((r) => r.nodeKey === m.nodeKey),
      }))
      .filter((g) => g.rows.length > 0)
    const knownKeys = new Set(groups.map((g) => g.key))
    const orphanRows = activeReviewRows.filter((r) => !knownKeys.has(r.nodeKey))
    if (orphanRows.length > 0) {
      groups.push({ key: "__legacy__", label: "评审", modelName: "", rows: orphanRows })
    }
    return groups
  })()
  // 每维综合结果（多评审时展示：平均分 + 多数票 x/N，与 supervisor 判定同口径）
  const reviewAggregate = detail
    ? (
        [
          { key: "content", label: "内容审核" },
          { key: "aesthetic", label: "审美" },
          { key: "consistency", label: "一致性" },
        ] as const
      )
        .map(({ key, label }) => {
          const rows = activeReviewRows.filter((r) => (r.result as ReviewResultPayload).dimension === key)
          if (rows.length === 0) return null
          const scores = rows
            .map((r) => (r.result as ReviewResultPayload).score)
            .filter((s): s is number => typeof s === "number")
          const passes = rows.filter((r) => (r.result as ReviewResultPayload).pass === true).length
          const avg = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null
          const threshold =
            key === "aesthetic"
              ? detail.thresholds.aesthetic
              : key === "consistency"
                ? detail.thresholds.consistency
                : (detail.thresholds.content ?? DEFAULT_SCORE_THRESHOLDS.content)
          // 多数票：严格过半才通过（与 majorityVotePassed 一致）
          const passed = passes > rows.length / 2
          return {
            key,
            label,
            avg,
            passes,
            total: rows.length,
            threshold,
            passed,
            tone: avg !== null ? scoreTone(avg, threshold) : passed ? "pass" : "low",
          }
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : []
  const activeIsFinal = !!(detail && activeRound && detail.item.finalRoundId === activeRound.id)

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // 关弹窗即丢弃编辑草稿（组件常驻挂载，state 不随关闭销毁）
        if (!v) {
          setPromptEditing(false)
          setPromptDraft("")
        }
        onOpenChange(v)
      }}
    >
      {/* 固定高度用内联 style（85vh 任意值类曾因 dev CSS 产物陈旧失效） */}
      <DialogContent
        className="flex flex-col gap-3 overflow-hidden sm:max-w-5xl"
        style={{ height: "85vh" }}
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {detail?.item.name ? `「${detail.item.name}」` : `第 ${(detail?.item.index ?? 0) + 1} 张`}
            {statusMeta && <Badge variant="secondary" className={statusMeta.badge}>{statusMeta.label}</Badge>}
            {detail?.item.isSample && (
              <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-300">
                风格小样
              </Badge>
            )}
            {detail && detail.rounds.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">共 {detail.rounds.length} 轮修改记录</span>
            )}
            {detail?.item.fallbackContentWarning && (
              <Badge variant="secondary" className="gap-1 bg-red-500/15 text-red-600 dark:text-red-300">
                <ShieldAlert className="size-3" />
                兜底选中轮内容审核未通过
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            左侧为当前选中轮大图，中间为评分与裁决，右侧切换轮次
            {canConfirm ? "；可确认任意一轮为终版" : ""}
          </DialogDescription>
        </DialogHeader>

        {loading && !detail ? (
          <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
        ) : !detail || detail.rounds.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">还没有生成记录</p>
        ) : (
          /* 无条件三列 grid（不做断点切换，任何屏宽恒为 左图/中评审/右轮次）。
             列宽用内联 style：不依赖 Tailwind 任意值类编译（dev CSS 产物
             陈旧时 grid-cols-[…] 缺失会让 grid 退化为默认单列） */
          <div
            className="grid min-h-0 flex-1 gap-4 overflow-hidden"
            style={{ gridTemplateColumns: "minmax(0,300px) minmax(0,1fr) minmax(148px,188px)" }}
          >
            {/* 左列：固定列宽区域完整比例展示当前轮大图（与内容区等高，可留白） */}
            <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
              {activeRound?.imageUrl ? (
                <>
                  <a href={activeRound.imageUrl} target="_blank" rel="noreferrer" title="查看原图" className="flex size-full items-center justify-center">
                    <img
                      src={activeRound.imageUrl}
                      alt={`第 ${activeRound.roundNumber} 轮成图`}
                      className="max-h-full max-w-full object-contain"
                    />
                  </a>
                  <RoundInfoChip round={activeRound} isFinal={activeIsFinal} className="absolute bottom-2.5 left-2.5" />
                </>
              ) : (
                <p className="px-4 text-center text-[11px] text-muted-foreground">
                  本轮未成图（生图失败或被跳过）
                </p>
              )}
            </div>

            {/* 中列：当前选中轮评分（内部隐藏滚动） */}
            <div className={cn("min-h-0 space-y-3 overflow-y-auto pr-1", HIDE_SCROLLBAR)}>

                {/* 提示词终稿（可编辑——AI 生图拒答时可改写后重开）+ 查看原图入口 */}
                {activeRound && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-muted-foreground">提示词终稿</span>
                      {promptEditing ? (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={promptSaving || promptDraft.trim().length < 10}
                            onClick={() => void savePrompt()}
                          >
                            {promptSaving ? "保存中…" : "保存"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[11px]"
                            disabled={promptSaving}
                            onClick={() => setPromptEditing(false)}
                          >
                            取消
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
                          onClick={() => {
                            setPromptDraft(detail.item.currentPrompt ?? activeRound.prompt ?? "")
                            setPromptEditing(true)
                          }}
                        >
                          <Pencil className="size-3" />
                          编辑
                        </Button>
                      )}
                    </div>
                    {promptEditing ? (
                      <div className="space-y-1">
                        <Textarea
                          value={promptDraft}
                          onChange={(event) => setPromptDraft(event.target.value)}
                          maxLength={8000}
                          className="min-h-28 text-[11px] leading-4"
                        />
                        <p className="text-[10px] leading-4 text-muted-foreground">
                          编辑的是终稿底本（currentPrompt）：保存后通过「手动重开」或批量重试重新生图时生效。
                        </p>
                      </div>
                    ) : (
                      <p
                        className={cn(
                          "overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-2 text-[11px] leading-4 text-muted-foreground",
                          HIDE_SCROLLBAR,
                        )}
                        style={{ maxHeight: "7rem" }}
                      >
                        {activeRound.prompt}
                      </p>
                    )}
                    {activeRound.imageUrl && (
                      <a
                        href={activeRound.imageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-violet-600 dark:hover:text-violet-300"
                      >
                        <ExternalLink className="size-3" />
                        查看原图
                      </a>
                    )}
                  </div>
                )}

                {/* 评审展示（多评审分组）：顶部每维综合结果（平均分 + 多数票，与
                    supervisor 判定同口径）→ 按「评审 N · 模型名」分组的原始评分行。
                    绿=达到及格线 / 黄=未达线但 ≥60 / 红=<60 或不通过；
                    内容审核同样展示 0-100 分数柱（存量无分数据回退仅文字） */}
                {activeReviewRows.length > 0 ? (
                  <div className="space-y-3">
                    {/* 综合判定（仅多评审时展示；单评审无需聚合） */}
                    {reviewGroups.length > 1 && reviewAggregate.length > 0 && (
                      <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/[0.05] p-2.5">
                        <p className="text-[11px] font-medium text-muted-foreground">
                          综合判定（多数票，各维度过半数即通过）
                        </p>
                        {reviewAggregate.map((agg) => (
                          <div key={agg.key} className="flex flex-wrap items-center gap-1.5 text-xs">
                            {agg.passed ? (
                              <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />
                            ) : (
                              <Circle className="size-3.5 shrink-0 text-red-500" />
                            )}
                            <span className="font-medium">{agg.label}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {agg.avg !== null ? `平均 ${agg.avg} 分` : "无分数"} · 通过票 {agg.passes}/{agg.total}
                              （及格线 {agg.threshold}）
                            </span>
                            <span
                              className={cn(
                                "ml-auto text-[11px]",
                                agg.passed ? "text-green-600 dark:text-green-400" : "text-red-500",
                              )}
                            >
                              {agg.passed ? "过半通过" : "未过半"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 按评审员分组的原始评分行 */}
                    {reviewGroups.map((group) => (
                      <div key={group.key} className="space-y-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Users className="size-3 text-violet-500" />
                          <span className="text-[11px] font-semibold">{group.label}</span>
                          {group.modelName && (
                            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                              · {group.modelName}
                            </span>
                          )}
                        </div>
                        <div className="space-y-2.5">
                          {group.rows.map((r, index) => {
                            const res = r.result as ReviewResultPayload
                            const threshold =
                              res.dimension === "aesthetic"
                                ? detail!.thresholds.aesthetic
                                : res.dimension === "consistency"
                                  ? detail!.thresholds.consistency
                                  : (detail!.thresholds.content ?? DEFAULT_SCORE_THRESHOLDS.content)
                            const status =
                              res.score !== null
                                ? scoreTone(res.score, threshold)
                                : res.pass === false
                                  ? "low"
                                  : "pass"
                            const hasScore = res.score !== null
                            const label =
                              res.dimension === "content" ? "内容审核" : SCORE_DIMENSION_LABELS[res.dimension]
                            const statusText =
                              status === "pass" ? "通过" : status === "warn" ? "接近及格" : "未通过"
                            return (
                              <div
                                key={r.id}
                                className={cn("flex flex-col gap-1", index > 0 && "border-t pt-2.5")}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  {status === "pass" ? (
                                    <CheckCircle2 className="size-4 shrink-0 text-green-500" />
                                  ) : status === "warn" ? (
                                    <AlertTriangle className="size-4 shrink-0 text-yellow-500" />
                                  ) : (
                                    <Circle className="size-4 shrink-0 text-red-500" />
                                  )}
                                  <span className="text-xs font-medium">{label}</span>
                                  <span className="text-[11px] text-muted-foreground">{statusText}</span>
                                  <span className="ml-auto text-sm font-semibold tabular-nums">
                                    {hasScore ? `${res.score} 分` : statusText}
                                  </span>
                                </div>
                                {hasScore && (
                                  <ScoreSegmentsBar
                                    label={label}
                                    score={res.score}
                                    threshold={threshold}
                                  />
                                )}
                                {res.reason && (
                                  <p className="text-[11px] leading-4 text-muted-foreground">{res.reason}</p>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  activeRound && (
                    <p className="rounded-lg border border-dashed p-2.5 text-[11px] text-muted-foreground">
                      本轮暂无评审记录
                    </p>
                  )
                )}

                {/* 候选（多候选时） */}
                {activeRound && activeRound.candidates.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">候选：</span>
                    {activeRound.candidates.map((c, i) => {
                      const selected = c.url === activeRound.imageUrl
                      return (
                        <span
                          key={c.url + i}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                            selected
                              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                              : "border-border text-muted-foreground",
                          )}
                        >
                          #{i + 1}
                          {c.score !== null && ` ${c.score}分`}
                          {c.contentPass === false && " 内容✗"}
                          {selected && " ✓"}
                        </span>
                      )
                    })}
                  </div>
                )}

                {/* 裁决 */}
                {activeVerdict && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
                    <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
                      <VerdictBadge verdict={(activeVerdict.result as VerdictPayload).verdict} />
                    </span>
                    <span className="min-w-0 leading-5 text-muted-foreground">
                      {(activeVerdict.result as VerdictPayload).detail}
                    </span>
                  </div>
                )}

                {/* 无图轮提示（左列大图空态时中列兜底说明） */}
                {activeRound && !activeRound.imageUrl && (
                  <p className="rounded-lg border border-dashed p-2.5 text-[11px] text-muted-foreground">
                    本轮未成图（生图失败或被跳过），可查看上方评审记录
                  </p>
                )}

                {detail.item.errorMessage && (
                  <p className="rounded-md bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
                    {detail.item.errorMessage}
                  </p>
                )}
              </div>

              {/* 右列：轮次列表（最新在上，点击切换） */}
              <nav
                aria-label="轮次列表"
                className={cn("min-h-0 space-y-1.5 overflow-y-auto border-l pl-3", HIDE_SCROLLBAR)}
              >
                {roundsDesc.map((round) => {
                  const isFinal = detail.item.finalRoundId === round.id
                  const active = round.id === activeRound?.id
                  const hasVerdictFail = detail.reviews.some(
                    (r) =>
                      r.roundId === round.id &&
                      r.kind === "verdict" &&
                      (r.result as VerdictPayload).verdict !== "approve",
                  )
                  return (
                    <button
                      key={round.id}
                      type="button"
                      onClick={() => setActiveRoundId(round.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "relative flex w-full items-center gap-2 overflow-hidden rounded-lg border p-1.5 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60",
                        active
                          ? "border-violet-500/50 bg-violet-500/[0.07]"
                          : "border-transparent hover:bg-muted/60",
                      )}
                    >
                      {/* 左缘状态色条：终版绿 / 有打回黄 / 其余灰 */}
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-y-1 left-0 w-1 rounded-full",
                          isFinal ? "bg-emerald-500" : hasVerdictFail ? "bg-amber-500" : "bg-muted-foreground/25",
                        )}
                      />
                      <div className="ml-1 size-11 shrink-0 overflow-hidden rounded-md bg-muted">
                        {round.imageUrl ? (
                          <img
                            src={round.imageUrl}
                            alt={`第 ${round.roundNumber} 轮`}
                            className="size-full object-cover"
                          />
                        ) : (
                          <div className="flex size-full items-center justify-center text-[9px] text-muted-foreground">
                            无图
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1 text-xs font-medium">
                          第 {round.roundNumber} 轮
                          {isFinal && (
                            <Badge
                              variant="secondary"
                              className="h-4 bg-emerald-500/15 px-1 text-[9px] text-emerald-600 dark:text-emerald-300"
                            >
                              终版
                            </Badge>
                          )}
                        </p>
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {SOURCE_LABEL[round.promptSource] ?? round.promptSource}
                          {round.candidates.length > 1 ? ` · ${round.candidates.length} 候选` : ""}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </nav>
            </div>
          )}

          {detail && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                已打回 {detail.item.roundsUsed} 轮
                {detail.item.manualRegenCount > 0 ? ` · 手动重开 ${detail.item.manualRegenCount} 次` : ""}
              </p>
              <div className="flex gap-2">
                {canConfirm && activeRound?.imageUrl && !(activeIsFinal && detail.item.status === "confirmed") && (
                  <Button
                    size="sm"
                    variant={detail.item.status === "waiting_human" ? "default" : "outline"}
                    disabled={acting}
                    onClick={() => void doConfirm(activeRound.id)}
                  >
                    确认第 {activeRound.roundNumber} 轮为终版
                  </Button>
                )}
                {canRegen && (
                  <Button variant="outline" size="sm" disabled={acting} onClick={() => void doRegen()}>
                    <RefreshCcw className="size-3.5" />
                    手动重开
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
  )
}
