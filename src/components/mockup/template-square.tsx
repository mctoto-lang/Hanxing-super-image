"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useTheme } from "next-themes"
import {
  AlertTriangle,
  Ban,
  Image as ImageIcon,
  RotateCcw,
  Sparkle,
  X,
} from "lucide-react"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { ImageGeneration } from "@/components/ui/image-generation"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupSquareTaskView } from "@/lib/mockup/types"
import { cn, toImageSrc } from "@/lib/utils"

/** 悬停预览宽（w-60）与安全边距 */
const PREVIEW_WIDTH = 240
const PREVIEW_GAP = 8
/** 预览最大高度（max-h-72 + 余量），用于判断上下翻转 */
const PREVIEW_MAX_HEIGHT = 304

interface TemplateSquareProps {
  displayName: string
  /** 该小模板最新批次任务（null = 未渲染过） */
  task: MockupSquareTaskView | null
  /** 轮询实时覆盖（含最新 stage/progress） */
  live?: MockupSquareTaskView | null
  /** 存在 AI 生成结果（AI背景/AI渲染）→ 流光边框（批量生图卡片同款） */
  hasAi?: boolean
  /** 该方块有进行中的 AI 生图任务 → 纯加载动画（无任何文字/进度） */
  aiGenerating?: boolean
  /** 点击方块（父级打开操作菜单），携带方块视口矩形供菜单定位 */
  onOpen: (rect: DOMRect) => void
  onCancel?: () => void
  onRetry?: () => void
  cancelling?: boolean
}

/**
 * 小模板方块（卡片中部的正方形缩略图）
 *
 * 六态：占位（未渲染）/ 排队 / 渲染中（ig- 纯动画，无任何文字/进度）/
 * AI 生图中（ig- 纯动画，无文字）/ 完成（悬停浮出完整大图；有 AI 结果时
 * 右上角 AI 星标 + 外圈流光边框闪烁，即批量生图卡片生成态同款
 * BeamWrapper；渲染 busy 态两者均不显示）/ 失败
 * （原因 + 已退款 + 重试）。
 * 点击打开操作菜单（替换图层/AI背景/AI渲染/查看原图/查看对比，见父级）；
 * 渲染中/AI生图中点击无效（不可操作，悬停取消小按钮除外）。
 *
 * 完成态悬停预览 portal 到 body 并 fixed 定位（卡片列表 overflow 裁剪会截断
 * absolute 浮层）；上方场景按底边锚定（translateY(-100%)），与下方间距一致。
 */
export function TemplateSquare({
  displayName,
  task,
  live,
  hasAi,
  aiGenerating,
  onOpen,
  onCancel,
  onRetry,
  cancelling,
}: TemplateSquareProps) {
  const t = live ?? task
  const busy = t?.status === "queued" || t?.status === "processing"
  // border-beam 的 theme=auto 按浏览器 prefers-color-scheme 猜主题，与应用
  // 的 class 深色模式不同步 → 显式传应用真实主题；深色底上光束再乘
  // strength 增强（包内对不透明度有 0-1 钳制，不会过曝）
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"

  const wrapRef = React.useRef<HTMLDivElement>(null)
  const [preview, setPreview] = React.useState<{
    top: number
    left: number
    above: boolean
  } | null>(null)

  const showPreview = () => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const centerX = rect.left + rect.width / 2
    const left = Math.min(
      Math.max(centerX - PREVIEW_WIDTH / 2, PREVIEW_GAP),
      window.innerWidth - PREVIEW_WIDTH - PREVIEW_GAP,
    )
    const above = rect.top > PREVIEW_MAX_HEIGHT
    setPreview({
      // 上方按底边锚定（渲染时 translateY(-100%)），下方按顶边锚定，
      // 两种方向的间距恒为 PREVIEW_GAP，不随图片实际高度变化
      top: above ? rect.top - PREVIEW_GAP : rect.bottom + PREVIEW_GAP,
      left,
      above,
    })
  }

  const canPreview = t?.status === "completed" && Boolean(t.resultImage)

  return (
    <div
      ref={wrapRef}
      className="group/sq relative"
      onMouseEnter={canPreview ? showPreview : undefined}
      onMouseLeave={canPreview ? () => setPreview(null) : undefined}
    >
      {/* 有 AI 结果 → 流光边框（批量生图卡片生成态同款 border-beam
          colorful；BeamWrapper 客户端挂载后生效，屏外动画自动暂停）。
          渲染 busy 态不激活（动画只保留动画本身），完成态才闪烁。
          外扩结构：补偿层(-m-px) 在 BeamWrapper 外、垫层(p-px) 在内 ——
          BorderBeam 把光环画在自己的根元素边缘，必须让根元素真正变大，
          光环才会落在缩略图边框外侧约 1px（紧贴边框、朝外发光，不被浅
          色缩略图内容吃掉）；外层负 margin 保持整体布局尺寸不变。
          strength 深浅色均加强，保证外部闪烁明显 */}
      <div className="-m-px">
        <BeamWrapper
          active={hasAi && !busy}
          colorVariant="colorful"
          size="sm"
          borderRadius={9}
          theme={dark ? "dark" : "light"}
          strength={dark ? 2.2 : 1.5}
        >
          <div className="p-px">
            <button
              type="button"
              onClick={(e) => {
                // 渲染中/AI生图中处于不可操作状态，点击不弹出菜单
                if (busy || aiGenerating) return
                onOpen(e.currentTarget.getBoundingClientRect())
              }}
              className={cn(
                "relative flex aspect-square w-20 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border bg-muted/40 transition",
                busy || aiGenerating
                  ? "cursor-not-allowed"
                  : "hover:border-primary",
              )}
            >
        {/* 完成态：结果图（始终显示渲染原图，AI 结果经对比查看） */}
        {t?.status === "completed" && t.resultImage ? (
          <SmartImage
            src={toImageSrc(t.resultImage, { width: 200 })}
            alt={displayName}
            className="absolute inset-0 size-full object-cover"
          />
        ) : null}

        {/* 占位（未渲染过） */}
        {!t ? (
          <>
            <ImageIcon className="size-6 text-muted-foreground/50" />
            <span className="max-w-full truncate px-1 text-[10px] text-muted-foreground">
              {displayName}
            </span>
          </>
        ) : null}

        {/* 排队 / 渲染中：ig- 纯动画（不带进度/状态文字） */}
        {busy ? (
          <div className="absolute inset-0">
            <ImageGeneration
              showMeta={false}
              resolution=""
              className="size-full"
            />
          </div>
        ) : null}

        {/* 取消中角标 */}
        {cancelling ? (
          <span className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 text-[10px] text-muted-foreground">
            <Ban className="mr-1 size-3" /> 取消中
          </span>
        ) : null}

        {/* AI 生图中：ig- 纯加载动画，无任何文字/进度/阶段角标
            （渲染 busy 态由上方分支处理，二者不叠加） */}
        {aiGenerating && !busy ? (
          <div className="absolute inset-0 z-10">
            <ImageGeneration
              showMeta={false}
              resolution=""
              className="size-full"
            />
          </div>
        ) : null}

        {/* AI 结果：方块内右上角蓝色 Sparkle 单星图标（实心、无底衬），
            配合外圈流光环；渲染 busy 态不显示（动画只保留动画本身） */}
        {hasAi && !busy ? (
          <Sparkle
            className="pointer-events-none absolute right-1 top-1 z-20 size-[14px] text-[#60A5FA]"
            fill="currentColor"
            strokeWidth={1.5}
          />
        ) : null}

        {/* 失败 */}
        {t?.status === "failed" ? (
          <>
            <AlertTriangle className="size-5 text-destructive" />
            <span className="line-clamp-2 px-1 text-[10px] leading-tight text-destructive">
              {t.errorMessage ?? "渲染失败"}
            </span>
            <span className="text-[9px] text-muted-foreground">已退款</span>
          </>
        ) : null}
        </button>
          </div>
        </BeamWrapper>
      </div>

      {/* 悬停操作：取消（渲染中）/ 重试（失败） */}
      <div className="absolute right-1 top-1 z-10 hidden gap-1 group-hover/sq:flex">
        {busy && onCancel ? (
          <span
            role="button"
            tabIndex={0}
            title="取消渲染（取消后退款）"
            className="flex size-5 items-center justify-center rounded bg-background/85 text-muted-foreground shadow hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              onCancel()
            }}
          >
            <X className="size-3" />
          </span>
        ) : null}
        {t?.status === "failed" && onRetry ? (
          <span
            role="button"
            tabIndex={0}
            title="重试此样机"
            className="flex size-5 items-center justify-center rounded bg-background/85 text-muted-foreground shadow hover:text-primary"
            onClick={(e) => {
              e.stopPropagation()
              onRetry()
            }}
          >
            <RotateCcw className="size-3" />
          </span>
        ) : null}
      </div>

      {/* 悬停完整比例预览（portal 到 body，fixed 定位不受容器裁剪，仅图片） */}
      {preview && canPreview && t?.resultImage
        ? createPortal(
            <div
              style={{
                position: "fixed",
                top: preview.top,
                left: preview.left,
                width: PREVIEW_WIDTH,
                transform: preview.above ? "translateY(-100%)" : undefined,
              }}
              className="pointer-events-none z-50 overflow-hidden rounded-lg border bg-popover shadow-lg"
            >
              <SmartImage
                src={toImageSrc(t.resultImage)}
                alt={displayName}
                className="max-h-72 w-full object-contain"
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
