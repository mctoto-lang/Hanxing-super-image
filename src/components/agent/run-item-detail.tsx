"use client"

/* 生成图 URL 可能来自本地存储或 COS，使用原生 img 兼容两类地址。 */
/* eslint-disable @next/next/no-img-element */

/**
 * 单卡逐轮回放弹窗（V1 左右分栏结构 + 外置画布）：
 * - 弹窗居中（5xl）：左主区 = 当前选中轮的评分展示（提示词/内容·审美·一致性
 *   评审卡/候选/裁决），右窄列 = 轮次缩略图列表（点击切换，终版标记 +
 *   左缘状态色条）；
 * - 外置画布：大图完整比例独立展示在弹窗左侧外（紧贴弹窗左边 16px，
 *   2xl+ 视口显示；随弹窗开合出现，切轮次同步）；窄于 2xl 时主区顶部
 *   内嵌简版大图回退；
 * - 底部操作：确认当前轮为终版 / 手动重开（readOnly 时隐藏）。
 */
import { useCallback, useEffect, useState } from "react"
import { ExternalLink, RefreshCcw, ShieldAlert } from "lucide-react"
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
import type { getRunItemDetailAction } from "@/server/actions/agent"
import { ITEM_STATUS_META } from "./canvas-shared"
import { useWorkspaceActions } from "./workspace-actions"
import { ScoreBar } from "./score-bar"
import {
  DEFAULT_SCORE_THRESHOLDS,
  SCORE_DIMENSION_LABELS,
} from "@/lib/agent/score"
import type { ReviewResultPayload, VerdictPayload } from "@/lib/agent/graph"

type Detail = Awaited<ReturnType<typeof getRunItemDetailAction>>
type Round = Detail["rounds"][number]

const SOURCE_LABEL: Record<string, string> = {
  initial: "初稿",
  auto_revise: "打回改写",
  manual: "手动",
}

/** 弹窗半宽（sm:max-w-5xl = 1024px）+ 16px 间距 → 画布右缘偏移 528px */
const CANVAS_RIGHT = "calc(50% + 528px)"

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

/**
 * 外置画布：大图完整比例独立展示在弹窗左侧外（紧贴弹窗，纯展示）。
 * 宽度随视口自适应（2xl+ 显示），与弹窗开合/轮次切换联动。
 */
function ImageCanvas({ round, isFinal }: { round: Round; isFinal: boolean }) {
  if (!round.imageUrl) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed top-1/2 z-[60] hidden -translate-y-1/2 2xl:block"
      style={{ right: CANVAS_RIGHT, width: "min(440px, calc(50vw - 544px))" }}
    >
      <div className="relative overflow-hidden rounded-xl bg-black/80 shadow-2xl">
        <img
          src={round.imageUrl}
          alt={`第 ${round.roundNumber} 轮成图`}
          className="max-h-[78vh] w-full object-contain"
        />
        <RoundInfoChip round={round} isFinal={isFinal} className="absolute bottom-2.5 left-2.5" />
      </div>
    </div>
  )
}

export function RunItemDetailDialog({
  itemId,
  open,
  onOpenChange,
  onChanged,
  readOnly = false,
}: {
  itemId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 确认/重开后通知父级刷新运行状态 */
  onChanged: () => void
  /** 只读模式：隐藏确认/重开操作，仅回放 */
  readOnly?: boolean
}) {
  const { confirmItem, getRunItemDetail, regenItem } = useWorkspaceActions()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null)

  const load = useCallback(
    async (id: string) => {
      setLoading(true)
      // 先清上一张卡的旧数据：加载期间不再闪现陈旧卡名/轮次/评分
      setDetail(null)
      try {
        const next = await getRunItemDetail(id)
        setDetail(next)
        // 默认选中最新一轮（有图优先）
        const withImage = [...next.rounds].reverse().find((r) => r.imageUrl)
        setActiveRoundId((withImage ?? next.rounds[next.rounds.length - 1])?.id ?? null)
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
    !readOnly &&
    detail &&
    ["waiting_human", "fallback", "approved_by_ai", "confirmed"].includes(detail.item.status)
  const canRegen =
    !readOnly &&
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
      await regenItem({ itemId })
      toast.success("已重新提交该卡执行流水线")
      onOpenChange(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重开失败")
    } finally {
      setActing(false)
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
  const activeIsFinal = !!(detail && activeRound && detail.item.finalRoundId === activeRound.id)

  return (
    <>
      {/* 外置画布：紧贴弹窗左侧的大图（2xl+；随弹窗开合出现，切轮同步） */}
      {open && detail && activeRound && <ImageCanvas round={activeRound} isFinal={activeIsFinal} />}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-3 overflow-hidden sm:max-w-5xl">
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
              左侧为当前选中轮的评分与裁决，右侧切换轮次（大屏下弹窗左侧同步展示大图）
              {canConfirm ? "；可确认任意一轮为终版" : ""}
            </DialogDescription>
          </DialogHeader>

          {loading && !detail ? (
            <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
          ) : !detail || detail.rounds.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">还没有生成记录</p>
          ) : (
            <div className="grid min-h-0 flex-1 gap-4 overflow-hidden md:grid-cols-[minmax(0,1fr)_188px]">
              {/* 主区：当前选中轮评分（<2xl 时顶部内嵌简版大图回退） */}
              <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
                {activeRound?.imageUrl && (
                  <div className="relative overflow-hidden rounded-xl bg-muted 2xl:hidden">
                    <a href={activeRound.imageUrl} target="_blank" rel="noreferrer" title="查看原图">
                      <img
                        src={activeRound.imageUrl}
                        alt={`第 ${activeRound.roundNumber} 轮成图`}
                        className="max-h-56 w-full object-contain"
                      />
                    </a>
                    <RoundInfoChip round={activeRound} isFinal={activeIsFinal} className="absolute bottom-2 left-2" />
                  </div>
                )}

                {/* 提示词摘要 + 查看原图（2xl 大图外置时的入口） */}
                {activeRound && (
                  <div className="space-y-1">
                    <p
                      className="line-clamp-2 break-all rounded-lg bg-muted/60 p-2 text-[11px] leading-4 text-muted-foreground"
                      title={activeRound.prompt}
                    >
                      {activeRound.prompt}
                    </p>
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

                {/* 各维度评审卡（多评审同维多行，逐行展示各评审结论） */}
                {activeReviewRows.length > 0 ? (
                  <div className="space-y-2">
                    {activeReviewRows.map((r) => {
                      const res = r.result as ReviewResultPayload
                      const threshold =
                        res.dimension === "aesthetic"
                          ? detail.thresholds.aesthetic
                          : res.dimension === "consistency"
                            ? detail.thresholds.consistency
                            : DEFAULT_SCORE_THRESHOLDS.content
                      return (
                        <div key={r.id} className="rounded-lg border p-2.5">
                          {res.dimension === "content" ? (
                            <div className="space-y-1">
                              <Badge
                                variant="secondary"
                                className={
                                  res.pass === false
                                    ? "bg-red-500/15 text-red-600 dark:text-red-300"
                                    : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                                }
                              >
                                内容审核{res.pass === false ? " 不通过" : " 通过"}
                              </Badge>
                              {res.reason && (
                                <p className="text-[11px] leading-4 text-muted-foreground">{res.reason}</p>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              {res.pass === false && (
                                <Badge variant="secondary" className="bg-red-500/15 text-red-600 dark:text-red-300">
                                  未通过
                                </Badge>
                              )}
                              <ScoreBar
                                label={SCORE_DIMENSION_LABELS[res.dimension]}
                                score={res.score}
                                threshold={threshold}
                                size="sm"
                              />
                              {res.reason && (
                                <p className="text-[11px] leading-4 text-muted-foreground">{res.reason}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
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

                {/* 无图轮提示（外置画布空态） */}
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
              <nav aria-label="轮次列表" className="min-h-0 space-y-1.5 overflow-y-auto border-l pl-3">
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
                {readOnly ? " · 只读" : ""}
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
    </>
  )
}
