"use client"

import * as React from "react"
import { Download, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { ImageCompareSlider } from "@/components/ui/image-compare-slider"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupAiImageView } from "@/lib/mockup/types"
import { cn, toImageSrc } from "@/lib/utils"

/** 底部缩略条的一个比对项（AI图 / 套样机效果图，均与左侧基准图对比） */
interface CompareEntry {
  key: string
  /** 比对图（滑块右侧） */
  imageUrl: string
  label: string
  /** 左侧基准图（纯样机套版渲染，缺省回退提交时快照） */
  baselineUrl: string
  prompt: string
  createdAt: string
}

/**
 * 样机 AI 结果对比弹窗（全屏，样式同图片放大组件）
 *
 * 中间：左右对比滑块（左 = 纯样机套版渲染基准图 baselineUrl，始终不含
 * AI 结果；右 = 选中的比对图）；底部：比对图缩略条 —— AI背景 / AI渲染
 * 结果各一项，已落地的 AI背景追加「套样机效果」（落地重渲染图）；
 * 右上角圆形关闭按钮（同 ImageViewer），其左侧为当前比对图下载入口。
 */
export function ImageCompareDialog({
  open,
  onOpenChange,
  images,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  images: MockupAiImageView[]
  title: string
}) {
  const [index, setIndex] = React.useState(0)

  React.useEffect(() => {
    if (open) {
      setIndex(0)
    }
  }, [open])

  // 平铺比对项：每张 AI 图一项；已落地的 AI背景追加「套样机效果」一项
  const entries = React.useMemo<CompareEntry[]>(
    () =>
      images.flatMap((img) => {
        const baselineUrl = img.baselineUrl ?? img.refImageUrl
        return [
          {
            key: img.taskId,
            imageUrl: img.imageUrl,
            label: img.aiKind === "background" ? "AI背景" : "AI渲染",
            baselineUrl,
            prompt: img.prompt,
            createdAt: img.createdAt,
          },
          ...(img.appliedImageUrl
            ? [
                {
                  key: `${img.taskId}:applied`,
                  imageUrl: img.appliedImageUrl,
                  label: "套样机效果",
                  baselineUrl,
                  prompt: img.prompt,
                  createdAt: img.createdAt,
                },
              ]
            : []),
        ]
      }),
    [images],
  )

  if (entries.length === 0) return null
  const safeIndex = Math.min(index, entries.length - 1)
  const current = entries[safeIndex]!

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        className="inset-0 flex h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-none bg-neutral-500/40 p-0 ring-0 duration-200 sm:max-w-none"
      >
        <DialogTitle className="sr-only">查看对比 · {title}</DialogTitle>
        <DialogDescription className="sr-only">
          左侧为样机套版渲染原图，右侧为选中的比对图，拖动分割线对比，点击底部缩略图切换
        </DialogDescription>

        {/* 对比舞台：填满剩余高度 */}
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-2 pt-6">
          <ImageCompareSlider
            before={toImageSrc(current.baselineUrl)}
            after={toImageSrc(current.imageUrl)}
            beforeLabel="渲染原图"
            afterLabel={current.label}
            className="h-full max-w-full"
          />
        </div>

        {/* 提示词（最多 2 行） */}
        {current.prompt ? (
          <div className="mx-auto w-full max-w-3xl px-6 pb-2">
            <p
              className="line-clamp-2 text-xs leading-5 text-white/70"
              title={current.prompt}
            >
              提示词：{current.prompt}
            </p>
          </div>
        ) : null}

        {/* 底部比对图缩略图条：点击切换比对对象 */}
        <div className="flex items-center justify-center gap-2 px-6 pb-5 pt-1">
          <div className="flex max-w-full items-center gap-2 overflow-x-auto">
            {entries.map((entry, i) => (
              <button
                key={entry.key}
                type="button"
                title={`${entry.label} · ${new Date(entry.createdAt).toLocaleString("zh-CN")}`}
                onClick={() => setIndex(i)}
                className={cn(
                  "size-14 shrink-0 overflow-hidden rounded-md border-2 transition",
                  i === safeIndex
                    ? "border-white opacity-100"
                    : "border-transparent opacity-60 hover:opacity-90",
                )}
              >
                <SmartImage
                  src={toImageSrc(entry.imageUrl, { width: 96 })}
                  alt={`${entry.label} ${i + 1}`}
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>

        {/* 右上角：下载当前比对图 + 关闭（同图片放大组件样式） */}
        <div className="absolute right-4 top-4 z-10 flex gap-2">
          <a
            href={toImageSrc(current.imageUrl)}
            target="_blank"
            rel="noreferrer"
            download
            aria-label="下载比对图"
            title="下载比对图"
            className="flex size-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
          >
            <Download className="size-5" />
          </a>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭"
            className="flex size-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
          >
            <X className="size-5" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
