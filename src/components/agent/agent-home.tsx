"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Bot,
  Check,
  FlaskConical,
  Loader2,
  LockKeyhole,
  MessageCircleQuestion,
  Package,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SmartImage } from "@/components/ui/smart-image"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { cn, toImageSrc } from "@/lib/utils"
import type { AgentDirection } from "@/lib/agent/graph"
import { deleteRunAction, listRunsAction } from "@/server/actions/agent"
import { DIRECTION_CARDS } from "./team"
import { RUN_STATUS_META, directionName } from "./canvas-shared"
import { TarotTemplateStartDialog } from "./tarot-template-start-dialog"

export type DirectionCardInfo = {
  key: AgentDirection
  name: string
  description: string
  fixedCount: number | null
  countOptions?: number[]
  defaultCount: number
  sampleNote: string
  enabled: boolean
  sampleEnabled: boolean
  sampleCount: number
  ready: boolean
  notReadyReason: string | null
  /** 质量默认值（管理员配置；发起弹窗「标准」档与滑块初始值） */
  qualityDefaults: {
    contentThreshold: number
    aestheticThreshold: number
    consistencyThreshold: number
    maxRetries: number
  } | null
}

export type RunHistoryItem = {
  id: string
  direction: string | null
  status: string
  phase: string
  prompt: string
  cardCount: number
  costCenticredits: number
  imageCostCredits: number
  llmCallCount: number
  imageCount: number
  createdAt: Date | string
  finishedAt: Date | string | null
  /** 项目封面（第一张有图的卡牌；优先套框合成图） */
  coverImageUrl: string | null
  itemStats: { status: string; count: number }[]
}

const DONE_STATUSES = ["confirmed", "approved_by_ai", "fallback"]
const ACTIVE_STATUSES = ["queued", "running"]

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期（跨年含年份） */
function formatRelativeTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return "昨天"
  if (diffHour < 24 * 7) return `${Math.floor(diffHour / 24)} 天前`
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
  })
}

/** 方形模板卡（参考穿戴历史封面卡结构：封面 + 底部紧凑信息行） */
function TemplateSquareCard({
  directionKey,
  name,
  countLabel,
  locked,
  clickable,
  ready,
  onSelect,
}: {
  directionKey: AgentDirection
  name: string
  countLabel: string
  /** 未上线方向：封面加「即将上线」遮罩 */
  locked: boolean
  /** 可进入创建流程（塔罗且后台已配置） */
  clickable: boolean
  ready: boolean
  onSelect?: () => void
}) {
  const meta = DIRECTION_CARDS[directionKey]
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onSelect}
      aria-label={clickable ? `使用${name}模板` : `${name}模板不可用`}
      className={cn(
        "group overflow-hidden rounded-xl border bg-card text-left transition-all duration-200",
        clickable
          ? "hover:-translate-y-0.5 hover:border-violet-500/40 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
          : locked
            ? "cursor-not-allowed opacity-80"
            : "cursor-not-allowed",
      )}
    >
      <div className={cn("relative aspect-square w-full overflow-hidden", meta.coverClass)}>
        {/* 星点纹理（塔罗保留特色纹理，其余方向用柔光） */}
        {directionKey === "tarot" ? (
          <div className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_20%_20%,white_1px,transparent_1px),radial-gradient(circle_at_80%_70%,white_1px,transparent_1px)] [background-size:28px_28px]" />
        ) : (
          <div className="absolute -right-12 -top-12 size-40 rounded-full bg-white/10 blur-2xl" />
        )}
        <div className="relative flex h-full flex-col items-center justify-center gap-3 p-4 text-white">
          <span className="text-6xl drop-shadow-lg">{meta.emoji}</span>
          <span className="text-sm font-medium tracking-wide text-white/85">{name}</span>
        </div>
        {/* 张数角标 */}
        <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
          {countLabel}
        </span>
        {/* 锁定遮罩 */}
        {locked && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
            <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white shadow-sm">
              <LockKeyhole className="size-3.5" /> 即将上线
            </span>
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 p-3">
        <span className="truncate text-sm font-medium">{name}</span>
        {locked ? (
          <span className="shrink-0 rounded-[3px] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            敬请期待
          </span>
        ) : (
          <Badge
            variant="secondary"
            className={cn(
              "shrink-0",
              ready
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
            )}
          >
            {ready ? "可使用" : "待配置"}
          </Badge>
        )}
      </div>
    </button>
  )
}

/** 项目历史卡（穿戴生成历史同款：方形封面 + 进度角标 + 紧凑信息行 + hover 删除） */
function RunHistoryCard({
  run,
  onOpen,
  onDelete,
}: {
  run: RunHistoryItem
  onOpen: () => void
  onDelete: () => void
}) {
  const meta = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.queued!
  const done = run.itemStats
    .filter((s) => DONE_STATUSES.includes(s.status))
    .reduce((sum, s) => sum + s.count, 0)
  const active = ACTIVE_STATUSES.includes(run.status)
  const emoji = run.direction === "tarot" ? "🌙" : run.direction === "oracle" ? "✨" : run.direction === "poker" ? "♠" : "🃏"

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`查看${directionName(run.direction)}项目`}
        className="block w-full overflow-hidden rounded-xl border bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-500/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60"
      >
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          {run.coverImageUrl ? (
            <SmartImage
              src={toImageSrc(run.coverImageUrl)}
              alt={directionName(run.direction)}
              className="h-full w-full object-cover"
            />
          ) : active ? (
            <div className="flex h-full w-full items-center justify-center">
              <MorphingInfinity className="size-8 text-muted-foreground" />
            </div>
          ) : (
            <div className={cn("flex h-full w-full flex-col items-center justify-center gap-2", DIRECTION_CARDS[run.direction as AgentDirection]?.coverClass ?? "bg-muted")}>
              <span className="text-4xl opacity-80">{emoji}</span>
              <span className="text-xs text-white/70">{meta.label}</span>
            </div>
          )}
          {/* 进度角标 */}
          <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
            {run.cardCount > 0 ? `${done}/${run.cardCount}` : `${run.imageCount} 图`}
          </span>
        </div>
        <div className="p-3">
          <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
            <span className="truncate">{directionName(run.direction)} 项目</span>
            <span className={cn("shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10px]", meta.badge)}>
              {meta.label}
            </span>
            <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
              {formatRelativeTime(run.createdAt)}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {run.prompt || "未填写创作描述"}
          </p>
        </div>
      </button>
      {!active && (
        <button
          type="button"
          aria-label="删除项目"
          title="删除项目"
          onClick={onDelete}
          className="absolute left-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity duration-200 hover:bg-red-600 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** 置顶「UI 预览」示例项目卡（Mock 数据，不占项目数；通往 /agent/preview） */
function PreviewProjectCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="打开 UI 预览项目（示例数据）"
      className="group relative block w-full overflow-hidden rounded-xl border border-dashed border-amber-500/50 bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-500 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
    >
      <div className={cn("relative aspect-square w-full overflow-hidden", DIRECTION_CARDS.tarot.coverClass)}>
        <div className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_20%_20%,white_1px,transparent_1px),radial-gradient(circle_at_80%_70%,white_1px,transparent_1px)] [background-size:28px_28px]" />
        <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 text-white">
          <span className="text-4xl drop-shadow-lg">🌙</span>
          <span className="flex items-center gap-1 text-xs font-medium tracking-wide text-white/85">
            <FlaskConical className="size-3.5 text-amber-300" />
            星月暗夜塔罗 · 示例
          </span>
        </div>
        <span className="absolute right-2 top-2 rounded-full bg-amber-500/90 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
          UI 预览
        </span>
      </div>
      <div className="p-3">
        <div className="flex min-w-0 items-center gap-1 text-sm font-medium">
          <span className="truncate">示例项目 · 全阶段走查</span>
          <span className="shrink-0 rounded-[3px] bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            Mock 数据
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          占位图片与文案，五阶段界面任意切换
        </p>
      </div>
    </button>
  )
}

const PAGE_SIZE = 20
const POLL_INTERVAL_MS = 5000

export function AgentHome({
  directions,
  initialRuns,
  initialCursor,
}: {
  directions: DirectionCardInfo[]
  initialRuns: RunHistoryItem[]
  initialCursor: string | null
}) {
  const router = useRouter()
  const [tarotStartOpen, setTarotStartOpen] = useState(false)
  const [runs, setRuns] = useState<RunHistoryItem[]>(initialRuns)
  const [cursor, setCursor] = useState<string | null>(initialCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RunHistoryItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const runsRef = useRef(runs)
  useEffect(() => {
    runsRef.current = runs
  }, [runs])
  /** 本会话内已删除的项目 id：在途轮询响应会把它们并回列表，必须持续过滤 */
  const deletedIdsRef = useRef<Set<string>>(new Set())

  const hasActive = runs.some((run) => ACTIVE_STATUSES.includes(run.status))

  /** 刷新项目列表（合并：最新一页覆盖同 id 旧数据，保留已加载的更多页） */
  const refreshRuns = useCallback(async () => {
    try {
      const result = await listRunsAction({ limit: Math.min(50, Math.max(PAGE_SIZE, runsRef.current.length)) })
      setRuns((prev) => {
        const freshIds = new Set(result.runs.map((r) => r.id))
        return [...result.runs, ...prev.filter((r) => !freshIds.has(r.id) && !deletedIdsRef.current.has(r.id))]
      })
      setCursor(result.nextCursor)
    } catch {
      // 轮询失败静默跳过本轮
    }
  }, [])

  // 有进行中项目时轮询（全部到达非活跃态后自动停止）
  useEffect(() => {
    if (!hasActive) return
    const timer = setInterval(() => void refreshRuns(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasActive, refreshRuns])

  const loadMore = async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await listRunsAction({ limit: PAGE_SIZE, cursor })
      setRuns((prev) => {
        const existingIds = new Set(prev.map((r) => r.id))
        return [...prev, ...result.runs.filter((r) => !existingIds.has(r.id))]
      })
      setCursor(result.nextCursor)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载失败")
    } finally {
      setLoadingMore(false)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteRunAction(deleteTarget.id)
      // 记入已删集合：删除请求与在途轮询的竞态响应会把该项目并回列表
      //（此后新页永远不含它，若不过滤将成为点开即 404 的幽灵项目）
      deletedIdsRef.current.add(deleteTarget.id)
      toast.success("项目已删除")
      setRuns((prev) => prev.filter((r) => r.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="w-full space-y-8 pb-8">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-violet-500/10 via-background to-amber-500/10 px-6 py-8 md:px-10">
        <div className="pointer-events-none absolute -right-20 -top-28 size-72 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-64 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_1px_1px,var(--border)_1px,transparent_0)] [background-size:22px_22px]" />
        <Link
          href="/agent/preview"
          className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full border bg-background/70 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:border-violet-400 hover:text-foreground"
        >
          <FlaskConical className="size-3.5 text-amber-500" /> UI 预览
        </Link>
        <div className="relative max-w-3xl animate-fade-slide-in-1">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
            <Bot className="size-3.5 text-violet-500" /> AI Agent 模板工坊
          </div>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            把一套卡牌，交给一支完整的 AI 团队
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
            先通过几组关键问题对齐需求，再确认内容方向、视觉资产和卡面小样。每个阶段都可回看、修改和确认，不再把
            78 张图一次性交给黑盒。
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {["预置工作流程", "预置 AI 角色", "分阶段确认", "人工可控交付"].map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-full bg-background/80 px-3 py-1.5 ring-1 ring-foreground/10"
              >
                <Check className="size-3.5 text-emerald-500" /> {label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* 模板库：三张方形模板卡 */}
      <section className="space-y-4 animate-fade-slide-in-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">选择一个模板开始</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              模板会固定角色分工和生产流程，你只需要提供创作方向并在关键节点做决定。
            </p>
          </div>
          <Badge variant="outline" className="hidden gap-1 md:inline-flex">
            <Package className="size-3.5" /> 模板库
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {directions.map((d) => (
            <TemplateSquareCard
              key={d.key}
              directionKey={d.key}
              name={d.name}
              countLabel={d.fixedCount ? `${d.fixedCount} 张` : `${d.countOptions?.at(-1) ?? d.defaultCount} 张`}
              locked={d.key !== "tarot"}
              clickable={d.key === "tarot" && d.ready}
              ready={d.ready}
              onSelect={d.key === "tarot" ? () => setTarotStartOpen(true) : undefined}
            />
          ))}
        </div>
      </section>

      {/* 我的项目：穿戴生成历史同款封面卡网格（进行中自动轮询 + 加载更多 + 删除） */}
      <section className="space-y-4 animate-fade-slide-in-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-xl font-semibold">我的项目</h2>
            <p className="mt-1 text-sm text-muted-foreground">继续处理中的项目，或回看已完成的交付。</p>
          </div>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {hasActive && <Loader2 className="size-3.5 animate-spin text-violet-500" />}
            {runs.length} 个项目
          </span>
        </div>
        {runs.length === 0 ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <PreviewProjectCard onOpen={() => router.push("/agent/preview")} />
            </div>
            <Empty className="rounded-2xl border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Package className="size-8 text-muted-foreground/60" />
                </EmptyMedia>
                <EmptyTitle>还没有真实项目</EmptyTitle>
                <EmptyDescription>可先打开「UI 预览」示例项目走查界面，或从塔罗牌模板开始创建第一套牌。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <PreviewProjectCard onOpen={() => router.push("/agent/preview")} />
              {runs.map((run) => (
                <RunHistoryCard
                  key={run.id}
                  run={run}
                  onOpen={() => router.push(`/agent/run/${run.id}`)}
                  onDelete={() => setDeleteTarget(run)}
                />
              ))}
            </div>
            {cursor && (
              <div className="flex justify-center pt-1">
                <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore && <Loader2 className="size-4 animate-spin" />}
                  加载更多
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <div className="flex items-center gap-2 rounded-xl border bg-muted/30 px-4 py-3 text-xs text-muted-foreground animate-fade-slide-in-4">
        <MessageCircleQuestion className="size-4 shrink-0 text-violet-500" />
        新模板会先询问缺失信息，再生成 3 个内容方向；任何阶段都可以暂停、修改或重新生成。
      </div>

      <TarotTemplateStartDialog
        open={tarotStartOpen}
        onOpenChange={setTarotStartOpen}
        qualityDefaults={directions.find((d) => d.key === "tarot")?.qualityDefaults ?? null}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除该项目？"
        description="将删除该项目的全部卡牌、生成轮次、审核记录与事件日志（存储图片文件按保留策略清理），操作不可恢复。"
        confirmText="删除"
        destructive
        pending={deleting}
        onConfirm={() => void doDelete()}
      />
    </div>
  )
}
