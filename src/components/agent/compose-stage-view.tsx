"use client"

/* 成品图 URL 可能来自本地存储或 COS，使用原生 img 兼容两类地址。 */
/* eslint-disable @next/next/no-img-element */

/**
 * compose 阶段「融合与交付」视图（TarotWorkspace 主区挂载）：
 * - AI 融合边框面板（选择/上传边框参考图 → 3 张预览 → 批量 78 张）；
 * - 就绪统计 + AI 融合进度（含失败卡单张重做）；
 * - 交付物总览网格（78 张成品卡 + 6 项套件资产，正方形卡内全比例展示，
 *   hover 仅边框发光——与生图评审缩略样式一致）；
 * - 下载中心：一键 ZIP（服务端流式打包）/ 逐张下载；
 * - 可返回 art 阶段继续处理卡面/周边资产（stage 双向切换）。
 */
import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, CheckCircle2, Download, Loader2, PackageOpen, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { TarotDeliverablesResult } from "@/server/actions/agent-template"
import { CARD_SQUARE_THUMB_CLASS } from "./card-thumb-grid"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"
import { ComposeFramePanel } from "./ai-frame-panel"

const POLL_INTERVAL_MS = 2500

export function ComposeStageView({
  data,
  busy,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  busy: boolean
  onRefresh: () => Promise<unknown>
}) {
  const [deliverables, setDeliverables] = useState<TarotDeliverablesResult | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  const { getTarotDeliverables, retryAiFrameItem, switchTemplateStage } = useWorkspaceActions()

  const load = useCallback(async () => {
    try {
      setDeliverables(await getTarotDeliverables(data.run.id))
    } catch {
      // 轮询失败静默保留上次数据
    }
  }, [data.run.id, getTarotDeliverables])

  useEffect(() => {
    void load()
  }, [load])

  // AI 融合进行中（工作台 busy）时轮询交付物
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [busy, load])

  const framed = data.items.filter((item) => item.frameStatus === "framed").length
  const framing = data.items.filter((item) => item.frameStatus === "framing").length
  const frameFailed = data.items.filter((item) => item.frameStatus === "failed")
  // 单张重做沿用发起融合时记忆的边框（frameAssetId），回退最新一条边框资产
  // （assets 为服务端升序返回，find 会命中最旧一条，须倒序；不用 findLast
  // 以避免 target/lib 兼容问题）
  const borderAssetId =
    data.run.frameAssetId ??
    [...data.assets].reverse().find((asset) => asset.kind === "border")?.id
  const readyCount = deliverables?.readyCount ?? 0
  const totalCount = deliverables?.totalCount ?? 84
  const percent = totalCount > 0 ? Math.round((readyCount / totalCount) * 100) : 0

  const retryFrame = async (itemId: string) => {
    if (!borderAssetId) return
    setActingId(itemId)
    try {
      await retryAiFrameItem({ runId: data.run.id, itemId, borderAssetId })
      await Promise.all([load(), onRefresh()])
      toast.success("已重新提交该卡融合")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重做失败")
    } finally {
      setActingId(null)
    }
  }

  const backToArt = async () => {
    try {
      await switchTemplateStage({ runId: data.run.id, stage: "art" })
      await onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "返回失败")
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void backToArt()}>
          <ArrowLeft className="size-4" /> 返回卡面生产
        </Button>
        <p className="text-xs text-muted-foreground">边框融合与套件交付在同一阶段完成，可随时返回上一阶段补做资产。</p>
      </div>

      {/* AI 融合边框：选择/上传参考图 → 预览 → 批量 */}
      <ComposeFramePanel data={data} onRefresh={onRefresh} />

      {/* 就绪统计 + 下载中心 */}
      <Card className="border-violet-500/30">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <PackageOpen className="size-4 text-violet-500" />
                交付物总览
              </CardTitle>
              <CardDescription>
                78 张成品卡（AI 融合边框优先）+ 6 项套件资产，共 {totalCount} 项
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 className="size-3" />
                {readyCount}/{totalCount} 就绪
              </Badge>
              <a href={`/api/agent/runs/${data.run.id}/download`} className="inline-flex">
                <Button size="sm" disabled={readyCount === 0}>
                  <Download className="size-4" />
                  打包下载 ZIP
                </Button>
              </a>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>AI 融合：{framed}/78 张{framing > 0 ? `（${framing} 张进行中）` : ""}</span>
            <span>套件资产：{deliverables?.assets.filter((a) => a.url).length ?? 0}/6 项</span>
            {readyCount < totalCount && (
              <span className="text-amber-600 dark:text-amber-400">
                尚有 {totalCount - readyCount} 项未就绪，可先下载已就绪部分（ZIP 内 manifest.json 记录缺失清单）
              </span>
            )}
          </div>
          {frameFailed.length > 0 && (
            <div className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5">
              <p className="text-xs font-medium text-red-600 dark:text-red-400">
                {frameFailed.length} 张卡面融合失败，可单张重做：
              </p>
              <div className="flex flex-wrap gap-1.5">
                {frameFailed.slice(0, 12).map((item) => (
                  <Button
                    key={item.id}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={actingId !== null}
                    onClick={() => void retryFrame(item.id)}
                  >
                    {actingId === item.id ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                    {item.name ?? `第 ${item.index + 1} 张`}
                  </Button>
                ))}
                {frameFailed.length > 12 && <span className="self-center text-xs text-muted-foreground">等 {frameFailed.length - 12} 张…</span>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 成品卡网格：正方形卡内全比例（与生图评审一致），hover 仅边框发光 */}
      {deliverables && deliverables.cards.length > 0 && (
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
            成品卡
            <span className="text-xs font-normal text-muted-foreground">
              {deliverables.cards.filter((c) => c.finalImage).length}/{deliverables.cards.length} 张可下载（点击图片下载原图）
            </span>
          </div>
          <div className="border-t px-4 pb-4 pt-3">
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
              {deliverables.cards.map((card) => (
                <div key={card.id} className={cn("space-y-1", CARD_SQUARE_THUMB_CLASS)}>
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted text-[10px] text-muted-foreground">
                    {card.finalImage ? (
                      <a href={card.finalImage} target="_blank" rel="noreferrer" download className="size-full">
                        <img
                          src={card.finalImage}
                          alt={card.name ?? `第 ${card.index + 1} 张`}
                          className="size-full object-contain"
                        />
                      </a>
                    ) : (
                      card.index + 1
                    )}
                  </div>
                  <p className="truncate px-0.5 text-[10px]">{card.name ?? `第 ${card.index + 1} 张`}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 套件资产：同款正方形预览 */}
      {deliverables && deliverables.assets.length > 0 && (
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
            套件资产
            <span className="text-xs font-normal text-muted-foreground">
              {deliverables.assets.filter((a) => a.url).length}/6 项（点击图片下载原图）
            </span>
          </div>
          <div className="border-t px-4 pb-4 pt-3">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-6">
              {deliverables.assets.map((asset) => (
                <div key={asset.kind} className={cn("space-y-1", CARD_SQUARE_THUMB_CLASS, "p-1.5")}>
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted text-[10px] text-muted-foreground">
                    {asset.url ? (
                      <a href={asset.url} target="_blank" rel="noreferrer" download className="size-full">
                        <img src={asset.url} alt={asset.label} className="size-full object-contain" />
                      </a>
                    ) : (
                      "待准备"
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1 px-0.5">
                    <p className="truncate text-[10px]">{asset.label}</p>
                    {asset.confirmed && <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
