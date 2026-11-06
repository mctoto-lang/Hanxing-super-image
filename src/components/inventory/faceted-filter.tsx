"use client"

import * as React from "react"
import { Check, ChevronsUpDown, PlusCircle, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

/**
 * faceted 多选筛选（shadcn dashboard-01/tasks 模板同款）：
 * trigger=outline 按钮带标题+已选计数徽章，面板 Command 搜索+勾选，
 * 底部「清除筛选」；多选值为 OR 叠加，由调用方过滤。
 */

export function FacetedFilter({
  title,
  options,
  values,
  onChange,
  className,
}: {
  title: string
  options: Array<{ value: string; label: string }>
  /** 已选值（空数组=不过滤） */
  values: string[]
  onChange: (values: string[]) => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = new Set(values)

  const toggle = (v: string) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("h-8 rounded-lg border-dashed", className)}
          />
        }
      >
        <PlusCircle className="size-3.5 text-muted-foreground" />
        {title}
        {selected.size > 0 ? (
          <>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal tabular-nums">
              {selected.size}
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`清除${title}筛选`}
              className="flex size-3.5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onChange([])
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation()
                  e.preventDefault()
                  onChange([])
                }
              }}
            >
              <X className="size-3" />
            </span>
          </>
        ) : null}
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`筛${title}…`} className="h-8" />
          <CommandList>
            <CommandEmpty className="py-3 text-sm text-muted-foreground">无匹配</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const active = selected.has(o.value)
                return (
                  <CommandItem
                    key={o.value}
                    value={o.value}
                    onSelect={() => toggle(o.value)}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {active ? <Check className="size-3" /> : null}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {selected.size > 0 ? (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start px-2"
              onClick={() => onChange([])}
            >
              <X className="size-3.5" /> 清除筛选
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
