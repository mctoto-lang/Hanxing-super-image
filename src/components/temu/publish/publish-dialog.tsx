"use client"

import { useState } from "react"
import { toast } from "sonner"
import { ImagePlus, Loader2, RefreshCw, Send, Trash2 } from "lucide-react"
import type { TemuStoreBrief } from "@/server/actions/temu"
import {
  publishFromTemplateAction,
  type TemuPublishTemplateRow,
} from "@/server/actions/temu-publish"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ImageLibraryDialog } from "@/components/mockup/image-library-dialog"
import { listMockupDesignAssetsAction } from "@/server/actions/mockup"
import type { MockupLibraryImage } from "@/lib/mockup/types"
import { toImageSrc } from "@/lib/utils"
import { checkImageDims, compressToDataUrl, probeImageBlob } from "./image-utils"

/** 发品：锁定层自模板，默认层（标题/图/申报价/货号）可覆盖；提交 goods.add 到页面选中店铺。
 *  轮播图 = 单一有序列表（模板图打开即回填：素材 + 尺寸图插到第 2 位），全槽位可删/换/
 *  拖动排序；第 2 张自动视为尺寸图（提交时单独上传 + 官方校验后插回原位）。
 *  >2MB 图静默浏览器压缩（官方上传闸门 2M），上传后大图由服务端批量官方压缩。 */
export function PublishDialog({
  template,
  store,
  onOpenChange,
}: {
  template: TemuPublishTemplateRow
  /** 页面右上角选中的目标店铺（全托 + token 有效） */
  store: TemuStoreBrief
  onOpenChange: (v: boolean) => void
}) {
  const [title, setTitle] = useState(template.defaults.title)
  const [priceYuan, setPriceYuan] = useState((template.defaults.declaredPriceFen / 100).toString())
  const [extCode, setExtCode] = useState(template.defaults.extCode ?? "")
  /** 轮播图（有序）：模板回填（素材 + 尺寸图插到第 2 位），编辑直接作用于全量列表 */
  const [images, setImages] = useState<string[]>(() => {
    const base = [...template.defaults.imageUrls]
    if (template.defaults.dimensionImageUrl) base.splice(1, 0, template.defaults.dimensionImageUrl)
    return base
  })
  const [submitting, setSubmitting] = useState(false)

  const fen = Math.round(Number(priceYuan) * 100)
  const valid = title.trim() && Number.isFinite(fen) && fen > 0 && images.length >= 5

  const submit = async () => {
    setSubmitting(true)
    try {
      // 第 2 张 = 尺寸图：从素材中拆出单独传，服务端校验后插回轮播第 2 位（顺序不变）
      const dimension = images[1] ?? null
      const materials = images.filter((_, i) => i !== 1)
      const r = await publishFromTemplateAction({
        templateId: template.id,
        storeId: store.id,
        overrides: {
          title: title.trim(),
          declaredPriceFen: fen,
          extCode: extCode.trim(),
          imageUrls: materials,
          ...(dimension ? { dimensionImageUrl: dimension } : {}),
        },
      })
      if (r.ok) {
        toast.success(
          `已发布到「${store.name}」${store.mallName && store.mallName !== store.name ? `（token 归属 ${store.mallName}）` : ""}，productId ${r.productId}（约 15 分钟内随同步出现在商品信息页）`,
          { duration: 8000 },
        )
        if (r.dimensionCheck) {
          toast(`尺寸图校验（参考性）：${r.dimensionCheck.message}${r.dimensionCheck.imageType != null ? `（imageType=${r.dimensionCheck.imageType}）` : ""}`, {
            duration: 8000,
          })
        }
        onOpenChange(false)
      } else {
        toast.error(r.error?.slice(0, 1500) ?? "发品失败", { duration: 8000 })
      }
    } catch {
      // server action promise reject（请求体超限被拒 / 网络错）时兜底提示，避免静默失败
      toast.error("发品失败：请求过大或网络错误，请重试", { duration: 8000 })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>发品：{template.name}</DialogTitle>
          <DialogDescription>
            类目/属性/规格/重量体积为模板锁定；以下默认值仅本次覆盖，发布到当前选中店铺。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">商品名</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">申报价（元）</Label>
              <Input type="number" min="0.01" step="0.01" value={priceYuan} onChange={(e) => setPriceYuan(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">货号</Label>
              <Input value={extCode} onChange={(e) => setExtCode(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              轮播图（模板图已回填；全部可删除/替换/拖动排序，第 2 张视为尺寸图）
            </Label>
            <CarouselSlots images={images} onChange={setImages} />
            <p className="text-xs text-muted-foreground">
              官方最少 5 张 1:1 ≥800，当前 {images.length} 张
              {images.length < 5 ? "——不足 5 张无法提交" : "；发品时自动按目标店上传并压缩。"}
            </p>
          </div>
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            部分类目官方强制「外包装照片」且暂无 API 上传通路，若被拒会在下方错误与发品记录中显示官方原因。
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            发布到 {store.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 轮播编辑器：单一有序图片列表——每槽位 hover 删除/替换，原生拖拽排序，
 *  尾部「＋」从图库追加（多选）；不足 5 张时补虚线占位。角标按位置：
 *  第 1 张主图、第 2 张尺寸图（跟随位置，拖动后自动切换语义）。 */
function CarouselSlots({
  images,
  onChange,
}: {
  images: string[]
  onChange: (next: string[]) => void
}) {
  /** 图库选择意图：add=尾部追加（多选）；replace=替换指定槽位（单选） */
  const [picker, setPicker] = useState<{ mode: "add" } | { mode: "replace"; index: number } | null>(
    null,
  )
  const [assets, setAssets] = useState<MockupLibraryImage[]>([])
  const [busy, setBusy] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const openPicker = (intent: { mode: "add" } | { mode: "replace"; index: number }) => {
    setPicker(intent)
    if (assets.length === 0) {
      void (async () => {
        const res = await listMockupDesignAssetsAction()
        setAssets(res.images ?? [])
      })()
    }
  }

  /** 选图落位：>2MB 静默浏览器压缩（官方上传闸门 2M）+ 1:1 ≥800 软校验 */
  const acceptSources = async (
    intent: { mode: "add" } | { mode: "replace"; index: number },
    sources: string[],
  ) => {
    setBusy(true)
    try {
      const ok: string[] = []
      for (const src of sources) {
        const blob = await probeImageBlob(src)
        let use: string | null = src
        if (blob && blob.size > 2 * 1024 * 1024) {
          try {
            use = await compressToDataUrl(blob)
          } catch {
            toast.error("图片超过 2MB 且压缩失败，已跳过")
            continue
          }
        }
        if (use && !(await checkImageDims(use))) {
          toast.error("图片不满足 1:1 且 ≥800×800（官方 2000017），已跳过")
          continue
        }
        if (use) ok.push(use)
      }
      if (ok.length === 0) return
      if (intent.mode === "replace") {
        onChange(images.map((x, j) => (j === intent.index ? ok[0]! : x)))
      } else {
        onChange([...images, ...ok])
      }
    } finally {
      setBusy(false)
    }
  }

  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= images.length || to >= images.length) return
    const next = [...images]
    const [it] = next.splice(from, 1)
    next.splice(to, 0, it!)
    onChange(next)
  }

  const placeholders = Math.max(0, 5 - images.length)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {images.map((src, i) => {
          const badge = i === 0 ? "主图" : i === 1 ? "尺寸图" : `图 ${i + 1}`
          const badgeCls =
            i === 1
              ? "bg-sky-600 text-white"
              : i === 0
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
          return (
            <div
              key={src.slice(0, 120) + i}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragEnd={() => {
                setDragIdx(null)
                setOverIdx(null)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setOverIdx(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIdx != null) move(dragIdx, i)
                setDragIdx(null)
                setOverIdx(null)
              }}
              className={`group relative size-20 cursor-grab overflow-hidden rounded-md border active:cursor-grabbing ${
                overIdx === i && dragIdx != null && dragIdx !== i
                  ? "ring-2 ring-primary"
                  : dragIdx === i
                    ? "opacity-50"
                    : ""
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={toImageSrc(src, { width: 160 })} alt={`轮播 ${i + 1}`} className="size-full object-cover" />
              <span className={`absolute bottom-0 left-0 px-1 text-[10px] ${badgeCls}`}>{badge}</span>
              <div className="absolute inset-0 hidden items-center justify-center gap-2 bg-black/50 group-hover:flex">
                <button
                  type="button"
                  title="替换（图库选图）"
                  className="rounded p-1 text-white hover:bg-white/20"
                  onClick={() => openPicker({ mode: "replace", index: i })}
                >
                  <RefreshCw className="size-4" />
                </button>
                <button
                  type="button"
                  title="删除（后续图片前移）"
                  className="rounded p-1 text-white hover:bg-white/20"
                  onClick={() => onChange(images.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          )
        })}
        <Button
          type="button"
          variant="outline"
          className="size-20 flex-col gap-1"
          disabled={busy || images.length >= 20}
          onClick={() => openPicker({ mode: "add" })}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          <span className="text-[10px]">{busy ? "处理中" : "添加"}</span>
        </Button>
        {Array.from({ length: placeholders }, (_, k) => (
          <div
            key={`ph-${k}`}
            className="flex size-20 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground"
          >
            待补图
          </div>
        ))}
      </div>

      <ImageLibraryDialog
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        assets={assets}
        onUploaded={(img) => setAssets((prev) => [img, ...prev])}
        onSelect={(url) => {
          const intent = picker
          setPicker(null)
          if (intent) void acceptSources(intent, [url])
        }}
        {...(picker?.mode === "add"
          ? {
              multiple: true,
              // 模板 20 素材 + 尺寸图可达 21 张，钳到 0 避免负数上限（0 时「添加」按钮已禁用）
              maxSelect: Math.max(0, 20 - images.length),
              onSelectMany: (picked: MockupLibraryImage[]) => {
                const intent = picker
                setPicker(null)
                if (intent) void acceptSources(intent, picked.map((p) => p.imageUrl))
              },
            }
          : {})}
      />
    </div>
  )
}
