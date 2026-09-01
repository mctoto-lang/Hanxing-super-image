"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ImagePlus, Pipette, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * 图片取色：上传一张图片后在图上点选像素。
 *
 * 图片仅本地 object URL 读取（不走服务器上传）；取色交互沿用屏幕取色的
 * 成熟实现：object-contain 内容区坐标换算（letterbox 修正）+ 1×1 画布
 * 取样 + 跟随光标的放大镜（准星框、贴边翻转）。
 *
 * 弹窗内容按视口高度预扣标题/说明/内边距，永不溢出（DialogContent
 * 叠加 overflow-hidden，杜绝滚轮/触控滑动出滚动条）；放大镜通过
 * portal 渲染到 body —— DialogContent 带 translate 变换（居中定位），
 * 变换元素是 fixed 后代的包含块，直接放弹窗内坐标会偏移且被裁剪。
 */

/** 上传大小上限 */
const MAX_FILE_MB = 20

/** 图片元素内 object-contain 的内容区（letterbox 修正）：显示坐标 → 图片像素坐标 */
function toImagePixel(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!iw || !ih) return null
  const rect = img.getBoundingClientRect()
  const scale = Math.min(rect.width / iw, rect.height / ih)
  const contentW = iw * scale
  const contentH = ih * scale
  const offsetX = rect.left + (rect.width - contentW) / 2
  const offsetY = rect.top + (rect.height - contentH) / 2
  const x = Math.floor((clientX - offsetX) / scale)
  const y = Math.floor((clientY - offsetY) / scale)
  if (x < 0 || y < 0 || x >= iw || y >= ih) return null
  return { x, y }
}

function pixelToHex(r: number, g: number, b: number): string {
  const to2 = (n: number) => n.toString(16).padStart(2, "0")
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase()
}

/** 取图片单像素 → HEX（复用 1x1 画布） */
function onePixelCanvas(
  img: HTMLImageElement,
  p: { x: number; y: number },
): string | null {
  const one = document.createElement("canvas")
  one.width = 1
  one.height = 1
  const ctx = one.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, p.x, p.y, 1, 1, 0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return pixelToHex(d[0]!, d[1]!, d[2]!)
}

/** 放大镜采样半径（每边像素数）与放大倍数 */
const ZOOM_RADIUS = 5
const ZOOM_SCALE = 8

export function ImageEyedropperButton({
  onPick,
}: {
  onPick: (hex: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [hoverHex, setHoverHex] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const magnifierRef = useRef<HTMLCanvasElement>(null)
  const objectUrlRef = useRef<string | null>(null)

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  // 卸载兜底释放 object URL
  useEffect(() => () => revokeObjectUrl(), [revokeObjectUrl])

  const hideMagnifier = useCallback(() => {
    const canvas = magnifierRef.current
    if (canvas) canvas.style.visibility = "hidden"
  }, [])

  /** 回到上传区（丢弃当前图片） */
  const resetImage = useCallback(() => {
    revokeObjectUrl()
    setImgUrl(null)
    setHoverHex(null)
    hideMagnifier()
  }, [revokeObjectUrl, hideMagnifier])

  const closeDialog = useCallback(() => {
    setOpen(false)
    resetImage()
  }, [resetImage])

  /** 载入本地图片文件（类型/大小校验 → object URL） */
  const loadFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return
      if (!file.type.startsWith("image/")) {
        toast.error("请选择图片文件（PNG / JPEG / WebP）")
        return
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        toast.error(`图片过大，请选择 ${MAX_FILE_MB}MB 以内的图片`)
        return
      }
      revokeObjectUrl()
      const url = URL.createObjectURL(file)
      objectUrlRef.current = url
      setImgUrl(url)
      setHoverHex(null)
      hideMagnifier()
    },
    [revokeObjectUrl, hideMagnifier],
  )

  /** 悬浮：放大镜重绘（跟随光标）+ 中心像素 HEX */
  const handleMove = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current
    const canvas = magnifierRef.current
    if (!img || !canvas) return
    const p = toImagePixel(img, e.clientX, e.clientY)
    if (!p) {
      setHoverHex(null)
      canvas.style.visibility = "hidden"
      return
    }
    canvas.style.visibility = "visible"
    // 跟随光标（右上方，贴边翻转到左/下）
    const size = (ZOOM_RADIUS * 2 + 1) * ZOOM_SCALE
    let left = e.clientX + 16
    let top = e.clientY - size - 16
    if (left + size > window.innerWidth) left = e.clientX - size - 16
    if (top < 0) top = e.clientY + 16
    canvas.style.left = `${left}px`
    canvas.style.top = `${top}px`

    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(
      img,
      p.x - ZOOM_RADIUS,
      p.y - ZOOM_RADIUS,
      ZOOM_RADIUS * 2 + 1,
      ZOOM_RADIUS * 2 + 1,
      0,
      0,
      size,
      size,
    )
    // 中心 1px 取色 + 准星框
    const one = onePixelCanvas(img, p)
    if (one) setHoverHex(one)
    ctx.strokeStyle = "rgba(255,255,255,0.9)"
    ctx.lineWidth = 2
    ctx.strokeRect(
      ZOOM_RADIUS * ZOOM_SCALE,
      ZOOM_RADIUS * ZOOM_SCALE,
      ZOOM_SCALE,
      ZOOM_SCALE,
    )
  }

  /** 点击：采样像素回填并关闭 */
  const handlePick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current
    if (!img) return
    const p = toImagePixel(img, e.clientX, e.clientY)
    if (!p) return
    const hex = onePixelCanvas(img, p)
    if (!hex) return
    onPick(hex)
    toast.success(`已吸取颜色 ${hex}`)
    closeDialog()
  }

  const magnifierSize = (ZOOM_RADIUS * 2 + 1) * ZOOM_SCALE

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1 px-2 text-xs"
        onClick={() => setOpen(true)}
        title="上传图片后在图上取色"
      >
        <Pipette className="size-3.5" />
        图片取色
      </Button>

      <Dialog open={open} onOpenChange={(v) => !v && closeDialog()}>
        <DialogContent
          className="max-w-5xl gap-2 overflow-hidden bg-black/95 p-3 sm:rounded-xl"
          showCloseButton
        >
          <DialogTitle className="flex items-center gap-2 text-white">
            图片取色
            {hoverHex && (
              <span className="font-mono text-sm font-normal text-white/70">
                {hoverHex}
              </span>
            )}
            {imgUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mr-10 ml-auto h-7 gap-1 border-white/20 bg-transparent px-2 text-xs text-white/80 hover:bg-white/10 hover:text-white"
                onClick={resetImage}
              >
                <RefreshCw className="size-3" />
                重新上传
              </Button>
            )}
          </DialogTitle>
          <DialogDescription className="text-white/60">
            {imgUrl
              ? "在图片上移动准星预览，点击吸取颜色（Esc 取消）"
              : "上传一张图片，在图上吸取想要的颜色（图片仅在本地读取，不会上传）"}
          </DialogDescription>

          {imgUrl ? (
            <div className="flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={imgUrl}
                alt="取色图片"
                onMouseMove={handleMove}
                onMouseLeave={hideMagnifier}
                onClick={handlePick}
                className="max-h-[calc(100svh-9rem)] w-full cursor-crosshair rounded-md object-contain"
              />
            </div>
          ) : (
            <label
              className={cn(
                "flex min-h-[280px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-white/60 transition-colors",
                dragOver
                  ? "border-white/70 bg-white/5 text-white"
                  : "border-white/25 hover:border-white/60 hover:text-white/90",
              )}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                loadFile(e.dataTransfer.files?.[0])
              }}
            >
              <ImagePlus className="size-8" />
              <span className="text-sm">点击或拖拽图片到这里</span>
              <span className="text-xs text-white/40">
                支持 PNG / JPEG / WebP，单张 ≤ {MAX_FILE_MB}MB
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  loadFile(e.target.files?.[0])
                  // 允许再次选择同一文件时重新触发 onChange
                  e.target.value = ""
                }}
              />
            </label>
          )}
        </DialogContent>
      </Dialog>

      {/* 放大镜（portal 到 body：弹窗 translate 变换是 fixed 的包含块，
          放弹窗内会坐标偏移且被裁剪；命令式跟随光标，贴边翻转） */}
      {open &&
        createPortal(
          <canvas
            ref={magnifierRef}
            width={magnifierSize}
            height={magnifierSize}
            className="pointer-events-none invisible fixed z-50 rounded-md border-2 border-white/80 shadow-xl"
            style={{
              width: magnifierSize,
              height: magnifierSize,
              imageRendering: "pixelated",
            }}
          />,
          document.body,
        )}
    </>
  )
}
