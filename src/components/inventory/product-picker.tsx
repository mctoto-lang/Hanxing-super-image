"use client"

import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { ChevronsUpDown } from "lucide-react"
import { searchProductsAction } from "@/server/actions/inventory"
import { cn } from "@/lib/utils"

/**
 * 货号选择器（Command 搜索面板）：图+货号+款名+实时库存，
 * 建生产单/出入库/调拨共用。
 */

export interface PickedProduct {
  id: string
  productCode: string
  name: string
  imageUrl: string | null
  totalQty: number
  /** 条码预贴标记（false=未预贴；建生产单时辅料「条码」默认勾选） */
  barcodePrePasted?: boolean
}

export function ProductPicker({
  value,
  onChange,
  placeholder = "搜索货号 / 款名",
  className,
}: {
  value: PickedProduct | null
  onChange: (p: PickedProduct | null) => void
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [rows, setRows] = React.useState<PickedProduct[]>([])
  const [, startTransition] = React.useTransition()
  /** 搜索弹层元素 id：供触发按钮 aria-controls 引用（combobox 角色必需） */
  const listboxId = React.useId()

  React.useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      startTransition(async () => {
        const r = await searchProductsAction({ q, limit: 30 })
        if (r.ok) setRows(r.rows)
      })
    }, 200)
    return () => clearTimeout(t)
  }, [open, q])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50",
              !value && "text-muted-foreground",
              className,
            )}
          />
        }
      >
        {value ? (
          <span className="flex min-w-0 items-center gap-2">
            {value.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={value.imageUrl}
                alt=""
                className="size-6 shrink-0 rounded object-cover"
              />
            ) : null}
            <span className="truncate">
              {value.productCode} · {value.name}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent id={listboxId} className="w-[360px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder="输入货号或款名搜索"
          />
          <CommandList>
            <CommandEmpty>未找到匹配货号</CommandEmpty>
            <CommandGroup>
              {rows.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    onChange(p)
                    setOpen(false)
                  }}
                >
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="size-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      无图
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-normal">
                      {p.productCode}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    库存 {p.totalQty}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
