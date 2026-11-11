"use client"

import * as React from "react"
import { ImageIcon } from "lucide-react"
import { cn, stripCosThumbnail } from "@/lib/utils"

interface SmartImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string
  /** 占位文案，默认「图片已过期」 */
  fallbackText?: string
  /**
   * 失效占位框的宽高比（宽÷高），默认 1（方形）。
   *
   * 调用方应传入持久化的真实尺寸比例（generation_task.result_image_sizes，
   * worker 转存时探测落库）；未覆盖的场景（参考图/无记录）回退方形。
   * 宽度确定、高度自适应的场景由该比例撑出占位框，避免塌成细条；
   * 固定尺寸容器（size-full/h-full）场景高度已被约束，该比例不生效、
   * 行为不变。
   */
  fallbackAspectRatio?: number
  /** 进入失效占位态（图片为空或重试后仍失败）时回调，供外层撤掉加载骨架 */
  onFallback?: () => void
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
  fallbackAspectRatio = 1,
  onFallback,
  style,
  ...rest
}: SmartImageProps) {
  const [errored, setErrored] = React.useState(false)
  const [retrySrc, setRetrySrc] = React.useState<string | null>(null)

  // src 变化时重置错误状态（避免复用组件时残留占位）
  React.useEffect(() => {
    setErrored(false)
    setRetrySrc(null)
  }, [src])

  React.useEffect(() => {
    if (errored || !src) onFallback?.()
  }, [errored, src, onFallback])

  if (errored || !src) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-0.5 overflow-hidden bg-muted text-muted-foreground",
          className,
        )}
        // 调用方 style 在后展开可覆盖默认比例；宽度确定、高度自适应的
        // 场景由此撑出占位框，固定尺寸容器不受影响（见 props 注释）
        style={{ aspectRatio: fallbackAspectRatio, ...style }}
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
      loading="lazy"
      decoding="async"
      onError={() => {
        if (!retrySrc && effectiveSrc.includes("imageMogr2")) {
          setRetrySrc(stripCosThumbnail(effectiveSrc))
        } else {
          setErrored(true)
        }
      }}
      className={className}
      style={style}
      {...rest}
    />
  )
}
