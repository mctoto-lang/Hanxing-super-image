"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { ImagePlus, Loader2, Trash2 } from "lucide-react"
import { ImageLibraryDialog } from "@/components/mockup/image-library-dialog"
import { listMockupDesignAssetsAction } from "@/server/actions/mockup"
import type { MockupLibraryImage } from "@/lib/mockup/types"
import { toImageSrc } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { checkImageDims, compressToDataUrl, probeImageBlob } from "./image-utils"

/**
 * 素材图组字段（模板存源、发品时按目标店铺上传官方图床——保存模板零 TEMU 调用）：
 * 从图片库选图（我的上传/生成图资产，可在弹窗内上传）→ 本地探测尺寸/大小
 * （1:1 ≥800 提前提示）→ >2MB 压缩（autoCompress=静默自动，默认弹窗确认）
 * → 存「源 URL 或压缩 dataUrl」。
 * 图[0] 兼作素材图/SKU 预览/缩略，全部进轮播；官方 1:1/≥800/≤2M 终校验在发品侧。
 */
export function ImageUploadField({
  images,
  onChange,
  max = 20,
  hint,
  autoCompress = false,
}: {
  images: string[]
  onChange: (next: string[]) => void
  /** 最大张数（尺寸图单槽传 1） */
  max?: number
  /** 底部说明覆盖（默认素材图口径文案） */
  hint?: string
  /** >2MB 静默浏览器压缩（发品弹窗用）；默认走确认弹窗（向导用） */
  autoCompress?: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  /** 样机「我的上传」素材（图片库弹窗父级持有，上传成功回传追加） */
  const [assets, setAssets] = useState<MockupLibraryImage[]>([])

  /** >2MB 图片待确认压缩（pending=≤2MB 正常队列；autoCompress 时不使用） */
  const [compressAsk, setCompressAsk] = useState<{
    oversized: Array<{ img: MockupLibraryImage; blob: Blob }>
    pending: string[]
  } | null>(null)

  useEffect(() => {
    if (!pickerOpen || assets.length > 0) return
    void (async () => {
      const res = await listMockupDesignAssetsAction()
      setAssets(res.images ?? [])
    })()
  }, [pickerOpen, assets.length])

  const acceptSources = useCallback(
    async (sources: string[]) => {
      const ok: string[] = []
      for (const src of sources) {
        if (await checkImageDims(src)) ok.push(src)
        else {
          toast.error("图片不满足 1:1 且 ≥800×800（官方 2000017，发品会被拒），已跳过")
        }
      }
      if (ok.length > 0) onChange([...images, ...ok])
    },
    [images, onChange],
  )

  /** >2MB 批量压缩后并入（autoCompress 静默执行；确认流程复用同一函数） */
  const runCompress = useCallback(
    async (oversized: Array<{ img: MockupLibraryImage; blob: Blob }>, pendingUrls: string[]) => {
      setUploading(true)
      try {
        const items = [...pendingUrls]
        let failed = 0
        for (const { img, blob } of oversized) {
          try {
            items.push(await compressToDataUrl(blob))
          } catch (err) {
            failed++
            toast.error(`${img.fileName ?? "图片"}：${err instanceof Error ? err.message : "压缩失败"}`)
          }
        }
        await acceptSources(items)
        if (failed > 0) toast.error(`${failed} 张压缩失败已跳过`)
      } finally {
        setUploading(false)
      }
    },
    [acceptSources],
  )

  const pickMany = useCallback(
    async (picked: MockupLibraryImage[]) => {
      if (picked.length === 0) return
      // 同域代理取 blob 判大小（代理失败按原样接收，发品侧终校验）
      const probed: Array<{ img: MockupLibraryImage; blob?: Blob }> = []
      for (const img of picked) {
        probed.push({ img, blob: await probeImageBlob(img.imageUrl) })
      }
      const oversized = probed.filter((x) => x.blob && x.blob.size > 2 * 1024 * 1024) as Array<{
        img: MockupLibraryImage
        blob: Blob
      }>
      if (oversized.length > 0) {
        const pending = probed
          .filter((x) => !x.blob || x.blob.size <= 2 * 1024 * 1024)
          .map((x) => x.img.imageUrl)
        // >2MB 必须先过浏览器压缩才能上官方图床（官方上传闸门 2M、
        // 官方压缩只认已上图床 URL）——autoCompress 静默执行，否则确认
        if (autoCompress) {
          await runCompress(oversized, pending)
        } else {
          setCompressAsk({ oversized, pending })
        }
        return
      }
      await acceptSources(probed.map((x) => x.img.imageUrl))
    },
    [acceptSources, autoCompress, runCompress],
  )

  const confirmCompress = async () => {
    if (!compressAsk) return
    const ask = compressAsk
    setCompressAsk(null)
    await runCompress(ask.oversized, ask.pending)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((src, i) => (
          <div key={src.slice(0, 120) + i} className="group relative size-20 overflow-hidden rounded-md border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={toImageSrc(src, { width: 160 })} alt={`素材 ${i + 1}`} className="size-full object-cover" />
            {i === 0 && images.length > 1 && (
              <span className="absolute bottom-0 left-0 bg-primary px-1 text-[10px] text-primary-foreground">
                主图
              </span>
            )}
            <button
              type="button"
              className="absolute inset-0 hidden items-center justify-center bg-black/50 group-hover:flex"
              onClick={() => onChange(images.filter((x) => x !== src))}
            >
              <Trash2 className="size-4 text-white" />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          className="size-20 flex-col gap-1"
          disabled={uploading || images.length >= max}
          onClick={() => setPickerOpen(true)}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          <span className="text-[10px]">{uploading ? "处理中" : "添加"}</span>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {hint ??
          "可不配置（发品时必须 ≥5 张，可在发品弹窗补传）；图源在发品时自动按目标店铺上传官方图床（1:1、≥800×800、≤2M 官方校验；超 2MB 选图时浏览器压缩）。第一张兼作素材图与 SKU 预览，全部进轮播。"}
      </p>

      <ImageLibraryDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        assets={assets}
        onUploaded={(img) => setAssets((prev) => [img, ...prev])}
        onSelect={(url) => {
          setPickerOpen(false)
          void pickMany([{ id: url, imageUrl: url, fileName: null }])
        }}
        multiple
        maxSelect={Math.max(1, max - images.length)}
        onSelectMany={(picked) => {
          setPickerOpen(false)
          void pickMany(picked)
        }}
      />

      <ConfirmDialog
        open={compressAsk !== null}
        onOpenChange={(o) => {
          if (!o && compressAsk) {
            const pending = compressAsk.pending
            const skipped = compressAsk.oversized.length
            setCompressAsk(null)
            if (skipped > 0) toast.warning(`已跳过 ${skipped} 张超过 2MB 的图片`)
            void acceptSources(pending)
          }
        }}
        title="压缩后使用"
        description={`有 ${compressAsk?.oversized.length ?? 0} 张图片大于 2MB（官方上限），将在浏览器中压缩（限宽 1600、JPEG 降质）后存为模板素材。是否继续？取消则跳过这些图片。`}
        confirmText="压缩使用"
        destructive={false}
        pending={uploading}
        onConfirm={() => void confirmCompress()}
      />
    </div>
  )
}
