"use client"

import * as React from "react"
import {
  Boxes,
  History,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Sparkle,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { ImageViewer } from "@/components/ui/image-viewer"
import type { MockupBindingSetting } from "@/db/schema"
import type {
  MockupCardItemView,
  MockupCardView,
  MockupLibraryImage,
  MockupPageData,
  MockupSquareTaskView,
  MockupStatusUpdate,
} from "@/lib/mockup/types"
import {
  applyMockupAiBackgroundAction,
  deleteMockupCardAction,
  getMockupBackgroundStatusAction,
  getMockupStatusAction,
  renderCardItemAction,
  renderMockupCardsAction,
  submitMockupBackgroundAction,
} from "@/server/actions/mockup"
import { BindingDialog } from "./binding-dialog"
import { CardHistoryDialog } from "./card-history-dialog"
import { MockupHistoryPanel } from "./mockup-history-panel"
import { useMockupHistory } from "./use-mockup-history"
import {
  MockupOutputFormatSelect,
  type MockupOutputFormat,
} from "./output-format-select"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CreateCardDialog } from "./create-card-dialog"
import { ImageCompareDialog } from "./image-compare-dialog"
import {
  MockupGenerationConfigButton,
  loadStoredMockupGenConfig,
  type MockupGenerationConfig,
} from "./mockup-generation-config"
import { MockupPageTabs } from "./mockup-page-tabs"
import { RenderConfirmDialog } from "./render-confirm-dialog"
import { SquareActionMenu, type SquareMenuState } from "./square-action-menu"
import { TemplateManageDialog } from "./template-manage-dialog"
import { TemplateSquare } from "./template-square"

/**
 * 样机渲染主页面（批量渲染工作区）
 *
 * 顶栏：创建（选大/小模板建卡片）/ 生成配置（AI 模型+尺寸）/ 渲染（全部
 * 就绪卡片一键批量）/ 模板管理（全员可用：归属人管理自己的，企业管理员
 * 管理本企业全部）。
 * 下方长条卡片 = 个人渲染实例：左序号+大模板名、中小模板方块（五态 +
 * AI 角标）、右操作。点击方块弹出操作菜单（替换图层/AI背景/AI渲染/
 * 查看原图/查看对比）。渲染任务轮询 5s；AI 生图任务轮询 3s（AI背景完成
 * 后自动落地并重渲染），页面加载时兜底续做未落地的 AI背景。
 */

interface RenderConfirmState {
  title: string
  count: number
  cost: number
  cardIds: string[]
}

export function MockupClient({
  initialData,
  isAdmin,
  currentUserId,
}: {
  initialData: MockupPageData
  isAdmin: boolean
  currentUserId: string
}) {
  const router = useRouter()
  const { groups, cards: serverCards } = initialData

  // 图片库（我的上传）：本地持有，上传后即时追加
  const [designAssets, setDesignAssets] = React.useState<MockupLibraryImage[]>(
    initialData.designAssets,
  )
  React.useEffect(() => {
    setDesignAssets(initialData.designAssets)
  }, [initialData.designAssets])

  // 轮询实时状态覆盖（taskId → update）
  const [overlay, setOverlay] = React.useState<
    Map<string, MockupStatusUpdate>
  >(new Map())
  const terminalSeen = React.useRef<Set<string>>(new Set())

  // 弹窗状态
  const [createOpen, setCreateOpen] = React.useState(false)
  const [manageOpen, setManageOpen] = React.useState(false)
  const [historyCard, setHistoryCard] = React.useState<MockupCardView | null>(
    null,
  )
  const [bindingTarget, setBindingTarget] = React.useState<{
    card: MockupCardView
    item: MockupCardItemView
  } | null>(null)
  const [renderConfirm, setRenderConfirm] =
    React.useState<RenderConfirmState | null>(null)
  const [deleteCard, setDeleteCard] = React.useState<MockupCardView | null>(null)
  const [renderingAll, setRenderingAll] = React.useState(false)
  // 渲染进度快照（cardId → { 本次批量提交数, 提交时间, 是否已见到在途任务 }），
  // 用于卡片渲染按钮的进度百分比；该卡在途任务归零时清除，按钮恢复普通态
  const [cardRenderTotals, setCardRenderTotals] = React.useState<
    Record<string, { total: number; at: number; seenActive: boolean }>
  >({})

  // ── 生成历史视图（来源切换/日期筛选/加载轮询见 use-mockup-history）──
  const [showHistory, setShowHistory] = React.useState(false)
  const history = useMockupHistory("card")

  // 渲染导出格式（提交时选择；默认 PNG）
  const [outputFormat, setOutputFormat] =
    React.useState<MockupOutputFormat>("png")

  // 方块操作菜单（点击方块弹出）
  const [menuTarget, setMenuTarget] = React.useState<
    | (SquareMenuState & { card: MockupCardView; item: MockupCardItemView })
    | null
  >(null)

  // AI 生成配置（模型 + 尺寸，localStorage 持久化）
  const [genConfig, setGenConfig] =
    React.useState<MockupGenerationConfig | null>(null)
  React.useEffect(() => {
    setGenConfig(loadStoredMockupGenConfig())
  }, [])

  // AI 生图任务轮询（AI背景完成 → 落地重渲染；AI渲染完成 → 刷新列表）
  // 初始值播种服务端在途任务：生图失败队列重试窗口内刷新页面，重试成功仍能自动套版
  const [aiPolling, setAiPolling] = React.useState<
    Array<{
      taskId: string
      aiKind: "background" | "render"
      cardId: string
      groupItemId: string
    }>
  >(() => initialData.pendingAiTasks)
  // AI 生图中的方块 key 集合（提交后即时生效；服务端 aiGenerating 覆盖刷新场景）
  const aiGeneratingKeys = React.useMemo(
    () =>
      new Set(aiPolling.map((e) => `${e.cardId}:${e.groupItemId}`)),
    [aiPolling],
  )

  // 查看原图 / 查看对比
  const [viewerImage, setViewerImage] = React.useState<string | null>(null)
  const [compareTarget, setCompareTarget] = React.useState<{
    card: MockupCardView
    item: MockupCardItemView
  } | null>(null)

  // AI渲染 输入提示词
  const [aiRenderTarget, setAiRenderTarget] = React.useState<{
    card: MockupCardView
    item: MockupCardItemView
  } | null>(null)
  const [aiRenderPrompt, setAiRenderPrompt] = React.useState("")
  const [aiSubmitting, setAiSubmitting] = React.useState(false)

  // 断线兜底：页面加载时续做已完成但未落地的 AI背景（仅执行一次）
  const pendingApplyDoneRef = React.useRef(false)
  React.useEffect(() => {
    if (pendingApplyDoneRef.current) return
    pendingApplyDoneRef.current = true
    const pending = initialData.pendingAiApplies
    if (!pending || pending.length === 0) return
    void (async () => {
      let applied = 0
      for (const p of pending) {
        const res = await applyMockupAiBackgroundAction({ taskId: p.taskId })
        if (res.ok) applied++
        else if (res.error) toast.warning(`AI背景续做：${res.error}`)
      }
      if (applied > 0) {
        toast.success(`已续做 ${applied} 个 AI背景（自动重渲染中）`)
        router.refresh()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // AI 生图任务轮询（3s；页面隐藏暂停；全部终态后停止）
  React.useEffect(() => {
    if (aiPolling.length === 0) return
    let stop = false
    const tick = async () => {
      if (document.hidden) return
      const finished: string[] = []
      for (const entry of aiPolling) {
        try {
          const res = await getMockupBackgroundStatusAction(entry.taskId)
          if (stop || !res.ok || !res.task) continue
          const t = res.task
          if (t.status === "completed" && t.resultImage) {
            finished.push(entry.taskId)
            if (entry.aiKind === "background") {
              const apply = await applyMockupAiBackgroundAction({
                taskId: entry.taskId,
              })
              if (apply.ok) {
                const render = apply.render
                if (render && render.submitted > 0) {
                  toast.success(
                    `AI背景已生成并套入，自动重渲染（渲染扣费 ${render.cost} 积分）`,
                  )
                } else if (render) {
                  const reason =
                    render.skipped[0]?.reason ??
                    render.failedSubmits[0]?.message ??
                    "背景图已保存到卡片配置，自动渲染未执行"
                  toast.warning(`AI背景已套入：${reason}`)
                }
                if (apply.error) toast.warning(apply.error)
              } else {
                toast.error(apply.error ?? "AI背景落地失败")
              }
            } else {
              toast.success("AI渲染完成，可在「查看对比」查看")
            }
            router.refresh()
          } else if (t.status === "failed") {
            finished.push(entry.taskId)
            toast.error(t.errorMessage ?? "AI 生成失败，积分已退")
          }
        } catch {
          // 单任务查询失败忽略，下轮重试
        }
      }
      if (finished.length > 0) {
        setAiPolling((prev) =>
          prev.filter((e) => !finished.includes(e.taskId)),
        )
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [aiPolling, router])

  /** 菜单「AI背景」/「AI渲染」提交 */
  const submitAi = async (
    card: MockupCardView,
    item: MockupCardItemView,
    aiKind: "background" | "render",
    prompt: string,
  ) => {
    if (!genConfig?.modelId || !genConfig.imageSize) {
      toast.error("请先在顶栏「生成配置」选择模型与尺寸")
      return
    }
    setAiSubmitting(true)
    try {
      const res = await submitMockupBackgroundAction({
        modelId: genConfig.modelId,
        imageSize: genConfig.imageSize,
        prompt: prompt || "AI背景",
        cardId: card.id,
        groupItemId: item.id,
        aiKind,
      })
      if (!res.ok || !res.taskId) {
        toast.error(res.error ?? "提交失败")
        return
      }
      toast.success(
        `AI${aiKind === "background" ? "背景" : "渲染"}生成中（扣费 ${res.cost} 积分）`,
      )
      setAiPolling((prev) => [
        ...prev,
        {
          taskId: res.taskId!,
          aiKind,
          cardId: card.id,
          groupItemId: item.id,
        },
      ])
    } finally {
      setAiSubmitting(false)
    }
  }

  const effTask = (item: MockupCardItemView): MockupSquareTaskView | null => {
    if (!item.task) return null
    const u = overlay.get(item.task.taskId)
    if (!u) return item.task
    return {
      ...item.task,
      status: u.status,
      progress: u.progress,
      stage: u.stage,
      errorMessage: u.errorMessage,
      resultImage: u.resultImage ?? item.task.resultImage,
    }
  }

  const hasActive = serverCards.some((c) =>
    c.items.some((i) => {
      const t = effTask(i)
      return t?.status === "queued" || t?.status === "processing"
    }),
  )

  // 渲染进度快照生命周期：任务出现 → 标记 seenActive；全部结束（或 30s 内
  // 始终无任务，视为提交被全部跳过）→ 清除快照，渲染按钮恢复普通态
  React.useEffect(() => {
    const ids = Object.keys(cardRenderTotals)
    if (ids.length === 0) return
    let changed = false
    const next = { ...cardRenderTotals }
    for (const id of ids) {
      const card = serverCards.find((c) => c.id === id)
      const active = card
        ? card.items.filter((i) => {
            const u = i.task ? overlay.get(i.task.taskId) : undefined
            const status = u?.status ?? i.task?.status
            return status === "queued" || status === "processing"
          }).length
        : 0
      const entry = next[id]!
      if (active > 0) {
        // 他端/重试同时提交导致在途数超过快照时抬高分母，避免进度超过 100%
        if (!entry.seenActive || active > entry.total) {
          next[id] = {
            ...entry,
            seenActive: true,
            total: Math.max(entry.total, active),
          }
          changed = true
        }
      } else if (entry.seenActive || Date.now() - entry.at > 30000) {
        delete next[id]
        changed = true
      }
    }
    if (changed) setCardRenderTotals(next)
  }, [overlay, serverCards, cardRenderTotals])

  // ── 轮询（5s；页面隐藏暂停；无在途任务不轮询）──
  // 服务端只返回 queued/processing 任务：任务终态后会从 updates 消失，
  // 记录上一轮在途集合，消失即终态 → 清 overlay 残留（否则 effTask 永远
  // 优先读到旧的 processing，方块会一直显示加载中）
  const prevActiveRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    if (!hasActive) return
    let stop = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const res = await getMockupStatusAction()
        if (stop || !res.ok) return
        const next = new Map<string, MockupStatusUpdate>()
        let anyTerminal = false
        let anyFailed = false
        for (const u of res.updates) {
          next.set(u.taskId, u)
          const isTerminal = u.status === "completed" || u.status === "failed"
          if (isTerminal && !terminalSeen.current.has(u.taskId)) {
            terminalSeen.current.add(u.taskId)
            anyTerminal = true
            if (u.status === "failed") anyFailed = true
          }
        }
        const nextIds = new Set(next.keys())
        const gone = [...prevActiveRef.current].filter(
          (id) => !nextIds.has(id),
        )
        prevActiveRef.current = nextIds
        if (gone.length > 0) {
          setOverlay((prev) => {
            const merged = new Map(prev)
            for (const id of gone) merged.delete(id)
            return merged
          })
          router.refresh()
        }
        setOverlay((prev) => {
          const merged = new Map(prev)
          for (const [k, v] of next) merged.set(k, v)
          return merged
        })
        if (anyTerminal) {
          router.refresh()
          if (anyFailed) {
            toast.warning("部分样机渲染失败，积分已自动退还，可重试")
          } else {
            toast.success("渲染完成")
          }
        }
      } catch {
        // 网络抖动忽略，下轮重试
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [hasActive, router])

  // ── 渲染（单卡 / 全部 / 单样机）──
  /** 直接提交渲染（不弹确认）：快照进度分母 → 提交 → toast → 刷新 */
  const handleRenderCards = async (cardIds: string[]) => {
    const totals: Record<string, number> = {}
    let count = 0
    for (const card of serverCards) {
      if (!cardIds.includes(card.id)) continue
      // 仅首次渲染：已成功出图的方块不再计入
      const ready = card.items.filter(
        (i) => i.configured && !i.hasRendered,
      ).length
      if (ready > 0) {
        totals[card.id] = ready
        count += ready
      }
    }
    if (count === 0) {
      toast.warning("没有可渲染的样机：全部已出图，或请先点击小方块配齐必填图层")
      return
    }
    const res = await renderMockupCardsAction(cardIds, outputFormat)
    if (!res.ok) {
      toast.error(res.error ?? "提交失败")
      return
    }
    if (res.submitted > 0) {
      // 仅在点击事件处理器中执行（非渲染期），读取提交时间戳
      // eslint-disable-next-line react-hooks/purity
      const at = Date.now()
      setCardRenderTotals((prev) => {
        const next = { ...prev }
        for (const [id, total] of Object.entries(totals)) {
          next[id] = { total, at, seenActive: prev[id]?.seenActive ?? false }
        }
        return next
      })
      toast.success(`已提交 ${res.submitted} 个样机，扣费 ${res.cost} 积分`)
    }
    for (const s of res.skipped) {
      toast.warning(`跳过「${s.displayName}」：${s.reason}`)
    }
    for (const f of res.failedSubmits) {
      toast.error(`「${f.displayName}」提交失败：${f.message}`)
    }
    terminalSeen.current = new Set()
    setOverlay(new Map())
    router.refresh()
  }

  const openRenderConfirm = (cardIds: string[], title: string) => {
    let count = 0
    for (const card of serverCards) {
      if (!cardIds.includes(card.id)) continue
      // 仅首次渲染：已成功出图的方块不再计入
      count += card.items.filter((i) => i.configured && !i.hasRendered).length
    }
    if (count === 0) {
      toast.warning("没有可渲染的样机：全部已出图，或请先点击小方块配齐必填图层")
      return
    }
    setRenderConfirm({
      title,
      count,
      cost: count * initialData.costPerRender,
      cardIds,
    })
  }

  const handleRender = async () => {
    if (!renderConfirm) return
    await handleRenderCards(renderConfirm.cardIds)
    setRenderConfirm(null)
  }

  const handleRetryItem = async (cardId: string, groupItemId: string) => {
    const res = await renderCardItemAction(cardId, groupItemId, outputFormat)
    if (!res.ok) {
      toast.error(res.error ?? "提交失败")
      return
    }
    if (res.submitted > 0) {
      setCardRenderTotals((prev) => ({
        ...prev,
        [cardId]: {
          total: (prev[cardId]?.total ?? 0) + res.submitted,
          at: Date.now(),
          seenActive: prev[cardId]?.seenActive ?? false,
        },
      }))
      toast.success(`已提交渲染，扣费 ${res.cost} 积分`)
      router.refresh()
    } else {
      const reason = res.skipped[0]?.reason ?? res.failedSubmits[0]?.message
      toast.warning(reason ? `未渲染：${reason}` : "未渲染")
    }
  }

  const handleDeleteCard = async () => {
    if (!deleteCard) return
    const res = await deleteMockupCardAction(deleteCard.id)
    if (!res.ok) {
      toast.error(res.error ?? "删除失败")
      return
    }
    toast.success("卡片已删除")
    setDeleteCard(null)
    router.refresh()
  }

  /* ── 未开通空态 ── */
  if (!initialData.available) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 py-8">
        <div>
          <h1 className="text-2xl font-bold">样机渲染</h1>
          <p className="text-sm text-muted-foreground">
            将设计稿套用到样机模板，快速生成场景化展示图
          </p>
        </div>
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
          <Boxes className="size-10 text-muted-foreground/40" />
          <p>样机渲染服务暂未开通</p>
          <p className="text-xs">
            {isAdmin ? "请联系平台管理员在超管平台为本企业配置渲染服务" : "请联系企业管理员或平台管理员开通"}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100svh-7rem)] lg:overflow-hidden">
      {/* 顶栏：页内 Tab + 标题 + 三按钮 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <MockupPageTabs />
        </div>
        <div className="flex items-center gap-2">
          {showHistory ? (
            <>
              <Select
                value={history.source}
                onValueChange={(v) =>
                  v && history.setSource(v as "card" | "batch")
                }
              >
                <SelectTrigger
                  aria-label="切换记录来源"
                  size="sm"
                  className="w-[110px] rounded-[min(var(--radius-md),12px)] text-xs"
                >
                  <SelectValue>
                    {history.source === "card" ? "模板渲染" : "批量替换"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="card">模板渲染</SelectItem>
                  <SelectItem value="batch">批量替换</SelectItem>
                </SelectContent>
              </Select>
              <HistoryDateRangePicker
                value={history.dateRange}
                onChange={history.setDateRange}
                size="sm"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={history.loading}
                onClick={() => void history.handleRefresh()}
              >
                {history.loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                刷新
              </Button>
            </>
          ) : (
            <>
              <MockupGenerationConfigButton
                value={genConfig}
                onApply={(config) => setGenConfig(config)}
              />
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                创建卡片
              </Button>
              <MockupOutputFormatSelect value={outputFormat} onChange={setOutputFormat} />
              <Button
                size="sm"
                variant="outline"
                disabled={renderingAll || serverCards.length === 0}
                onClick={() => {
                  setRenderingAll(true)
                  openRenderConfirm(
                    serverCards.map((c) => c.id),
                    "批量渲染全部卡片",
                  )
                  setRenderingAll(false)
                }}
              >
                <Play className="size-4" />
                渲染
              </Button>
              <Button size="sm" variant="outline" onClick={() => setManageOpen(true)}>
                <Settings2 className="size-4" />
                模板管理
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant={showHistory ? "default" : "outline"}
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="size-4" />
            生成历史
          </Button>
        </div>
      </div>

      {/* 生成历史 / 卡片列表 */}
      {showHistory ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
          <MockupHistoryPanel
            source={history.source}
            cards={history.cardRecords}
            batches={history.batchRecords}
            loading={history.loading}
            filterActive={history.filterActive}
          />
        </div>
      ) : (
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 scrollbar-hide">
        {serverCards.length === 0 ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground">
            <Boxes className="size-10 text-muted-foreground/40" />
            <p>还没有渲染卡片</p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            创建第一张卡片
          </Button>
          {groups.length === 0 ? (
            <p className="text-xs">
              还没有可用的大模板/小模板，请先在「模板管理」中上传 PSD 并创建
            </p>
          ) : null}
          </div>
        ) : (
          serverCards.map((card, cardIndex) => {
            // 仅首次渲染：可渲染数 = 已配齐且未出图的方块
            const readyCount = card.items.filter(
              (i) => i.configured && !i.hasRendered,
            ).length
            // 渲染按钮进度：分母为提交时快照，进度 = (快照 − 当前在途) / 快照
            const snapshot = cardRenderTotals[card.id]
            const activeCount = card.items.filter((i) => {
              const u = i.task ? overlay.get(i.task.taskId) : undefined
              const status = u?.status ?? i.task?.status
              return status === "queued" || status === "processing"
            }).length
            const inProgress = snapshot !== undefined && activeCount > 0
            const pct = snapshot
              ? Math.min(
                  100,
                  Math.max(
                    0,
                    Math.round(
                      ((snapshot.total - activeCount) / snapshot.total) * 100,
                    ),
                  ),
                )
              : 0
            return (
              <div
                key={card.id}
                className="space-y-3 rounded-xl border bg-card p-4"
              >
                {/* 头部：序号 + 模板名 | 渲染（进度） + 图标操作 */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <LayoutGrid className="size-4 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-sm font-medium tabular-nums">
                      {cardIndex + 1}
                    </span>
                    <span
                      className="min-w-0 truncate text-sm font-semibold"
                      title={card.groupName}
                    >
                      {card.groupName}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      className="relative w-[124px] overflow-hidden"
                      disabled={inProgress || readyCount === 0}
                      onClick={() => void handleRenderCards([card.id])}
                      {...(inProgress
                        ? {
                            role: "progressbar",
                            "aria-valuenow": pct,
                            "aria-valuemin": 0,
                            "aria-valuemax": 100,
                          }
                        : {})}
                    >
                      {inProgress ? (
                        <span
                          className="absolute inset-y-0 left-0 border-r border-primary-foreground/40 bg-primary-foreground/25"
                          style={{ width: `${pct}%` }}
                        />
                      ) : null}
                      <span className="relative flex items-center gap-1.5">
                        {inProgress ? (
                          <>
                            <Loader2 className="size-3.5 animate-spin" />
                            <span className="tabular-nums">{pct}%</span>
                          </>
                        ) : (
                          <>
                            <Play className="size-3.5" />
                            渲染
                            <span className="flex items-center gap-0.5 text-[11px]">
                              <Sparkle className="size-3 fill-current" />
                              <span className="tabular-nums">
                                {readyCount * initialData.costPerRender}
                              </span>
                            </span>
                          </>
                        )}
                      </span>
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      title="历史"
                      onClick={() => setHistoryCard(card)}
                    >
                      <History className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      title="删除"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteCard(card)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {/* 方块区：占满整行 */}
                <div className="flex min-w-0 flex-wrap gap-2.5">
                  {card.items.map((item) => {
                    const t = effTask(item)
                    const live = t !== item.task ? t : undefined
                    return (
                      <TemplateSquare
                        key={item.id}
                        displayName={item.displayName}
                        task={item.task}
                        live={live}
                        hasAi={item.aiImages.length > 0}
                        aiGenerating={
                          item.aiGenerating ||
                          aiGeneratingKeys.has(`${card.id}:${item.id}`)
                        }
                        onOpen={(rect) => {
                          const eff = live ?? item.task
                          setMenuTarget({
                            rect,
                            card,
                            item,
                            hasRendered: item.hasRendered,
                            hasBackgroundBinding: item.bindings.some(
                              (b) => b.role === "background" && b.type !== "text",
                            ),
                            modelReady: Boolean(genConfig?.modelId && genConfig.imageSize),
                            hasAi: item.aiImages.length > 0,
                            onReplaceLayers: () => setBindingTarget({ card, item }),
                            onAiBackground: () =>
                              void submitAi(card, item, "background", ""),
                            onAiRender: () => {
                              setAiRenderPrompt("")
                              setAiRenderTarget({ card, item })
                            },
                            onViewOriginal: () =>
                              eff?.resultImage && setViewerImage(eff.resultImage),
                            onCompare: () => setCompareTarget({ card, item }),
                          })
                        }}
                        onRetry={
                          t?.status === "failed"
                            ? () => void handleRetryItem(card.id, item.id)
                            : undefined
                        }
                      />
                    )
                  })}
                  {card.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      套组成员为空（模板可能被编辑），请重建卡片
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })
        )}
      </div>
      )}

      {/* ── 弹窗组 ── */}
      <CreateCardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        groups={groups}
        onCreated={() => router.refresh()}
      />

      <TemplateManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onChanged={() => router.refresh()}
      />

      <CardHistoryDialog
        cardId={historyCard?.id ?? ""}
        cardTitle={historyCard?.title ?? ""}
        open={historyCard !== null}
        onOpenChange={(o) => !o && setHistoryCard(null)}
      />

      <BindingDialog
        open={bindingTarget !== null}
        onOpenChange={(o) => !o && setBindingTarget(null)}
        cardId={bindingTarget?.card.id ?? ""}
        cardTitle={bindingTarget?.card.title ?? ""}
        item={bindingTarget?.item ?? null}
        initialSettings={
          bindingTarget
            ? (bindingTarget.card.bindingConfig[bindingTarget.item.id] as
                | Record<string, MockupBindingSetting>
                | undefined)
            : undefined
        }
        designAssets={designAssets}
        onDesignAssetUploaded={(img) =>
          setDesignAssets((prev) => [img, ...prev])
        }
        onSaved={() => router.refresh()}
      />

      {renderConfirm ? (
        <RenderConfirmDialog
          open={renderConfirm !== null}
          onOpenChange={(o) => !o && setRenderConfirm(null)}
          title={renderConfirm.title}
          count={renderConfirm.count}
          cost={renderConfirm.cost}
          creditsBalance={initialData.creditsBalance}
          onConfirm={async () => {
            await handleRender()
          }}
        />
      ) : null}

      <Dialog
        open={deleteCard !== null}
        onOpenChange={(o) => !o && setDeleteCard(null)}
      >
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>删除卡片「{deleteCard?.title}」？</DialogTitle>
            <DialogDescription>
              仅删除这张渲染卡片及其配置；历史渲染结果保留在资产管理页
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteCard(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteCard()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 方块操作菜单（替换图层 / AI背景 / AI渲染 / 查看原图 / 查看对比） */}
      <SquareActionMenu
        state={menuTarget}
        onClose={() => setMenuTarget(null)}
      />

      {/* 查看原图（公共放大查看组件） */}
      <ImageViewer
        open={viewerImage !== null}
        onOpenChange={(o) => !o && setViewerImage(null)}
        images={viewerImage ? [viewerImage] : []}
        index={0}
      />

      {/* 查看对比（左 = 纯套版渲染原图，右 = 选中比对图：AI背景/AI渲染/套样机效果） */}
      <ImageCompareDialog
        open={compareTarget !== null}
        onOpenChange={(o) => !o && setCompareTarget(null)}
        images={compareTarget?.item.aiImages ?? []}
        title={compareTarget?.item.displayName ?? ""}
      />

      {/* AI渲染：输入提示词（以样机渲染原图为参考） */}
      <Dialog
        open={aiRenderTarget !== null}
        onOpenChange={(o) => !o && setAiRenderTarget(null)}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>AI渲染 · {aiRenderTarget?.item.displayName}</DialogTitle>
            <DialogDescription>
              以当前样机渲染图为参考图，输入提示词生成新图；生成后可在「查看对比」查看
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={aiRenderPrompt}
            onChange={(e) => setAiRenderPrompt(e.target.value)}
            placeholder="描述想要的画面调整，如：整体调成暖色调夕阳氛围，地面加柔和长影"
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiRenderTarget(null)}>
              取消
            </Button>
            <Button
              disabled={aiSubmitting || !aiRenderPrompt.trim()}
              onClick={() => {
                if (!aiRenderTarget) return
                void submitAi(
                  aiRenderTarget.card,
                  aiRenderTarget.item,
                  "render",
                  aiRenderPrompt.trim(),
                )
                setAiRenderTarget(null)
              }}
            >
              生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
