"use client"

import * as React from "react"
import {
  AlertTriangle,
  Ban,
  Download,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupSquareTaskView } from "@/lib/mockup/types"
import { toImageSrc } from "@/lib/utils"

/** 外部渲染阶段 → 中文 */
export const STAGE_LABELS: Record<string, string> = {
  DOWNLOAD: "下载素材",
  RUN_JSX: "执行渲染",
  EXPORT: "导出",
  UPLOAD: "上传",
}

interface TemplateSquareProps {
  displayName: string
  /** 该小模板最新批次任务（null = 未渲染过） */
  task: MockupSquareTaskView | null
  /** 轮询实时覆盖（含最新 stage/progress） */
  live?: MockupSquareTaskView | null
  onOpen: () => void
  onCancel?: () => void
  onRetry?: () => void
  cancelling?: boolean
}

/**
 * 小模板方块（卡片中部的正方形缩略图）
 *
 * 五态：占位（未渲染）/ 排队 / 渲染中（进度+阶段）/ 完成（悬停浮出完整大图）/
 * 失败（原因 + 已退款 + 重试）。点击任意状态打开图层替换弹窗。
 */
export function TemplateSquare({
  displayName,
  task,
  live,
  onOpen,
  onCancel,
  onRetry,
  cancelling,
}: TemplateSquareProps) {
  const t = live ?? task
  const busy = t?.status === "queued" || t?.status === "processing"

  return (
    <div className="group/sq relative">
      {/* 悬停完整比例预览（仅完成态） */}
      {t?.status === "completed" && t.resultImage ? (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-2 hidden w-60 -translate-x-1/2 flex-col overflow-hidden rounded-lg border bg-popover shadow-lg group-hover/sq:flex">
          <SmartImage
            src={toImageSrc(t.resultImage)}
            alt={displayName}
            className="max-h-72 w-full object-contain"
          />
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
            <span className="truncate">{displayName}</span>
            <a
              href={toImageSrc(t.resultImage)}
              target="_blank"
              rel="noreferrer"
              download
              className="pointer-events-auto inline-flex items-center gap-1 text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <Download className="size-3" /> 下载
            </a>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onOpen}
        title={
          t?.status === "failed"
            ? `${t.errorMessage ?? "渲染失败"}（积分已退）`
            : displayName
        }
        className="relative flex aspect-square w-20 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border bg-muted/40 transition hover:border-primary"
      >
        {/* 完成态：结果图 */}
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

        {/* 排队 */}
        {t?.status === "queued" ? (
          <>
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">排队中</span>
          </>
        ) : null}

        {/* 渲染中 */}
        {busy && t?.status === "processing" ? (
          <div className="flex w-full flex-col items-center gap-1 px-2">
            <span className="text-[10px] font-medium tabular-nums">
              {t.progress ?? 0}%
            </span>
            <Progress value={t.progress ?? 0} className="h-1 w-full" />
            <span className="text-[10px] text-muted-foreground">
              {t.stage ? (STAGE_LABELS[t.stage] ?? t.stage) : "渲染中"}
            </span>
          </div>
        ) : null}

        {/* 取消中角标 */}
        {cancelling ? (
          <span className="absolute inset-0 flex items-center justify-center bg-background/70 text-[10px] text-muted-foreground">
            <Ban className="mr-1 size-3" /> 取消中
          </span>
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
    </div>
  )
}
