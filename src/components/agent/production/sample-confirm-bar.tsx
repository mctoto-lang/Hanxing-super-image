"use client"

/**
 * 小样确认横幅（art 阶段 · phase=sample 收口后展示；自旧版 RunBoard
 * waiting_style 横幅迁移，改为模板 waiting_human 语义）：
 * 小样全部终态且至少一张成图 → 展示缩略图 +「确认小样，开始全套」；
 * 小样全部失败 → 展示失败提示 + 重试入口。
 */
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react"
/* 小样成图 URL 可能来自本地存储或 COS，使用原生 img 兼容两类地址。 */
/* eslint-disable @next/next/no-img-element */
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ITEM_STATUS_META } from "../canvas-shared"
import type { TemplateWorkspaceData } from "../use-template-workspace"
import { useWorkspaceActions } from "../workspace-actions"

const OK_STATUSES = ["approved_by_ai", "fallback", "confirmed"] as const
const BUSY_ITEM_STATUSES = ["pending", "drafting", "generating", "reviewing"] as const

/** 是否到达小样确认关口（stage=art + 小样全部终态） */
export function sampleGateReached(data: TemplateWorkspaceData): boolean {
  const { run, items } = data
  if (run.stage !== "art" || run.phase !== "sample") return false
  const samples = items.filter((item) => item.isSample)
  if (samples.length === 0) return false
  return !samples.some((item) => BUSY_ITEM_STATUSES.includes(item.status as (typeof BUSY_ITEM_STATUSES)[number]))
}

/** 小样卡缩略图（横幅内嵌；点击打开逐轮回放） */
function SampleThumb({
  item,
  onClick,
}: {
  item: TemplateWorkspaceData["items"][number]
  onClick: () => void
}) {
  const meta = ITEM_STATUS_META[item.status] ?? ITEM_STATUS_META.pending!
  return (
    <button
      onClick={onClick}
      className="group relative w-[92px] overflow-hidden rounded-xl border bg-muted/40 p-1.5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-1.5 aspect-[3/4] w-full overflow-hidden rounded-lg">
        {item.latestImageUrl ? (
          <img
            src={item.latestImageUrl}
            alt={item.name ?? `第 ${item.index + 1} 张`}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-[10px] text-red-500">
            {item.status === "failed" ? "失败" : "无图"}
          </div>
        )}
      </div>
      <div className="truncate px-0.5 text-[10px] font-medium">{item.name ?? `第 ${item.index + 1} 张`}</div>
      <span className="absolute left-2 top-2 rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-medium text-white shadow-sm">
        小样
      </span>
      <span className={cn("absolute bottom-6 right-1.5 rounded px-1 py-0.5 text-[9px] text-white", meta.bg)}>
        {meta.label}
      </span>
    </button>
  )
}

export interface ArtStageAction {
  (fn: () => Promise<unknown>, successMessage?: string): Promise<boolean>
}

export function SampleConfirmBar({
  data,
  busy,
  onOpenItem,
  runAction,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  onOpenItem: (itemId: string) => void
  runAction: ArtStageAction
}) {
  const { confirmSampleBatch, retryTemplateAction } = useWorkspaceActions()
  const samples = data.items.filter((item) => item.isSample)
  const okSamples = samples.filter((item) => OK_STATUSES.includes(item.status as (typeof OK_STATUSES)[number]))
  const allFailed = okSamples.length === 0

  // 全部失败：定向提示 + 重试（详细错误由工作台顶部错误横幅展示）
  if (allFailed) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
        <AlertTriangle className="size-4 shrink-0 text-red-500" />
        <p className="min-w-0 flex-1 text-sm">风格小样全部失败。可重试重新生产，或在卡面列表中逐张重开。</p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !data.run.pendingAction}
          onClick={() => void runAction(() => retryTemplateAction(data.run.id), "已重新提交小样生产")}
        >
          重试小样
        </Button>
      </div>
    )
  }

  const remaining = data.items.length - samples.length

  return (
    <div className="space-y-2.5 rounded-xl border border-amber-500/20 bg-gradient-to-r from-amber-500/[0.08] via-amber-500/[0.03] to-transparent px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15">
          <Sparkles className="size-4 text-amber-500" />
        </span>
        <span className="text-sm font-medium">风格小样已完成，请确认风格</span>
        <span className="text-xs text-muted-foreground">
          确认后自动生产其余 {remaining} 张；小样终图将作为成套一致性基准
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 text-xs text-emerald-600 sm:flex dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            {okSamples.length}/{samples.length} 张成图
          </span>
          <Button
            size="sm"
            className="bg-amber-500 text-white hover:bg-amber-600"
            disabled={busy}
            onClick={() => void runAction(() => confirmSampleBatch(data.run.id), "小样已确认，开始全套生产")}
          >
            确认小样，开始全套
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2.5">
        {samples.map((item) => (
          <SampleThumb key={item.id} item={item} onClick={() => onOpenItem(item.id)} />
        ))}
      </div>
    </div>
  )
}
