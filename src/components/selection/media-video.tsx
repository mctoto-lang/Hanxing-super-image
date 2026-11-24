"use client"

import * as React from "react"
import { ExternalLink, Play } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { SmartImage } from "@/components/ui/smart-image"
import type { VideoSource } from "@/lib/selection/extras"
import { cn } from "@/lib/utils"

/**
 * 社媒 / 商品视频播放器（详情弹窗内）
 *
 *   direct = <video> 直链播放（X / Instagram / Pinterest / TEMU / Facebook 的 CDN 地址，
 *            带签名会过期，加载失败自动退回封面）
 *   embed  = 官方嵌入播放器（TikTok 不提供直链、Reddit 的 YouTube 链接）——
 *            点击「加载播放器」后才向第三方站点发请求
 *   none   = 不渲染
 * 应用层无 CSP 限制，媒体一律浏览器直连，服务端不抓取。
 */
export function MediaVideo({
  source,
  sourceUrl,
  className,
  active = true,
}: {
  source: VideoSource
  /** 来源平台链接（无法播放时的兜底跳转） */
  sourceUrl?: string | null
  className?: string
  /** false 时暂停直链播放、卸载嵌入播放器（组件保持挂载，切回不重载直链） */
  active?: boolean
}) {
  const [failed, setFailed] = React.useState(false)
  const [embedReady, setEmbedReady] = React.useState(false)
  const [embedLoading, setEmbedLoading] = React.useState(false)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)

  React.useEffect(() => {
    setFailed(false)
    setEmbedReady(false)
    setEmbedLoading(false)
  }, [source.src])

  // 切走（隐藏）时停声：直链暂停保留进度，嵌入播放器卸载（切回需重新点击加载）
  React.useEffect(() => {
    if (active) return
    videoRef.current?.pause()
    setEmbedReady(false)
  }, [active])

  if (source.kind === "none" || !source.src) return null

  const providerName =
    source.provider === "tiktok" ? "TikTok" : source.provider === "youtube" ? "YouTube" : ""

  if (source.kind === "embed" && embedReady) {
    return (
      <div className={cn("relative w-full overflow-hidden rounded-lg bg-black", className)}>
        <iframe
          src={source.src}
          title="视频播放器"
          className="absolute inset-0 h-full w-full border-0"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    )
  }

  // 未加载的嵌入播放器 / 已失效的直链：封面 + 说明 + 操作
  if (source.kind === "embed" || failed) {
    return (
      <div className={cn("relative flex w-full items-center justify-center overflow-hidden rounded-lg bg-muted", className)}>
        {source.poster ? (
          <SmartImage
            src={source.poster}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-60"
          />
        ) : null}
        <div className="relative flex max-w-[85%] flex-col items-center gap-2 p-4 text-center">
          {failed ? (
            <>
              <p className="text-xs font-medium text-white drop-shadow">视频地址已失效</p>
              <p className="text-[11px] leading-relaxed text-white/85 drop-shadow">
                平台的视频地址带时效签名，这条数据抓取时间较久，地址已过期。重新抓取后可播放。
              </p>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-white drop-shadow">
              该视频需加载 {providerName} 官方播放器，点击后将向 {providerName} 发起请求。
            </p>
          )}
          <div className="flex items-center gap-2">
            {!failed ? (
              <button
                type="button"
                disabled={embedLoading}
                onClick={() => {
                  setEmbedLoading(true)
                  // 先显示加载态，下一帧再挂 iframe
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      setEmbedLoading(false)
                      setEmbedReady(true)
                    })
                  })
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                {embedLoading ? <DashRing className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
                加载播放器
              </button>
            ) : null}
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-md bg-black/60 px-3 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/80"
              >
                <ExternalLink className="size-3.5" />
                在来源平台查看
              </a>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex w-full items-center justify-center overflow-hidden rounded-lg bg-black", className)}>
      <video
        ref={videoRef}
        key={source.src}
        src={source.src}
        poster={source.poster ?? undefined}
        controls
        preload="metadata"
        playsInline
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      >
        您的浏览器不支持视频播放。
      </video>
    </div>
  )
}
