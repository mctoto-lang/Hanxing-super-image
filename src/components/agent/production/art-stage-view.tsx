"use client"

/**
 * art 阶段容器（工作台主区挂载）：
 * - 小样确认横幅（小样收口后出现）；生产统计由工作台顶部常驻 4 信息卡
 *   统一承担（此处不再重复渲染 ProductionStats）；
 * - 子任务 Tabs：「卡面生产」（失败卡批量重试 + 筛选网格 + 逐轮回放弹窗，
 *   全宽铺满）与「周边资产」（6 项独立提示词 AI 生成 / 上传 / 确认）；
 *   AI 融合边框在 compose 阶段（融合与交付）执行，与本阶段解耦；
 * - 78 张卡面终版齐备后出现「进入融合与交付」入口（stage 双向切换）；
 * - 逐轮回放弹窗复用 RunItemDetailDialog（确认任意一轮/手动重开）。
 */
import { useState } from "react"
import { AlertTriangle, ArrowRight, Image as ImageIcon, Loader2, Palette, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RunItemDetailDialog } from "../run-item-detail"
import { TarotAssetsPanel } from "../tarot-assets-panel"
import type { TemplateWorkspaceData } from "../use-template-workspace"
import { useWorkspaceActions } from "../workspace-actions"
import type { RunTemplateAction } from "../tarot-stage-clarify"
import { ArtCardsGrid } from "./art-cards-grid"
import { SampleConfirmBar, sampleGateReached } from "./sample-confirm-bar"

export function ArtStageView({
  data,
  busy,
  onRefresh,
  runAction,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  onRefresh: () => Promise<unknown>
  runAction: RunTemplateAction
}) {
  const { switchTemplateStage, regenFailedItems } = useWorkspaceActions()
  const [itemDetailId, setItemDetailId] = useState<string | null>(null)
  const [itemDetailOpen, setItemDetailOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const openItem = (itemId: string) => {
    setItemDetailId(itemId)
    setItemDetailOpen(true)
  }

  // 按 kind 去重统计（与服务端 confirmedByKind 同口径）：同一 kind 重复
  // 上传+确认会新增行，按行计数会显示「7/6 资产」
  const assetsConfirmed = new Set(
    data.assets
      .filter((asset) => (asset.meta as { status?: string } | null)?.status === "confirmed")
      .map((asset) => asset.kind),
  ).size
  const cardsReady = data.items.length === 78 && data.items.every((item) => item.finalRoundId)
  // 生图/模型调用失败造成的中断卡（与筛选 chips 的「失败」口径一致）
  const failedItems = data.items.filter(
    (item) => item.status === "failed" || item.status === "cancelled",
  )

  const retryAllFailed = async () => {
    setRetrying(true)
    try {
      const result = await regenFailedItems(data.run.id)
      // 业务失败（处理中/无失败卡面等）以返回值传达：生产环境 Server Action
      // 抛错会被抹为 #441 占位文案，客户端 toast 不到真实原因
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // 成功即报：重试动作本身已成功；若把刷新与动作放在同一个 try 里，
      // 刷新抛错会误报「批量重试失败」，诱导用户重复点击造成重复入队
      toast.success(`已重新排队 ${result.count} 张失败卡面`)
      // 刷新仅为拉取最新列表，失败不影响已入队的重试任务，静默降级
      try {
        await onRefresh()
      } catch (error) {
        console.error("批量重试后刷新运行数据失败", error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量重试失败")
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="space-y-4">
      {sampleGateReached(data) && (
        <SampleConfirmBar data={data} busy={busy} onOpenItem={openItem} onRefresh={onRefresh} runAction={runAction} />
      )}

      <Tabs defaultValue="cards">
        <TabsList>
          <TabsTrigger value="cards">
            <Palette className="size-3.5" data-icon="inline-start" />
            卡面生产
          </TabsTrigger>
          <TabsTrigger value="assets">
            <ImageIcon className="size-3.5" data-icon="inline-start" />
            周边资产
            <Badge variant="secondary" className="ml-1 bg-muted text-[10px] text-muted-foreground">
              {assetsConfirmed}/6 资产
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="cards" className="mt-3 space-y-4">
          {/* 失败卡批量重试（模型调用失败造成的中断） */}
          {failedItems.length > 0 && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3"
            >
              <AlertTriangle className="size-4 shrink-0 text-red-500" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-red-600 dark:text-red-400">
                  {failedItems.length} 张卡面生成失败
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  多为模型调用瞬时失败造成的中断；可一键批量重试，也可点击单卡在弹窗中手动重开。
                </p>
              </div>
              {/* 仅防重复点击：是否"处理中"由服务端权威校验并 toast 反馈，
                  避免轮询数据 stale 时按钮永久灰掉无法重试 */}
              <Button size="sm" disabled={retrying} onClick={() => void retryAllFailed()}>
                {retrying ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                批量重试 {failedItems.length} 张
              </Button>
            </div>
          )}

          {/* 卡面网格全宽铺满 */}
          <ArtCardsGrid data={data} onOpenItem={openItem} />
        </TabsContent>
        <TabsContent value="assets" className="mt-3 space-y-4">
          <TarotAssetsPanel data={data} onRefresh={onRefresh} />
        </TabsContent>
      </Tabs>

      {/* 卡面终版齐备 → 进入融合与交付（compose 阶段做参考图融合与交付下载） */}
      {cardsReady && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3">
          <div className="text-sm">
            <p className="font-medium">78 张卡面已就绪</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              可继续在本阶段处理周边资产，或进入「融合与交付」选择边框参考图并批量融合。
            </p>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              void runAction(
                () => switchTemplateStage({ runId: data.run.id, stage: "compose" }),
                "已进入「融合与交付」阶段",
              )
            }
          >
            进入融合与交付
            <ArrowRight className="size-4" />
          </Button>
        </div>
      )}

      <RunItemDetailDialog
        itemId={itemDetailId}
        open={itemDetailOpen}
        onOpenChange={setItemDetailOpen}
        onChanged={() => void onRefresh()}
      />
    </div>
  )
}
