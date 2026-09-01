"use client"

import * as React from "react"
import { Loader2, RefreshCw, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SmartImage } from "@/components/ui/smart-image"
import { uploadImage } from "@/lib/upload/upload-image"
import { addMockupDesignAssetAction, listGeneratedAssetsAction } from "@/server/actions/mockup"
import type { MockupLibraryImage } from "@/lib/mockup/types"
import { toImageSrc } from "@/lib/utils"

/**
 * 图片库弹窗（图层替换时选择图片）
 *
 * Tab 1「我的上传」：本页上传的设计稿（mockup_design_asset，个人维度），
 * 支持当场上传（uploadImage → 入库）。
 * Tab 2「生成图资产」：最近的生图任务结果（listGeneratedAssetsAction）。
 */

interface ImageLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 我的上传（父级持有，上传成功后回传追加） */
  assets: MockupLibraryImage[]
  onUploaded: (image: MockupLibraryImage) => void
  onSelect: (imageUrl: string) => void
}

export function ImageLibraryDialog({
  open,
  onOpenChange,
  assets,
  onUploaded,
  onSelect,
}: ImageLibraryDialogProps) {
  const [tab, setTab] = React.useState<"upload" | "generated">("upload")
  const [generated, setGenerated] = React.useState<MockupLibraryImage[]>([])
  const [generatedLoading, setGeneratedLoading] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const loadGenerated = React.useCallback(async () => {
    setGeneratedLoading(true)
    try {
      const res = await listGeneratedAssetsAction(40)
      setGenerated(res.images)
    } catch {
      toast.error("生成图加载失败")
    } finally {
      setGeneratedLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open && tab === "generated" && generated.length === 0 && !generatedLoading) {
      void loadGenerated()
    }
  }, [open, tab, generated.length, generatedLoading, loadGenerated])

  const handleUpload = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    try {
      const url = await uploadImage(file)
      const res = await addMockupDesignAssetAction({
        imageUrl: url,
        fileName: file.name,
      })
      if (!res.ok) {
        toast.error(res.error ?? "入库失败")
        return
      }
      const image: MockupLibraryImage = {
        id: crypto.randomUUID(),
        imageUrl: url,
        fileName: file.name,
      }
      onUploaded(image)
      setTab("upload")
      toast.success("上传成功")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleSelect = (imageUrl: string) => {
    onSelect(imageUrl)
    onOpenChange(false)
  }

  const list = tab === "upload" ? assets : generated

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>图片库</DialogTitle>
          <DialogDescription>选择要替换的图片，或当场上传设计稿</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "upload" | "generated")}
          >
            <TabsList>
              <TabsTrigger value="upload">我的上传</TabsTrigger>
              <TabsTrigger value="generated">生成图资产</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-1">
            {tab === "generated" ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void loadGenerated()}
                disabled={generatedLoading}
              >
                <RefreshCw className="size-4" />
              </Button>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => void handleUpload(e.target.files?.[0])}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              上传图片
            </Button>
          </div>
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
          {tab === "generated" && generatedLoading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
            </div>
          ) : list.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {tab === "upload" ? "还没有上传过设计稿" : "暂无生成图"}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {list.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  className="group relative aspect-square overflow-hidden rounded-md border bg-muted transition hover:border-primary"
                  title={img.fileName ?? ""}
                  onClick={() => handleSelect(img.imageUrl)}
                >
                  <SmartImage
                    src={toImageSrc(img.imageUrl, { width: 200 })}
                    alt={img.fileName ?? "图片"}
                    className="size-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
