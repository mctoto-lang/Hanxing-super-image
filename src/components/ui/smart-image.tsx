"use client"

import * as React from "react"
import { ImageIcon } from "lucide-react"
import { cn, stripCosThumbnail } from "@/lib/utils"

interface SmartImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string
  /** 占位文案，默认「图片已过期」 */
  fallbackText?: string
  /** React 19：ref 作为常规 prop 接收并透传给内部 <img>（水合时序补偿检查用） */
  ref?: React.Ref<HTMLImageElement>
}

/**
 * 带失效占位的图片组件。
 *
 * COS 对象被生命周期规则删除（或网络异常）后，<img> 触发 onError，
 * 渲染「图片已过期」占位，提示用户图片已过期或无法查看。
 *
 * 自愈降级：src 带 COS 缩略参数（imageMogr2）加载失败时（如桶未开通
 * 数据万象），先重试去掉参数的原图，仍失败才显示占位。
 */
export function SmartImage({
  src,
  alt = "",
  className,
  fallbackText = "图片已过期",
  ...rest
}: SmartImageProps) {
  const [errored, setErrored] = React.useState(false)
  const [retrySrc, setRetrySrc] = React.useState<string | null>(null)

  // src 变化时重置错误状态（避免复用组件时残留占位）
  React.useEffect(() => {
    setErrored(false)
    setRetrySrc(null)
  }, [src])

  if (errored || !src) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-0.5 overflow-hidden bg-muted text-muted-foreground",
          className,
        )}
        title={src ? fallbackText : "暂无图片"}
      >
        <ImageIcon className="size-4 shrink-0 opacity-50" />
        <span className="px-1 text-center text-[10px] leading-tight">
          {src ? fallbackText : "暂无图片"}
        </span>
      </div>
    )
  }

  const effectiveSrc = retrySrc ?? src

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={effectiveSrc}
      alt={alt}
      onError={() => {
        if (!retrySrc && effectiveSrc.includes("imageMogr2")) {
          setRetrySrc(stripCosThumbnail(effectiveSrc))
        } else {
          setErrored(true)
        }
      }}
      className={className}
      {...rest}
    />
  )
}
