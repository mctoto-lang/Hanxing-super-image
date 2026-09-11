"use client"

import { FileType2 } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * PSD 源文件占位（浏览器无法渲染 PSD，图片位置以此代替）。
 * 仅负责视觉占位；容器尺寸与点击交互（如点击下载）由调用方包裹。
 */
export function PsdPlaceholder({
  label = "PSD 源文件",
  iconClassName = "size-8",
  className,
}: {
  label?: string
  iconClassName?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground",
        className,
      )}
    >
      <FileType2 className={iconClassName} strokeWidth={1.5} />
      <span className="max-w-full truncate px-1 text-[10px] font-medium">{label}</span>
    </div>
  )
}
