"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/workspace/spinner"
import { toast } from "sonner"
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileArchive,
  FileImage,
} from "lucide-react"
import { createExportTicketAction } from "@/server/actions/workspace"
import {
  resolveCardDisplayImage,
  sanitizeFilenamePart,
} from "@/lib/workspace/helpers"
import type { CardImageRow, PromptCardRow } from "@/lib/workspace/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskId: string | null
  taskTitle: string
  cards: PromptCardRow[]
  /** 各卡片图片列表（轮询状态），用于 selectedImageId 为空时的展示回退 */
  cardImagesMap: Map<string, CardImageRow[]>
  selectedCardIds: Set<string>
  batchMode: boolean
}

type ExportStep = "confirm" | "format" | "exporting" | "done"
type ExportImageFormat = "jpg" | "png"

export function ExportDialog({
  open,
  onOpenChange,
  taskId,
  taskTitle,
  cards,
  cardImagesMap,
  selectedCardIds,
  batchMode,
}: Props) {
  const [step, setStep] = useState<ExportStep>("confirm")
  const [doneMessage, setDoneMessage] = useState("")
  const [imageFormat, setImageFormat] = useState<ExportImageFormat>("jpg")

  // 卡片可导出图片：选中图（selImgUrl）→ 展示回退链（selectedImageId /
  // isSelected / 首张已完成，与卡片正面展示一致）。存量卡片从未显式选图时
  // selImgUrl 为空，靠回退链取图，避免误判「尚未生成图片」
  const exportImageUrlOf = (card: PromptCardRow): string | null =>
    card.selImgUrl ||
    resolveCardDisplayImage(card, cardImagesMap.get(card.id) ?? [])?.imageUrl ||
    null

  // 根据是否有选中卡片，决定导出范围
  const isPartialExport = batchMode && selectedCardIds.size > 0
  const targetCards = isPartialExport
    ? cards.filter((c) => selectedCardIds.has(c.id))
    : cards
  const cardsWithImages = targetCards.filter((c) => exportImageUrlOf(c))
  const cardsWithoutImages = targetCards.filter((c) => !exportImageUrlOf(c))

  const handleConfirm = () => {
    if (cardsWithImages.length === 0) return
    setStep("format")
  }

  const handleExportZip = async () => {
    if (!taskId || cardsWithImages.length === 0) return
    setStep("exporting")
    try {
      const res = await createExportTicketAction(taskId, {
        format: imageFormat,
        ...(isPartialExport
          ? { cardIds: cardsWithImages.map((c) => c.id) }
          : {}),
      })
      if (!res.ok || !res.downloadUrl) {
        throw new Error(res.error || "导出失败")
      }
      window.open(res.downloadUrl, "_blank")
      toast.success(
        `已导出图片压缩包，共 ${cardsWithImages.length} 张 ${imageFormat.toUpperCase()} 图片`,
      )
      setDoneMessage(
        `图片压缩包已开始下载，文件内为按卡片序号命名的 ${imageFormat.toUpperCase()} 图片`,
      )
      setStep("done")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败")
      setStep("confirm")
    }
  }

  const handleExportImages = async () => {
    if (cardsWithImages.length === 0) return
    setStep("exporting")
    try {
      const taskName =
        sanitizeFilenamePart(taskTitle || "批量生图") || "批量生图"
      for (let index = 0; index < cardsWithImages.length; index += 1) {
        const card = cardsWithImages[index]
        const imageUrl = exportImageUrlOf(card)
        if (!imageUrl) continue
        const proxyUrl = `/api/image/proxy?url=${encodeURIComponent(imageUrl)}&format=${imageFormat}`
        const response = await fetch(proxyUrl)
        if (!response.ok) {
          throw new Error(`第 ${card.cardIndex} 张图片下载失败`)
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `${taskName}-${String(card.cardIndex).padStart(2, "0")}.${imageFormat}`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        if (index < cardsWithImages.length - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 180))
        }
      }
      toast.success(
        `已逐张导出 ${cardsWithImages.length} 张 ${imageFormat.toUpperCase()} 图片`,
      )
      setDoneMessage(
        `图片已开始逐张下载，文件名为按卡片序号命名的 ${imageFormat.toUpperCase()} 图片`,
      )
      setStep("done")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败")
      setStep("confirm")
    }
  }

  const handleClose = () => {
    setStep("confirm")
    setDoneMessage("")
    setImageFormat("jpg")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-sm">
        {/* 步骤1：确认导出范围 */}
        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Download className="h-4 w-4" />
                导出图片
              </DialogTitle>
              <DialogDescription>
                {isPartialExport
                  ? `将导出已选中的 ${targetCards.length} 张卡片的展示图片`
                  : "将导出当前任务内所有有图片卡片的展示图片"}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">可导出图片</span>
                <span className="font-medium text-emerald-600">
                  {cardsWithImages.length} 张
                </span>
              </div>
              {cardsWithoutImages.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/20">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {cardsWithoutImages.length} 张卡片尚未生成图片，将跳过
                  </p>
                </div>
              )}
              {cardsWithImages.length === 0 && (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  暂无可导出的图片，请先生成图片
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={cardsWithImages.length === 0}
              >
                下一步
              </Button>
            </DialogFooter>
          </>
        )}

        {/* 步骤2：选择导出格式与方式 */}
        {step === "format" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Download className="h-4 w-4" />
                选择导出方式
              </DialogTitle>
              <DialogDescription>
                共 {cardsWithImages.length} 张展示图片，请选择导出方式
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-3">
              <div className="space-y-2">
                <div className="text-sm font-medium">图片格式</div>
                <div className="flex gap-2">
                  <Button
                    variant={imageFormat === "jpg" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setImageFormat("jpg")}
                  >
                    JPG
                  </Button>
                  <Button
                    variant={imageFormat === "png" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setImageFormat("png")}
                  >
                    PNG
                  </Button>
                </div>
              </div>
              <button
                type="button"
                onClick={handleExportZip}
                className="flex w-full items-center gap-3 rounded-md border-2 border-border p-3.5 text-left transition-colors hover:border-primary hover:bg-primary/5"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-100 dark:bg-blue-950/30">
                  <FileArchive className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <span className="block text-sm font-medium">
                    导出为图片压缩包
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    文件命名为 任务名称-卡片序号.{imageFormat}
                  </span>
                </div>
              </button>
              <button
                type="button"
                onClick={handleExportImages}
                className="flex w-full items-center gap-3 rounded-md border-2 border-border p-3.5 text-left transition-colors hover:border-primary hover:bg-primary/5"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-950/30">
                  <FileImage className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                  <span className="block text-sm font-medium">
                    导出为图片（逐张导出）
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    逐张下载 {imageFormat.toUpperCase()} 图片，命名同样使用任务名称和卡片序号
                  </span>
                </div>
              </button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("confirm")}>
                返回
              </Button>
            </DialogFooter>
          </>
        )}

        {/* 步骤3：导出中 */}
        {step === "exporting" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Download className="h-4 w-4" />
                导出中
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-6">
              <Spinner />
              <p className="text-sm text-muted-foreground">
                正在生成文件，请稍候...
              </p>
            </div>
          </>
        )}

        {/* 步骤4：导出完成 */}
        {step === "done" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                导出完成
              </DialogTitle>
            </DialogHeader>
            <p className="py-4 text-center text-sm text-muted-foreground">
              {doneMessage || "文件已开始下载"}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                关闭
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
