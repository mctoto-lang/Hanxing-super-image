"use client"

import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Upload, X } from "lucide-react"
import { toast } from "sonner"
import { uploadReferenceImages } from "@/lib/workspace/upload"
import { batchAttachUploadedImagesAction } from "@/server/actions/workspace"
import type { CardImageRow } from "@/lib/workspace/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardIds: string[]
  onCompleted: (imagesByCard: Record<string, CardImageRow[]>) => void
}

export function BatchImageUploadDialog({
  open,
  onOpenChange,
  cardIds,
  onCompleted,
}: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) setFiles([])
  }, [open])

  const handleSubmit = async () => {
    if (!files.length) {
      toast.error("请先选择图片")
      return
    }
    setSubmitting(true)
    try {
      const uploaded = await uploadReferenceImages(files)
      if (!uploaded.length) {
        throw new Error("没有可上传的图片")
      }
      const imageUrls = uploaded.map((item) => item.url)
      const res = await batchAttachUploadedImagesAction(cardIds, imageUrls)
      if (!res.ok) {
        throw new Error("批量保存图片失败")
      }
      onCompleted(res.imagesByCard)
      toast.success(
        `已将 ${imageUrls.length} 张图片同步到 ${cardIds.length} 张卡片`,
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量上传失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && submitting) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>批量上传图片</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            上传完成并确认后，图片会同步到已选中的 {cardIds.length}{" "}
            张卡片图片库中。
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 border-dashed"
            onClick={() => inputRef.current?.click()}
            disabled={submitting}
          >
            <Upload className="h-4 w-4" />
            选择图片
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(event) => {
              setFiles((previous) => [
                ...previous,
                ...Array.from(event.target.files || []),
              ])
              event.target.value = ""
            }}
          />
          {files.length > 0 && (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
              {files.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm"
                >
                  <span className="truncate">{file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={submitting}
                    onClick={() =>
                      setFiles((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !files.length}>
            {submitting ? (
              <>
                <MorphingInfinity className="size-4" />
                上传并同步中...
              </>
            ) : (
              "确认上传"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
