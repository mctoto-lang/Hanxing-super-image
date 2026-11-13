"use client"

import * as React from "react"
import { toast } from "sonner"
import { ImagePlus, Plus, Trash2 } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { submitProductCarouselAction } from "@/server/actions/temu-publish"
import { uploadTemuAsset } from "@/lib/upload/upload-image"
import { compressToJpegBlob, storeImageBlob } from "./publish/image-utils"
import type { TemuProductRow } from "@/server/actions/temu"

/**
 * 换图片弹窗（商品信息页设置菜单）：轮播图集整组提交。
 * 官方口径（docs §8.12，2026-11-09 探针）：edit.pictures.submit 仅提交
 * carouselImageUrls 即生效（部位提交）；非服饰轮播至少 5 张；第一张为主图位。
 * 官方无「查当前素材」接口（detail.get 不含轮播）——列表从当前主图起填，
 * 其余位由用户补齐，提交以本次填写整组为准。
 */

/** 硬上限 20MB（防超大文件拖垮浏览器压缩）；官方素材图闸门 2M，超过先压缩（服务端会再校验一次） */
const MAX_BYTES = 20 * 1024 * 1024
/** 官方素材图上限（提交链路 uploadImageToStore 终校验，官方 2000021） */
const MATERIAL_MAX_BYTES = 2 * 1024 * 1024

export function ProductMediaEditDialog({
  open,
  onOpenChange,
  row,
  storeId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 链接（SKC）主行：取 productId / productName / 主图做首位预填 */
  row: TemuProductRow | null
  storeId?: string
}) {
  /** 轮播位（第一张=主图位）；空串=待上传占位 */
  const [urls, setUrls] = React.useState<string[]>([])
  const [uploadingIdx, setUploadingIdx] = React.useState<number | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const fileRefs = React.useRef<Array<HTMLInputElement | null>>([])

  // 打开时初始化：主图占首位 + 4 个空位（满足至少 5 张的表单起点）
  React.useEffect(() => {
    if (open) {
      const first = row?.mainImageUrl ? [row.mainImageUrl] : [""]
      setUrls([...first, "", "", "", ""])
    }
  }, [open, row])

  const setUrl = (i: number, v: string) => {
    setUrls((prev) => prev.map((u, j) => (j === i ? v : u)))
  }

  const pickFile = async (i: number, file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error("单张图片最大 20MB")
      return
    }
    setUploadingIdx(i)
    try {
      // >2M 先浏览器压缩再直传本站存储（temu/ 前缀不过期，同发品域口径——
      // 官方素材图闸门 2M，不压缩会在提交官方时才整组报错）；提交时服务端转官方图床
      const url =
        file.size > MATERIAL_MAX_BYTES
          ? await storeImageBlob(await compressToJpegBlob(file))
          : await uploadTemuAsset(file)
      setUrl(i, url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "图片上传失败")
    } finally {
      setUploadingIdx(null)
      const el = fileRefs.current[i]
      if (el) el.value = ""
    }
  }

  const filled = urls.filter((u) => u.trim() !== "")
  const canSubmit = !submitting && filled.length >= 5 && !!row?.productId && !!storeId

  const submit = async () => {
    if (!row?.productId || !storeId) return
    // 空位剔除后按填写顺序提交（首位须已填=主图位）
    setSubmitting(true)
    try {
      const r = await submitProductCarouselAction({
        storeId,
        productId: row.productId,
        imageUrls: filled,
      })
      if (r.ok) {
        toast.success("轮播图已提交官方（生效以官方审核为准）")
        onOpenChange(false)
      } else {
        toast.error(r.error)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>换图片</DialogTitle>
          <DialogDescription>
            {row?.productName ? `${row.productName.slice(0, 40)}${row.productName.length > 40 ? "…" : ""} · ` : ""}
            轮播图整组提交（第一张为主图位，至少 5 张）。
          </DialogDescription>
          {/* DialogDescription 渲染 <p>，块级提示须放外部防 p>div 嵌套 hydration 错 */}
          <div className="text-xs text-muted-foreground">
            官方无素材回显接口，本表单以本次填写为准；未填写的图片位将不在新轮播中。图片须 1:1、≥800×800、≤2M、JPG/PNG。
          </div>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-2">
          {urls.map((u, i) => (
            <div key={i} className="space-y-1">
              <div className="relative aspect-square w-full overflow-hidden rounded-md border bg-muted/40">
                {u ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 本站/官方外链不走 next/image
                  <img src={u} alt={`轮播 ${i + 1}`} className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    {uploadingIdx === i ? (
                      <DashRing className="size-4" />
                    ) : (
                      <ImagePlus className="size-4" />
                    )}
                  </div>
                )}
                {i === 0 && (
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                    主图
                  </span>
                )}
                {u && (
                  <button
                    type="button"
                    aria-label="移除"
                    className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white hover:bg-black/80"
                    onClick={() => setUrl(i, "")}
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </div>
              <input
                ref={(el) => {
                  fileRefs.current[i] = el
                }}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void pickFile(i, f)
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-full text-[11px]"
                disabled={uploadingIdx === i}
                onClick={() => fileRefs.current[i]?.click()}
              >
                {u ? "更换" : "上传"}
              </Button>
            </div>
          ))}
        </div>

        {urls.length < 30 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setUrls((prev) => [...prev, ""])}
          >
            <Plus className="size-3" /> 添加一张（{urls.length}/30）
          </Button>
        )}

        <div className="text-xs text-muted-foreground">
          已填 {filled.length} 张{filled.length < 5 ? `，还需 ${5 - filled.length} 张起提` : "，可以提交"}
          {!row?.productId && " ；该链接缺 SPU 编号（productId），无法提交"}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? <DashRing className="size-4" /> : null}
            提交官方
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
