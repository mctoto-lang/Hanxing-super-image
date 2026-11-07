"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ImageViewer } from "@/components/ui/image-viewer"

/**
 * 表格缩略图 + 点击放大（复用全屏 ImageViewer，单图模式无翻页箭头）
 *
 * 点击 stopPropagation：不打断宿主行的 onRowClick（如库存总览点击行开
 * 详情抽屉）。img 类名由调用方透传，与原裸 <img> 的尺寸/圆角口径一致。
 * 键盘可达：Enter/Space 等价点击（Space preventDefault 防页面滚动），
 * 可访问名取 alt、未传时兜底"放大查看图片"。
 */
interface ZoomableImageProps {
  src: string
  alt?: string
  /** 透传给 <img> 的类名（尺寸/圆角/裁剪/shrink-0 等） */
  className?: string
  loading?: "lazy" | "eager"
}

export function ZoomableImage({ src, alt = "", className, loading = "lazy" }: ZoomableImageProps) {
  const [open, setOpen] = React.useState(false)
  // 惰性挂载：首次打开才渲染 ImageViewer。闭合态 DOM 虽为 0，但常驻子树
  // 仍占组件调用与元素分配——无限滚动主表（如商品列表）每行一张缩略图，
  // 行数无上限且行未 memo，任何状态变化都会全量重建闭合弹层的元素树。
  // 打开后保持挂载：DialogPortal 的 data-closed 退场动画依赖组件存活到
  // 动画结束，不能随 open 一起卸载。
  const [mounted, setMounted] = React.useState(false)
  const openViewer = () => {
    setMounted(true)
    setOpen(true)
  }
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading={loading}
        role="button"
        tabIndex={0}
        aria-label={alt || "放大查看图片"}
        onClick={(e) => {
          e.stopPropagation()
          openViewer()
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            e.stopPropagation()
            openViewer()
          }
        }}
        className={cn("cursor-zoom-in", className)}
      />
      {mounted && <ImageViewer open={open} onOpenChange={setOpen} images={[src]} index={0} />}
    </>
  )
}
