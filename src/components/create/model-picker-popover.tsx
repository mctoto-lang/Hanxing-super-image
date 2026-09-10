"use client"

import * as React from "react"
import { ChevronDown, Check, Cpu } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn, toImageSrc } from "@/lib/utils"
import { ModelBadge } from "@/components/model-badge"
import { TruncateTooltip } from "@/components/ui/truncate-tooltip"
import type { CreateModel } from "@/components/create/types"

/**
 * 模型选择器（卡片列表样式，参考图1）
 *
 * 每张卡片：左侧图标 + 右上「显示名 + 勋章」+ 下方灰色描述 + 选中 ✓。
 * 名称用配置的自定义显示名（displayName），不含价格（价格在底部总额展示）。
 */
export function ModelPickerPopover({
  models,
  value,
  onChange,
}: {
  models: CreateModel[]
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const selected = models.find((m) => m.id === value) ?? null

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
        {selected ? (
          <>
            {selected.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={toImageSrc(selected.iconUrl)}
                alt=""
                className="size-4 rounded object-contain shrink-0"
              />
            ) : (
              <Cpu className="size-3.5 shrink-0" />
            )}
            <span className="max-w-[120px] truncate">{selected.displayName}</span>
            {selected.badgeText?.trim() ? (
              <ModelBadge
                text={selected.badgeText.trim()}
                color={selected.badgeColor}
              />
            ) : null}
          </>
        ) : (
          <span>选择模型</span>
        )}
        <ChevronDown className="size-3.5 shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-h-80 overflow-y-auto p-1.5 scrollbar-hide"
      >
        {models.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            暂无可用模型
          </p>
        ) : (
          <div className="space-y-1">
            {models.map((m) => {
              const active = m.id === value
              const badge = m.badgeText?.trim()
              const desc = m.description?.trim()
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-left transition-colors",
                    active ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  {m.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={toImageSrc(m.iconUrl)}
                      alt=""
                      className="size-9 rounded-lg object-contain shrink-0"
                    />
                  ) : (
                    <div className="size-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <Cpu className="size-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <TruncateTooltip
                        text={m.displayName}
                        className="text-sm font-medium truncate"
                      />
                      {badge ? (
                        <ModelBadge text={badge} color={m.badgeColor} />
                      ) : null}
                    </div>
                    {desc ? (
                      <TruncateTooltip
                        text={desc}
                        className="text-xs text-muted-foreground line-clamp-1"
                      />
                    ) : null}
                  </div>
                  {active && <Check className="size-4 text-primary shrink-0" />}
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
