"use client"

/**
 * art 阶段容器（工作台主区挂载）：
 * - 顶部统计卡 + 小样确认横幅（小样收口后出现）；
 * - 子任务 Tabs：「卡面生产」（筛选网格 + 逐轮回放弹窗｜整副评分概览）与
 *   「周边资产与融合」（6 项资产 + AI 融合边框）并行推进；
 * - 逐轮回放弹窗复用 RunItemDetailDialog（确认任意一轮/手动重开）。
 */
import { useCallback, useEffect, useState } from "react"
import type { getTarotDeckScoresAction } from "@/server/actions/agent-template"
import { Image as ImageIcon, Palette } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RunItemDetailDialog } from "../run-item-detail"
import { TarotAssetsPanel } from "../tarot-assets-panel"
import { AiFramePanel } from "../ai-frame-panel"
import { DeckScoreSummary } from "../review-score-card"
import type { TemplateWorkspaceData } from "../use-template-workspace"
import { useWorkspaceActions } from "../workspace-actions"
import type { RunTemplateAction } from "../tarot-stage-clarify"
import { ProductionStats } from "./production-stats"
import { ArtCardsGrid } from "./art-cards-grid"
import { SampleConfirmBar, sampleGateReached } from "./sample-confirm-bar"

type DeckScores = Awaited<ReturnType<typeof getTarotDeckScoresAction>>

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
  const { getTarotDeckScores } = useWorkspaceActions()
  const [itemDetailId, setItemDetailId] = useState<string | null>(null)
  const [itemDetailOpen, setItemDetailOpen] = useState(false)
  const [deckScores, setDeckScores] = useState<DeckScores | null>(null)

  const openItem = (itemId: string) => {
    setItemDetailId(itemId)
    setItemDetailOpen(true)
  }

  const loadScores = useCallback(async () => {
    try {
      setDeckScores(await getTarotDeckScores(data.run.id))
    } catch {
      // 评分聚合失败静默（评分卡显示空态）
    }
  }, [data.run.id, getTarotDeckScores])

  useEffect(() => {
    void loadScores()
  }, [loadScores])
  // 生产进行中缓慢刷新评分（评审陆续出分）
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void loadScores(), 8000)
    return () => clearInterval(timer)
  }, [busy, loadScores])

  const framed = data.items.filter((item) => item.frameStatus === "framed").length
  // 按 kind 去重统计（与服务端 confirmedByKind 同口径）：同一 kind 重复
  // 上传+确认会新增行，按行计数会显示「7/6 资产」
  const assetsConfirmed = new Set(
    data.assets
      .filter((asset) => (asset.meta as { status?: string } | null)?.status === "confirmed")
      .map((asset) => asset.kind),
  ).size

  return (
    <div className="space-y-4">
      <ProductionStats data={data} busy={busy} />

      {sampleGateReached(data) && (
        <SampleConfirmBar data={data} busy={busy} onOpenItem={openItem} runAction={runAction} />
      )}

      <Tabs defaultValue="cards">
        <TabsList>
          <TabsTrigger value="cards">
            <Palette className="size-3.5" data-icon="inline-start" />
            卡面生产
          </TabsTrigger>
          <TabsTrigger value="assets">
            <ImageIcon className="size-3.5" data-icon="inline-start" />
            周边资产与融合
            <Badge variant="secondary" className="ml-1 bg-muted text-[10px] text-muted-foreground">
              {assetsConfirmed}/6 资产 · 融合 {framed}/78
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="cards" className="mt-3">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <ArtCardsGrid data={data} onOpenItem={openItem} />
            <div className="space-y-4">
              <DeckScoreSummary items={deckScores?.items ?? []} thresholds={deckScores?.thresholds} />
              {deckScores && deckScores.contentTotal > 0 && (
                <Card size="sm" className="gap-2">
                  <CardHeader>
                    <CardTitle className="text-sm">内容对齐通过率</CardTitle>
                    <CardDescription className="text-xs">
                      终版轮内容审核通过 {deckScores.contentPass}/{deckScores.contentTotal} 张
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xl font-semibold tabular-nums">
                      {Math.round((deckScores.contentPass / deckScores.contentTotal) * 100)}%
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="assets" className="mt-3 space-y-4">
          <TarotAssetsPanel data={data} onRefresh={onRefresh} />
          <AiFramePanel data={data} onRefresh={onRefresh} />
        </TabsContent>
      </Tabs>

      <RunItemDetailDialog
        itemId={itemDetailId}
        open={itemDetailOpen}
        onOpenChange={setItemDetailOpen}
        onChanged={() => {
          void onRefresh()
          void loadScores()
        }}
      />
    </div>
  )
}
