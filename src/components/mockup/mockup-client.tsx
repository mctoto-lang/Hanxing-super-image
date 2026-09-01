"use client"

import * as React from "react"
import {
  Boxes,
  History,
  Play,
  Plus,
  Settings2,
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
  cancelMockupTaskAction,
  deleteMockupCardAction,
  getMockupStatusAction,
  renderCardItemAction,
  renderMockupCardsAction,
} from "@/server/actions/mockup"
import { BindingDialog } from "./binding-dialog"
import { CardHistoryDialog } from "./card-history-dialog"
import { CreateCardDialog } from "./create-card-dialog"
import { RenderConfirmDialog } from "./render-confirm-dialog"
import { TemplateManageDialog } from "./template-manage-dialog"
import { TemplateSquare } from "./template-square"

/**
 * 样机渲染主页面（批量渲染工作区）
 *
 * 顶栏：创建（选大模板建卡片）/ 渲染（全部就绪卡片一键批量）/ 模板管理（管理员）。
 * 下方长条卡片 = 个人渲染实例：左大模板信息、中小模板方块（五态）、右操作。
 * 轮询 5s 拉取在途任务实时进度（外部 stage/progress 透传），终态自动刷新。
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
}: {
  initialData: MockupPageData
  isAdmin: boolean
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
  const [cancelling, setCancelling] = React.useState<Set<string>>(new Set())
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

  // ── 轮询（5s；页面隐藏暂停；无在途任务不轮询）──
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
  const openRenderConfirm = (cardIds: string[], title: string) => {
    let count = 0
    for (const card of serverCards) {
      if (!cardIds.includes(card.id)) continue
      count += card.items.filter((i) => i.configured).length
    }
    if (count === 0) {
      toast.warning("没有可渲染的样机：请先点击小方块配齐必填图层")
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
    const res = await renderMockupCardsAction(renderConfirm.cardIds)
    if (!res.ok) {
      toast.error(res.error ?? "提交失败")
      return
    }
    if (res.submitted > 0) {
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
    setRenderConfirm(null)
  }

  const handleRetryItem = async (cardId: string, groupItemId: string) => {
    const res = await renderCardItemAction(cardId, groupItemId)
    if (!res.ok) {
      toast.error(res.error ?? "提交失败")
      return
    }
    if (res.submitted > 0) {
      toast.success(`已提交渲染，扣费 ${res.cost} 积分`)
      router.refresh()
    } else {
      const reason = res.skipped[0]?.reason ?? res.failedSubmits[0]?.message
      toast.warning(reason ? `未渲染：${reason}` : "未渲染")
    }
  }

  const handleCancelTask = async (taskId: string) => {
    setCancelling((prev) => new Set(prev).add(taskId))
    try {
      const res = await cancelMockupTaskAction(taskId)
      if (res.ok) {
        toast.success(res.message ?? "取消请求已发送")
      } else {
        toast.error(res.error ?? res.message ?? "取消失败")
        setCancelling((prev) => {
          const s = new Set(prev)
          s.delete(taskId)
          return s
        })
      }
    } catch {
      toast.error("取消失败")
      setCancelling((prev) => {
        const s = new Set(prev)
        s.delete(taskId)
        return s
      })
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
      {/* 顶栏：标题 + 三按钮 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">样机渲染 · 批量渲染</h1>
          <p className="text-xs text-muted-foreground">
            余额 {initialData.creditsBalance} 积分 · 渲染单价 {initialData.costPerRender} 积分/样机
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={groups.length === 0}>
            <Plus className="size-4" />
            创建
          </Button>
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
          {isAdmin ? (
            <Button size="sm" variant="outline" onClick={() => setManageOpen(true)}>
              <Settings2 className="size-4" />
              模板管理
            </Button>
          ) : null}
        </div>
      </div>

      {/* 卡片列表 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 scrollbar-hide">
        {serverCards.length === 0 ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground">
            <Boxes className="size-10 text-muted-foreground/40" />
            <p>还没有渲染卡片</p>
            <Button size="sm" onClick={() => setCreateOpen(true)} disabled={groups.length === 0}>
              <Plus className="size-4" />
              创建第一张卡片
            </Button>
            {groups.length === 0 ? (
              <p className="text-xs">
                {isAdmin
                  ? "还没有大模板，请先在「模板管理」中创建"
                  : "企业管理员尚未创建大模板，请联系管理员"}
              </p>
            ) : null}
          </div>
        ) : (
          serverCards.map((card) => {
            const readyCount = card.items.filter((i) => i.configured).length
            return (
              <div
                key={card.id}
                className="grid grid-cols-[150px_1fr_auto] items-start gap-3 rounded-xl border bg-card p-4"
              >
                {/* 左：大模板信息 */}
                <div className="min-w-0 space-y-1">
                  <div className="truncate text-sm font-semibold" title={card.title}>
                    {card.title}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    大模板：{card.groupName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {card.items.length} 个样机 ·{" "}
                    {new Date(card.updatedAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>

                {/* 中：小模板方块 */}
                <div className="flex min-w-0 flex-wrap gap-2.5">
                  {card.items.map((item) => {
                    const t = effTask(item)
                    return (
                      <TemplateSquare
                        key={item.id}
                        displayName={item.displayName}
                        task={item.task}
                        live={t !== item.task ? t : undefined}
                        onOpen={() => setBindingTarget({ card, item })}
                        onCancel={
                          t && (t.status === "queued" || t.status === "processing")
                            ? () => void handleCancelTask(t.taskId)
                            : undefined
                        }
                        onRetry={
                          t?.status === "failed"
                            ? () => void handleRetryItem(card.id, item.id)
                            : undefined
                        }
                        cancelling={t ? cancelling.has(t.taskId) : false}
                      />
                    )
                  })}
                  {card.items.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      套组成员为空（模板可能被编辑），请重建卡片
                    </span>
                  ) : null}
                </div>

                {/* 右：操作 */}
                <div className="flex w-[132px] flex-col gap-2">
                  <Button
                    size="sm"
                    disabled={readyCount === 0}
                    onClick={() =>
                      openRenderConfirm([card.id], `渲染「${card.title}」`)
                    }
                  >
                    <Play className="size-3.5" />
                    渲染 {readyCount}/{card.items.length} ·{" "}
                    {readyCount * initialData.costPerRender}积分
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-1 text-xs"
                      onClick={() => setHistoryCard(card)}
                    >
                      <History className="size-3.5" /> 历史
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-1 text-xs text-destructive hover:text-destructive"
                      onClick={() => setDeleteCard(card)}
                    >
                      <Trash2 className="size-3.5" /> 删除
                    </Button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

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
        groups={groups}
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
        costPerRender={initialData.costPerRender}
        designAssets={designAssets}
        onDesignAssetUploaded={(img) =>
          setDesignAssets((prev) => [img, ...prev])
        }
        onRendered={() => {
          terminalSeen.current = new Set()
          setOverlay(new Map())
          router.refresh()
        }}
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
    </div>
  )
}
