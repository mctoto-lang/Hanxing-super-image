"use client"

import * as React from "react"
import { ChevronDown, Check, Cpu, Coins } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn, toImageSrc } from "@/lib/utils"
import { ModelBadge } from "@/components/model-badge"
import { formatPricePerMillion } from "@/lib/ai/chat/chat-model-config"
import type { ChatModelCard } from "@/components/chat/types"

/**
 * 对话模型选择器（图标 + 名称 + 徽章 + 价格摘要 + 选中 ✓）
 * 与生图 ModelPickerPopover 同构，卡片多一行百万 token 价格摘要。
 */
export function ChatModelPicker({
  models,
  value,
  onChange,
}: {
  models: ChatModelCard[]
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
                className="size-4 shrink-0 rounded object-cover"
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
        className="max-h-80 w-72 overflow-y-auto p-1.5 scrollbar-hide"
      >
        {models.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            暂无可用对话模型，请联系管理员配置
          </p>
        ) : (
          <div className="space-y-1">
            {models.map((m) => {
              const active = m.id === value
              const badge = m.badgeText?.trim()
              const desc = m.description?.trim()
              const free =
                m.inputPriceCenticredits <= 0 && m.outputPriceCenticredits <= 0
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                    active ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  {m.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={toImageSrc(m.iconUrl)}
                      alt=""
                      className="size-9 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Cpu className="size-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{m.displayName}</p>
                      {badge ? <ModelBadge text={badge} color={m.badgeColor} /> : null}
                    </div>
                    {desc ? (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{desc}</p>
                    ) : null}
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
                      <Coins className="size-3" />
                      {free ? (
                        <>免费</>
                      ) : (
                        <>
                          {formatPricePerMillion(m.inputPriceCenticredits)} /{" "}
                          {formatPricePerMillion(m.outputPriceCenticredits)} 积分·百万tokens
                        </>
                      )}
                    </p>
                  </div>
                  {active && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
