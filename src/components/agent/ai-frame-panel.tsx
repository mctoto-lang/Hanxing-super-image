"use client"

/* 参考图 URL 由受控上传接口返回，使用原生 img 兼容本地存储与 COS。 */
/* eslint-disable @next/next/no-img-element */

/**
 * compose 阶段「AI 融合边框」面板：
 * 1. 选择边框参考图 —— 从本 run 已有边框资产（AI 生成或上传）中选择，
 *    或直接上传一张新参考图（落为边框资产后即可选用，不要求「已确认」）；
 * 2. 生成 3 张融合预览 → 确认 → 批量处理全部 78 张。
 * 前置条件：78 张卡面全部有终版轮次（生产完成）。
 */
import { useEffect, useMemo, useState } from "react"
import { Loader2, Sparkles, Upload } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { TemplateWorkspaceData } from "./use-template-workspace"
import { useWorkspaceActions } from "./workspace-actions"

export function ComposeFramePanel({
  data,
  onRefresh,
}: {
  data: TemplateWorkspaceData
  onRefresh: () => Promise<unknown>
}) {
  const { confirmAiFrameBatch, requestAiFramePreview, saveTarotAsset } = useWorkspaceActions()
  const [acting, setActing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const borders = useMemo(() => data.assets.filter((asset) => asset.kind === "border"), [data.assets])
  const [borderId, setBorderId] = useState<string>("")
  // 资产列表刷新后保持选中项有效；默认选中最新一条（含 run.frameAssetId 记忆）
  useEffect(() => {
    if (borderId && borders.some((asset) => asset.id === borderId)) return
    const remembered = borders.find((asset) => asset.id === data.run.frameAssetId)
    setBorderId(remembered?.id ?? borders[0]?.id ?? "")
  }, [borders, borderId, data.run.frameAssetId])

  const framed = data.items.filter((item) => item.frameStatus === "framed").length
  const framing = data.items.filter((item) => item.frameStatus === "framing").length
  const failed = data.items.filter((item) => item.frameStatus === "failed").length
  const previewReady = framed >= 3
  const cardsReady = data.items.length === 78 && data.items.every((item) => item.finalRoundId)
  const selectedBorder = borders.find((asset) => asset.id === borderId) ?? null

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

  const uploadBorder = async (file: File) => {
    if (!file.type.startsWith("image/")) return toast.error("请上传图片文件")
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const response = await fetch("/api/upload", { method: "POST", body: form })
      if (!response.ok) throw new Error("图片上传失败")
      const result = await response.json() as { url?: string }
      if (!result.url) throw new Error("上传接口未返回图片地址")
      // 服务端会校验边框透明 PNG；不通过会直接报错提示
      const asset = await saveTarotAsset({ runId: data.run.id, kind: "border", url: result.url!, source: "upload" })
      await onRefresh()
      setBorderId(asset.id)
      toast.success("边框参考图已上传")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传失败")
    } finally {
      setUploading(false)
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
          选择或上传一张边框参考图，AI 会把它与无框卡面作为两张参考图逐张融合（非本地叠加）。先预览 3 张，确认后批量处理全部 78 张。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!cardsReady ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
            需要先在「卡面生产」完成全部 78 张并确认终版，再进行 AI 融合。
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">边框参考图</p>
                <p className="mt-1 text-sm font-medium">
                  {selectedBorder ? "已选择" : "待选择 / 上传"}
                </p>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">融合预览</p>
                <p className="mt-1 text-sm font-medium">{Math.min(framed, 3)}/3 张</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">批量进度</p>
                <p className="mt-1 text-sm font-medium">
                  {framed}/78 张{framing > 0 ? `（${framing} 张进行中）` : ""}
                </p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* 恒传 string（初始 ""）保持受控，避免 uncontrolled→controlled 切换告警；无匹配项时显示 placeholder */}
                  <Select value={borderId} onValueChange={(value) => value && setBorderId(value)}>
                    <SelectTrigger className="w-64" aria-label="边框参考图">
                      <SelectValue placeholder={borders.length === 0 ? "暂无边框资产，请上传" : "选择边框参考图"} />
                    </SelectTrigger>
                    <SelectContent>
                      {borders.map((asset) => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {(asset.meta as { source?: string } | null)?.source === "ai" ? "AI 生成" : "上传"}
                          {" · "}
                          {new Date(asset.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label
                    className={cn(
                      "inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-muted",
                      uploading && "pointer-events-none opacity-50",
                    )}
                  >
                    {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                    上传新参考图
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      disabled={uploading}
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (file) void uploadBorder(file)
                        event.currentTarget.value = ""
                      }}
                    />
                  </label>
                  {selectedBorder && (selectedBorder.meta as { hasAlpha?: boolean | null } | null)?.hasAlpha === false && (
                    <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
                      该参考图检测为不透明
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!previewReady ? (
                    <Button
                      disabled={acting || !borderId || framing > 0}
                      onClick={() =>
                        selectedBorder &&
                        void runAction(
                          () => requestAiFramePreview({ runId: data.run.id, borderAssetId: selectedBorder.id }),
                          "已提交 3 张 AI 融合预览",
                        )
                      }
                    >
                      {acting && <Loader2 className="size-4 animate-spin" />}
                      生成 3 张融合预览
                    </Button>
                  ) : (
                    <>
                      <Button
                        disabled={acting}
                        onClick={() => void runAction(() => confirmAiFrameBatch(data.run.id), "已提交 78 张批量 AI 融合")}
                      >
                        {acting && <Loader2 className="size-4 animate-spin" />}
                        确认预览并批量融合 78 张
                      </Button>
                      {/* 批量融合服务端读 run.frameAssetId（仅预览 action 写入），换选/新传边框后必须能重新预览让新选择生效 */}
                      <Button
                        variant="outline"
                        disabled={acting || !borderId || framing > 0}
                        onClick={() =>
                          selectedBorder &&
                          void runAction(
                            () => requestAiFramePreview({ runId: data.run.id, borderAssetId: selectedBorder.id }),
                            "已提交 3 张 AI 融合预览",
                          )
                        }
                      >
                        {acting && <Loader2 className="size-4 animate-spin" />}
                        用当前所选边框重新预览
                      </Button>
                    </>
                  )}
                  {failed > 0 && (
                    <Badge variant="outline" className="border-red-500/40 text-[10px] text-red-600 dark:text-red-400">
                      {failed} 张失败，可在下方成品网格单张重做
                    </Badge>
                  )}
                </div>
              </div>

              {/* 参考图预览 */}
              <div className="rounded-xl border bg-muted/20 p-2">
                {selectedBorder ? (
                  <div className="aspect-square overflow-hidden rounded-lg bg-muted">
                    <img src={selectedBorder.url} alt="边框参考图" className="size-full object-contain" />
                  </div>
                ) : (
                  <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                    暂无参考图
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
