"use client"

import * as React from "react"
import { Check, ChevronDown, Search, X } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn, toImageSrc } from "@/lib/utils"

/**
 * 通用可搜索下拉选择器（Combobox）
 *
 * 基于 Popover 实现，弹层使用固定宽度（不锚定 trigger），修复长名称截断；
 * 支持搜索过滤、图标、描述、徽章、一键清除，替代 Select + __clear__ 哨兵方案。
 *
 * 位于 Dialog 内时自动以弹窗为碰撞边界：下拉触及弹窗底边即向上翻转，
 * 不会伸出弹窗之外（避免"弹窗被下拉撑高"的视觉问题）。
 * 选项列表隐藏滚动条但保留滚动能力。
 */
export interface ComboboxOption {
  value: string
  label: string
  /** 次要说明（灰字），同时参与搜索过滤 */
  description?: string | null
  /** 远程图标 URL（经存储代理加载） */
  iconUrl?: string | null
  /** 右侧徽章文案 */
  badge?: string | null
}

interface ComboboxProps {
  value: string | null | undefined
  /** 选中项变化；清除时传入空串 */
  onChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  allowClear?: boolean
  className?: string
  popoverClassName?: string
  id?: string
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder = "请选择",
  searchPlaceholder = "搜索...",
  emptyText = "无匹配项",
  disabled = false,
  allowClear = true,
  className,
  popoverClassName,
  id,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")
  const [dialogBoundary, setDialogBoundary] = React.useState<
    HTMLElement | undefined
  >(undefined)
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  const selected = options.find((o) => o.value === value) ?? null

  /** 弹层碰撞边界：处于 Dialog 内时取弹窗元素，触底自动向上翻转 */
  const resolveBoundary = () =>
    (triggerRef.current?.closest(
      '[data-slot="dialog-content"]',
    ) as HTMLElement | null) ?? undefined

  // 打开时重置搜索并聚焦输入框（键盘激活时兜底计算碰撞边界）
  React.useEffect(() => {
    if (open) {
      setKeyword("")
      setDialogBoundary(resolveBoundary())
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(kw) ||
          (o.description?.toLowerCase().includes(kw) ?? false),
      )
    : options

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        render={
          <button
            type="button"
            id={id}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            // 弹层展开前先确定碰撞边界，避免先向下弹再翻转的闪动
            onPointerDown={() => setDialogBoundary(resolveBoundary())}
            className={cn(
              "flex h-9 w-full items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm whitespace-nowrap transition-colors outline-none select-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50",
              !selected && "text-muted-foreground",
              className,
            )}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {selected ? (
            <>
              {selected.iconUrl ? (
                // 远程动态图标，经存储代理加载；沿用 <img>（见 model-select-dialog 说明）
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={toImageSrc(selected.iconUrl)}
                  alt=""
                  className="size-4 shrink-0 rounded object-contain"
                />
              ) : null}
              <span className="truncate">{selected.label}</span>
              {selected.badge ? (
                <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                  {selected.badge}
                </span>
              ) : null}
            </>
          ) : (
            <span className="truncate">{placeholder}</span>
          )}
        </span>
        {allowClear && selected && !disabled ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label="清除选择"
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onChange("")
            }}
          >
            <X className="size-3" />
          </span>
        ) : null}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionBoundary={dialogBoundary}
        collisionPadding={8}
        className={cn("w-72 p-1.5", popoverClassName)}
      >
        <div className="relative mb-1 flex items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
          <input
            ref={searchRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
          />
        </div>
        {/* 隐藏滚动条但保留滚动（滚轮/触控板仍可滚动长列表） */}
        <div className="max-h-64 overflow-y-auto pr-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {emptyText}
            </p>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((o) => {
                const active = o.value === value
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onChange(o.value)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                    )}
                  >
                    {o.iconUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={toImageSrc(o.iconUrl)}
                        alt=""
                        className="size-5 shrink-0 rounded object-contain"
                      />
                    ) : null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm">{o.label}</span>
                        {o.badge ? (
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                            {o.badge}
                          </span>
                        ) : null}
                      </span>
                      {o.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {o.description}
                        </span>
                      ) : null}
                    </span>
                    {active ? (
                      <Check className="size-4 shrink-0 text-primary" />
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
