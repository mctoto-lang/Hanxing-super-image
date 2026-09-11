"use client"

import * as React from "react"
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  RotateCcw,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SmartImage } from "@/components/ui/smart-image"
import { getStorageProxyUrl } from "@/lib/storage/proxy"
import { copyText, toImageSrc } from "@/lib/utils"

/** 缩放范围与步进（0.25 步进在二进制下精确，无浮点漂移） */
const MIN_SCALE = 0.5
const MAX_SCALE = 8
const SCALE_STEP = 0.25
/** 双击放大到的倍数 */
const DBLCLICK_SCALE = 2.5

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** 循环序号（-1 → 末张，n → 首张） */
function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n
}

/** 生成时间：2026-08-20 14:30 */
function formatViewerTime(date: Date | string): string {
  const d = new Date(date)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 下载原图：走 /api/image/proxy（防 SSRF；同源代理使 a.download 属性生效） */
export function downloadImageFile(url: string, name: string) {
  const a = document.createElement("a")
  a.href = getStorageProxyUrl(url)
  a.download = `${name}.png`
  a.target = "_blank"
  a.click()
}

/** 感叹号悬浮面板展示的元信息 */
export interface ImageViewerInfo {
  model?: string
  prompt?: string
  createdAt?: Date | string
  /** 生成耗时（毫秒）；null/缺省不显示该行（上传图/参考图等无生成概念） */
  durationMs?: number | null
}

export interface ImageViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 原始图片 URL 数组（内部经 toImageSrc 渲染） */
  images: string[]
  index: number
  onIndexChange?: (index: number) => void
  info?: ImageViewerInfo
}

/**
 * 视图变换。transform 链为 translate(x,y) rotate(r) scale(s)——
 * translate 在最外层（屏幕坐标系），旋转后拖拽方向仍符合直觉
 */
interface Transform {
  scale: number
  rotation: number
  x: number
  y: number
}

const INITIAL_TF: Transform = { scale: 1, rotation: 0, x: 0, y: 0 }

/**
 * 以容器中心坐标系内 (px, py) 为锚点缩放：锚点下的图片内容缩放前后
 * 保持不动（推导中旋转矩阵相消，与 rotation 无关）
 */
function zoomAtAnchor(
  prev: Transform,
  nextScale: number,
  px = 0,
  py = 0,
): Transform {
  const k = nextScale / prev.scale
  return {
    ...prev,
    scale: nextScale,
    x: px * (1 - k) + prev.x * k,
    y: py * (1 - k) + prev.y * k,
  }
}

/** 底部工具栏圆形图标按钮 */
const TOOL_BTN =
  "flex size-9 shrink-0 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/15 hover:text-white disabled:pointer-events-none disabled:opacity-40"

/**
 * 全屏图片放大查看器（公共组件，多页面可复用）
 *
 * - 底部工具栏：向左/右旋转 90°、缩小/放大（含百分比指示）、下载、
 *   感叹号悬浮信息面板（模型 / 实际像素 / 提示词 + 复制 /
 *   生成时间 / 生成耗时）
 * - 交互：按住图片自由拖动、滚轮以光标为中心缩放、双击切换 100%/放大、
 *   多图左右箭头与 ←/→ 键循环切换、Esc/遮罩/右上角 X 关闭
 */
export function ImageViewer({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  info,
}: ImageViewerProps) {
  const safeIndex = images.length
    ? Math.min(Math.max(index, 0), images.length - 1)
    : 0
  const current = images[safeIndex]

  const [tf, setTf] = React.useState<Transform>(INITIAL_TF)
  const [dragging, setDragging] = React.useState(false)
  const [naturalSize, setNaturalSize] = React.useState<{
    w: number
    h: number
  } | null>(null)
  const [infoHover, setInfoHover] = React.useState(false)
  // 信息面板延时关闭：面板居中于工具栏后，与感叹号图标之间隔着工具栏
  // 内边距，立即关闭会让鼠标在图标→面板途中断 hover；150ms 内移入面板即取消
  const infoCloseTimer = React.useRef<number | null>(null)

  // 舞台元素用「回调 ref + state」而非 useRef：base-ui 的 Portal 在 open
  // 变化后的下一个 effect 周期才挂载弹层内容，useRef 在 effect 执行时恒为
  // null（滚轮监听曾因此静默未挂载）。回调 ref 在节点真正挂载时触发重渲染，
  // 使依赖它的 effect 可靠重跑
  const [stageEl, setStageEl] = React.useState<HTMLDivElement | null>(null)
  const dragRef = React.useRef<{
    startX: number
    startY: number
    x: number
    y: number
  } | null>(null)

  // 打开或切换图片时重置视图状态
  React.useEffect(() => {
    if (open) {
      setTf(INITIAL_TF)
      setNaturalSize(null)
      setInfoHover(false)
    }
  }, [open, safeIndex])

  // 滚轮缩放需 preventDefault，而 React 合成 wheel 事件为 passive，
  // 故用原生 addEventListener({ passive: false }) 挂载（依赖 stageEl，
  // 舞台实际挂载后才绑定）
  React.useEffect(() => {
    if (!open || !stageEl) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = stageEl.getBoundingClientRect()
      const px = e.clientX - rect.left - rect.width / 2
      const py = e.clientY - rect.top - rect.height / 2
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      setTf((prev) => zoomAtAnchor(prev, clampScale(prev.scale * factor), px, py))
    }
    stageEl.addEventListener("wheel", onWheel, { passive: false })
    return () => stageEl.removeEventListener("wheel", onWheel)
  }, [open, stageEl])

  // 键盘 ←/→ 循环切换（Esc 关闭由 base-ui Dialog 自带处理）
  React.useEffect(() => {
    if (!open || images.length <= 1) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        onIndexChange?.(wrapIndex(safeIndex - 1, images.length))
      } else if (e.key === "ArrowRight") {
        onIndexChange?.(wrapIndex(safeIndex + 1, images.length))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, safeIndex, images.length, onIndexChange])

  /** 工具栏按钮缩放（以图片中心为锚点） */
  function zoomBy(dir: 1 | -1) {
    setTf((prev) => zoomAtAnchor(prev, clampScale(prev.scale + dir * SCALE_STEP)))
  }

  /** 双击：>100% 时复位到 100%，否则放大到固定倍数（锚点为双击位置） */
  function handleDoubleClick(e: React.MouseEvent) {
    const rect = stageEl?.getBoundingClientRect()
    const px = rect ? e.clientX - rect.left - rect.width / 2 : 0
    const py = rect ? e.clientY - rect.top - rect.height / 2 : 0
    setTf((prev) =>
      prev.scale > 1.01
        ? { ...prev, scale: 1, x: 0, y: 0 }
        : zoomAtAnchor(prev, DBLCLICK_SCALE, px, py),
    )
  }

  function handlePointerDown(e: React.PointerEvent<HTMLImageElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, x: tf.x, y: tf.y }
    setDragging(true)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLImageElement>) {
    const start = dragRef.current
    if (!start) return
    setTf((prev) => ({
      ...prev,
      x: start.x + e.clientX - start.startX,
      y: start.y + e.clientY - start.startY,
    }))
  }

  function handlePointerEnd() {
    dragRef.current = null
    setDragging(false)
  }

  /** 打开信息面板（取消待执行的延时关闭） */
  function openInfoPanel() {
    if (infoCloseTimer.current !== null) {
      window.clearTimeout(infoCloseTimer.current)
      infoCloseTimer.current = null
    }
    setInfoHover(true)
  }

  /** 延时关闭信息面板（150ms 内再次 enter 可取消） */
  function scheduleInfoClose() {
    if (infoCloseTimer.current !== null) window.clearTimeout(infoCloseTimer.current)
    infoCloseTimer.current = window.setTimeout(() => {
      setInfoHover(false)
      infoCloseTimer.current = null
    }, 150)
  }

  /** 复制提示词（悬浮信息面板内） */
  async function handleCopyPrompt() {
    if (!info?.prompt) return
    const ok = await copyText(info.prompt)
    if (ok) {
      toast.success("已复制到剪贴板")
    } else {
      toast.error("复制失败，请手动选择复制")
    }
  }

  // 记录当前图实际像素；缓存命中的 <img> 挂载即 complete、onLoad 不再
  // 触发，ref 回调补偿一次（与任务卡片 imgSizes 的补偿同一模式）
  const recordNatural = (el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) {
      setNaturalSize(
        (prev) => prev ?? { w: el.naturalWidth, h: el.naturalHeight },
      )
    }
  }

  if (!current) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        className="inset-0 flex h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-none bg-neutral-500/40 p-0 ring-0 duration-200 sm:max-w-none"
      >
        <DialogTitle className="sr-only">图片预览</DialogTitle>
        <DialogDescription className="sr-only">
          使用底部工具栏旋转、缩放、下载图片或查看详细信息
        </DialogDescription>

        <TooltipProvider>

        {/* 图片舞台：滚轮缩放锚点与拖拽均在坐标系内计算；
            磨砂遮罩为弹层自身背景，点击图片外空白区域关闭（点到图片不关闭） */}
        <div
          ref={setStageEl}
          className="absolute inset-0 flex items-center justify-center overflow-hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) onOpenChange(false)
          }}
        >
          <SmartImage
            ref={recordNatural}
            src={toImageSrc(current)}
            alt={`生成图 ${safeIndex + 1}`}
            className={`max-h-[calc(100dvh-9rem)] max-w-[calc(100vw-9rem)] cursor-grab select-none object-contain ${dragging ? "cursor-grabbing" : ""}`}
            style={{
              transform: `translate(${tf.x}px, ${tf.y}px) rotate(${tf.rotation}deg) scale(${tf.scale})`,
              // 拖拽期间关闭过渡，跟随指针；其余操作（按钮/滚轮/双击）平滑过渡
              transition: dragging ? "none" : "transform 150ms ease-out",
              // 触屏拖动不被浏览器手势（滚动/缩放）接管
              touchAction: "none",
            }}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setNaturalSize({ w: el.naturalWidth, h: el.naturalHeight })
              }
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onDoubleClick={handleDoubleClick}
          />
        </div>

        {/* 左上角计数（多图时） */}
        {images.length > 1 && (
          <div className="absolute left-4 top-4 z-10 rounded-full bg-black/50 px-2.5 py-1 text-xs tabular-nums text-white/90 backdrop-blur">
            {safeIndex + 1} / {images.length}
          </div>
        )}

        {/* 关闭：右上角 X（Esc / 点击空白区域 / Tooltip 提示） */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="absolute right-4 top-4 z-10 flex size-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
              />
            }
          >
            <X className="size-5" />
            <span className="sr-only">关闭</span>
          </TooltipTrigger>
          <TooltipContent side="left">关闭</TooltipContent>
        </Tooltip>

        {/* 左右箭头：循环切换（仅多图时显示） */}
        {images.length > 1 && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="上一张"
                    onClick={() =>
                      onIndexChange?.(wrapIndex(safeIndex - 1, images.length))
                    }
                    className="absolute left-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
                  />
                }
              >
                <ChevronLeft className="size-5" />
              </TooltipTrigger>
              <TooltipContent side="right">上一张</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="下一张"
                    onClick={() =>
                      onIndexChange?.(wrapIndex(safeIndex + 1, images.length))
                    }
                    className="absolute right-4 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
                  />
                }
              >
                <ChevronRight className="size-5" />
              </TooltipTrigger>
              <TooltipContent side="left">下一张</TooltipContent>
            </Tooltip>
          </>
        )}

        {/* 底部工具栏：旋转 | 缩放 | 下载 + 详细信息 */}
        <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/60 px-2.5 py-1.5 text-white shadow-lg backdrop-blur">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="向左旋转 90°"
                    className={TOOL_BTN}
                    onClick={() =>
                      setTf((p) => ({ ...p, rotation: p.rotation - 90 }))
                    }
                  />
                }
              >
                <RotateCcw className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="top">向左旋转 90°</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="向右旋转 90°"
                    className={TOOL_BTN}
                    onClick={() =>
                      setTf((p) => ({ ...p, rotation: p.rotation + 90 }))
                    }
                  />
                }
              >
                <RotateCw className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="top">向右旋转 90°</TooltipContent>
            </Tooltip>
          <span className="mx-1 h-4 w-px shrink-0 bg-white/20" aria-hidden />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="缩小"
                  className={TOOL_BTN}
                  disabled={tf.scale <= MIN_SCALE + 1e-9}
                  onClick={() => zoomBy(-1)}
                />
              }
            >
              <ZoomOut className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="top">缩小</TooltipContent>
          </Tooltip>
          <span className="w-11 shrink-0 text-center text-xs tabular-nums text-white/80">
            {Math.round(tf.scale * 100)}%
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="放大"
                  className={TOOL_BTN}
                  disabled={tf.scale >= MAX_SCALE - 1e-9}
                  onClick={() => zoomBy(1)}
                />
              }
            >
              <ZoomIn className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="top">放大</TooltipContent>
          </Tooltip>
          <span className="mx-1 h-4 w-px shrink-0 bg-white/20" aria-hidden />
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="下载"
                  className={TOOL_BTN}
                  onClick={() =>
                    downloadImageFile(
                      current,
                      `hanxing-${Date.now()}-${safeIndex + 1}`,
                    )
                  }
                />
              }
            >
              <Download className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="top">下载</TooltipContent>
          </Tooltip>

          {/* 感叹号：悬浮显示信息面板（面板为其下方兄弟节点，居中于工具栏） */}
          <div
            onMouseEnter={openInfoPanel}
            onMouseLeave={scheduleInfoClose}
          >
            <button type="button" title="详细信息" className={TOOL_BTN}>
              <AlertCircle className="size-4" />
            </button>
          </div>

          {/* 信息面板：水平居中于工具栏。pb-2 为不可见桥接区，配合
              150ms 延时关闭，鼠标在图标与面板之间移动不断 hover，
              可稳定点击「复制提示词」 */}
          {infoHover && (
            <div
              className="absolute bottom-full left-1/2 -translate-x-1/2 pb-2"
              onMouseEnter={openInfoPanel}
              onMouseLeave={scheduleInfoClose}
            >
              <div className="w-80 rounded-lg border bg-popover/95 p-3 text-popover-foreground shadow-xl backdrop-blur">
                <div className="space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      生图模型
                    </span>
                    <span className="min-w-0 break-words">
                      {info?.model ?? "-"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      实际像素
                    </span>
                    <span>
                      {naturalSize
                        ? `${naturalSize.w} × ${naturalSize.h} px`
                        : "加载中…"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      生成时间
                    </span>
                    <span>
                      {info?.createdAt ? formatViewerTime(info.createdAt) : "-"}
                    </span>
                  </div>
                  {info?.durationMs != null && info.durationMs >= 0 && (
                    <div className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        生成耗时
                      </span>
                      <span>{(info.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                  )}
                </div>
                <div className="mt-2 border-t pt-2">
                  <span className="text-xs text-muted-foreground">提示词</span>
                  <div className="mt-1 max-h-40 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                      {info?.prompt || "-"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopyPrompt()}
                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-foreground/10 px-2 py-1 text-xs font-medium transition-colors hover:bg-foreground/20"
                  >
                    <Copy className="size-3" />
                    复制提示词
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        </TooltipProvider>
      </DialogContent>
    </Dialog>
  )
}
