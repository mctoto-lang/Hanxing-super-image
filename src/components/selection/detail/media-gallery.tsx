"use client"

import * as React from "react"
import { Play } from "lucide-react"
import { SmartImage } from "@/components/ui/smart-image"
import { MediaVideo } from "@/components/selection/media-video"
import { resolveVideo } from "@/lib/selection/extras"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { cn } from "@/lib/utils"

/**
 * 详情弹窗媒体区：视频（有则排首位）+ 图集。点缩略图在「视频 / 第 N 张图」间切换；
 * 视频保持挂载但隐藏，切走时暂停 / 卸载播放器避免继续出声，切回不重载直链。
 */
export function MediaGallery({
  item,
  className,
}: {
  item: SelectionPoolItem
  className?: string
}) {
  const video = resolveVideo(item.platform, item)
  const images = item.images ?? []
  const hasVideo = video.kind !== "none"
  const [mode, setMode] = React.useState<"video" | "image">(hasVideo ? "video" : "image")
  const [active, setActive] = React.useState(0)

  React.useEffect(() => {
    setMode(hasVideo ? "video" : "image")
    setActive(0)
  }, [item.id, hasVideo])

  const isSocial = ["instagram", "tiktok", "pinterest", "reddit", "x", "facebook"].includes(item.platform)
  const thumbs: Array<{ kind: "video" | "image"; src: string }> = [
    ...(hasVideo && (video.poster || video.kind === "embed")
      ? [{ kind: "video" as const, src: video.poster ?? "" }]
      : []),
    ...images.slice(0, 12).map((src) => ({ kind: "image" as const, src })),
  ]

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border bg-muted",
          isSocial ? "aspect-[4/5]" : "aspect-square",
        )}
      >
        {hasVideo ? (
          <div className={cn("absolute inset-0", mode !== "video" && "hidden")}>
            <MediaVideo
              source={video}
              sourceUrl={item.sourceUrl}
              active={mode === "video"}
              className={video.kind === "direct" ? "h-full w-full rounded-none" : "h-full w-full rounded-none"}
            />
          </div>
        ) : null}
        {mode === "image" ? (
          images[active] ? (
            <SmartImage src={images[active]} alt={item.title ?? ""} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-4">
              <p className="line-clamp-[9] text-xs leading-relaxed text-muted-foreground">
                {item.content ?? "无图"}
              </p>
            </div>
          )
        ) : null}
      </div>
      {thumbs.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {thumbs.map((t, i) => {
            const isActive = t.kind === "video" ? mode === "video" : mode === "image" && active === i - (hasVideo ? 1 : 0)
            return (
              <button
                key={t.src + i}
                type="button"
                aria-label={t.kind === "video" ? "播放视频" : `第 ${i - (hasVideo ? 1 : 0) + 1} 张图`}
                aria-pressed={isActive}
                className={cn(
                  "relative size-11 overflow-hidden rounded-md border bg-muted transition-colors",
                  isActive ? "border-primary ring-1 ring-primary" : "hover:border-primary/50",
                )}
                onClick={() => {
                  if (t.kind === "video") {
                    setMode("video")
                  } else {
                    setMode("image")
                    setActive(i - (hasVideo ? 1 : 0))
                  }
                }}
              >
                {t.src ? (
                  <SmartImage src={t.src} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-black/70 text-white">
                    <Play className="size-3.5 fill-current" />
                  </span>
                )}
                {t.kind === "video" ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                    <Play className="size-3.5 fill-current" />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
