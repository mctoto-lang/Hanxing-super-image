"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { parseImageSize, type SizePreset } from "@/lib/image-sizes"

const COUNTS = [1, 2, 3, 4]
const AUTO = "auto"

/**
 * 尺寸 / 数量 合并选择面板（参考图，需求 1 + 3）
 *
 * 一个 Popover 内含三段：
 * 1. 选择比例：横向单行分段样式。supportsAuto 时首项「智能」(value=auto)。
 *    被后台关闭的比例(enabled=false)置灰不可选。
 * 2. 选择生成数量：supportsCount 时显示 1-4（铺满整行）。即梦模型下选择为
 *    「次数」（每次产出模型配置的 N 张），由 countLabel/countHint 覆盖文案。
 * 3. 选择尺寸：宽 × 高 输入（W/H 前缀、右对齐），实时生效（输入即取消比例高亮，
 *    生图按自定义尺寸进行）；value=auto 时禁用。单位 PX。
 */
export function SizePickerPopover({
  presets,
  supportsAuto,
  value,
  onSizeChange,
  supportsCount,
  count,
  onCountChange,
  countLabel = "选择生成数量",
  countHint,
}: {
  presets: SizePreset[]
  supportsAuto: boolean
  value: string
  onSizeChange: (v: string) => void
  supportsCount: boolean
  count: number
  onCountChange: (n: number) => void
  /** 数量段标题（即梦模型传「选择次数」） */
  countLabel?: string
  /** 数量段下方提示（如「每次 8 张 × 次数，按张计费」） */
  countHint?: string
}) {
  const [open, setOpen] = React.useState(false)
  const isAuto = value === AUTO
  const selectedPreset = presets.find((s) => s.value === value) ?? null

  // 自定义宽高输入
  const initial = parseImageSize(isAuto ? "1024x1024" : value)
  const [customW, setCustomW] = React.useState(String(initial.width))
  const [customH, setCustomH] = React.useState(String(initial.height))

  // 选中比例 / 外部 value 变化时回填输入框（往返稳定，输入实时生效不冲突）
  React.useEffect(() => {
    if (!open) return
    const p = parseImageSize(isAuto ? "1024x1024" : value)
    setCustomW(String(p.width))
    setCustomH(String(p.height))
  }, [open, value, isAuto])

  /** 宽输入：更新本地值；两端均有效则实时下发自定义尺寸（取消比例高亮） */
  function handleWidth(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setCustomW(raw)
    const w = parseInt(raw, 10)
    const h = parseInt(customH, 10)
    if (w > 0 && h > 0) onSizeChange(`${w}x${h}`)
  }
  /** 高输入 */
  function handleHeight(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    setCustomH(raw)
    const w = parseInt(customW, 10)
    const h = parseInt(raw, 10)
    if (w > 0 && h > 0) onSizeChange(`${w}x${h}`)
  }

  function triggerLabel() {
    if (isAuto) return "智能"
    return selectedPreset?.label ?? value
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none"
          />
        }
      >
        {isAuto ? (
          <AutoBadge className="shrink-0 text-primary" />
        ) : (
          <RatioIcon size={parseImageSize(value)} className="shrink-0" />
        )}
        <span className="max-w-[100px] truncate">{triggerLabel()}</span>
        {/* 分割线 + 生成数量（仅模型支持数量时显示） */}
        {supportsCount ? (
          <>
            <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
            <span className="shrink-0 tabular-nums">{count}</span>
          </>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-max max-w-[44rem] p-3">
        {/* 1. 选择比例（横向单行分段样式） */}
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            选择比例
          </div>
          <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
            {supportsAuto ? (
              <RatioChip
                active={isAuto}
                onClick={() => {
                  onSizeChange(AUTO)
                  setOpen(false)
                }}
              >
                <AutoBadge className={cn(isAuto && "text-primary")} />
                <span>智能</span>
              </RatioChip>
            ) : null}
            {presets.map((s) => (
              <RatioChip
                key={s.value}
                active={!isAuto && s.value === value}
                disabled={!s.enabled}
                onClick={() => {
                  onSizeChange(s.value)
                  setOpen(false)
                }}
              >
                <RatioIcon
                  size={{ width: s.width, height: s.height }}
                  className={cn(
                    !isAuto && s.value === value && s.enabled && "text-primary",
                  )}
                />
                <span>{s.label}</span>
              </RatioChip>
            ))}
          </div>
        </div>

        {/* 2. 选择生成数量（铺满整行） */}
        {supportsCount ? (
          <div className="mt-3">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              {countLabel}
            </div>
            <div className="flex w-full rounded-lg border bg-muted/50 p-0.5">
              {COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => onCountChange(n)}
                  className={cn(
                    "h-7 flex-1 rounded-md text-xs font-medium tabular-nums transition-colors",
                    count === n
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            {countHint ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{countHint}</p>
            ) : null}
          </div>
        ) : null}

        {/* 3. 选择尺寸（W/H 前缀、右对齐、实时生效） */}
        <div className="mt-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            选择尺寸{isAuto ? "（智能模式下不可用）" : ""}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                W
              </span>
              <Input
                type="number"
                min={64}
                max={8192}
                value={customW}
                onChange={handleWidth}
                disabled={isAuto}
                className="h-8 w-full pl-6 pr-2 text-right text-sm tabular-nums"
              />
            </div>
            <span className="shrink-0 text-muted-foreground">×</span>
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground">
                H
              </span>
              <Input
                type="number"
                min={64}
                max={8192}
                value={customH}
                onChange={handleHeight}
                disabled={isAuto}
                className="h-8 w-full pl-6 pr-2 text-right text-sm tabular-nums"
              />
            </div>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              PX
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 智能(auto) 图标：透明圆角矩形框 + "Auto" 文字，高度与比例示意图标视觉等高；边框随 currentColor 着色 */
function AutoBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-3.5 items-center rounded-[3px] border border-current px-1 text-[8px] font-bold leading-none",
        className,
      )}
    >
      Auto
    </span>
  )
}

/** 比例按钮（分段样式）：图标在上、文案在下，选中高亮、禁用置灰 */
function RatioChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      title={disabled ? "该比例未开启" : undefined}
      className={cn(
        "inline-flex w-12 shrink-0 flex-col items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : active
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

/** 按宽高比绘制比例示意图标（按比例缩放到 boxSize 框内，默认 14） */
function RatioIcon({
  size,
  boxSize = 14,
  className,
}: {
  size: { width: number; height: number }
  boxSize?: number
  className?: string
}) {
  const max = boxSize
  const ratio = size.width / size.height
  let w: number, h: number
  if (ratio >= 1) {
    w = max
    h = Math.max(4, Math.round(max / ratio))
  } else {
    h = max
    w = Math.max(4, Math.round(max * ratio))
  }
  return (
    <span
      className={cn("inline-flex items-center justify-center", className)}
      style={{ width: max, height: max }}
    >
      <span
        className={cn("block rounded-[2px] border", activeBorderClass(className))}
        style={{ width: w, height: h }}
      />
    </span>
  )
}

/** 给 RatioIcon 内部矩形一个默认边框色（未选中时） */
function activeBorderClass(className?: string): string {
  if (className?.includes("text-primary")) return "border-primary"
  return "border-current opacity-70"
}
