"use client"

/**
 * art 阶段「周边资产与融合」Tab：AI 融合边框（3 张预览 → 确认 → 78 张批量）。
 * 前置条件：边框资产已确认 + 78 张卡面全部有终版轮次（生产完成）。
 */
import { useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

export function AiFramePanel({
  data,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  onRefresh: () => Promise<unknown>
}) {
  const { confirmAiFrameBatch, requestAiFramePreview } = useWorkspaceActions()
  const [acting, setActing] = useState(false)
  const framed = data.items.filter((item) => item.frameStatus === "framed").length
  const previewReady = framed >= 3
  const border = data.assets.find((asset) => asset.kind === "border")
  const borderStatus = (border?.meta as { status?: string } | null)?.status
  const cardsReady =
    data.items.length === 78 && data.items.every((item) => item.finalRoundId)

  const runAction = async (fn: () => Promise<unknown>, message: string) => {
    setActing(true)
    try {
      await fn()
      await onRefresh()
      toast.success(message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败")
    } finally {
      setActing(false)
    }
  }

  return (
    <Card className="border-violet-500/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-violet-500" />
          AI 融合边框
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          不使用本地叠加。AI 会将边框和无框卡面作为两张参考图融合，先预览 3 张，再批量处理全部 78 张。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">边框</p>
            <p className="mt-1 text-sm font-medium">{borderStatus === "confirmed" ? "已确认" : "待确认"}</p>
          </div>
          <div className="rounded-lg bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">融合预览</p>
            <p className="mt-1 text-sm font-medium">{Math.min(framed, 3)}/3 张</p>
          </div>
          <div className="rounded-lg bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">批量进度</p>
            <p className="mt-1 text-sm font-medium">{framed}/78 张</p>
          </div>
        </div>

        {/* 前置条件提示 */}
        {!cardsReady && (
          <p className={cn("rounded-lg border border-dashed px-3 py-2 text-xs", "text-muted-foreground")}>
            需要先完成「卡面生产」全部 78 张并确认终版，再进行 AI 融合
            {borderStatus !== "confirmed" && "；并确认透明边框资产"}。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!previewReady ? (
            <Button
              disabled={acting || borderStatus !== "confirmed" || !cardsReady}
              onClick={() =>
                void runAction(
                  () => requestAiFramePreview({ runId: data.run.id, borderAssetId: border!.id }),
                  "已提交 3 张 AI 融合预览",
                )
              }
            >
              {acting && <Loader2 className="size-4 animate-spin" />}
              生成 3 张融合预览
            </Button>
          ) : (
            <Button
              disabled={acting}
              onClick={() => void runAction(() => confirmAiFrameBatch(data.run.id), "已提交 78 张批量 AI 融合")}
            >
              {acting && <Loader2 className="size-4 animate-spin" />}
              确认预览并批量融合 78 张
            </Button>
          )}
          <Badge variant="outline">仅 AI 融合</Badge>
        </div>
      </CardContent>
    </Card>
  )
}
