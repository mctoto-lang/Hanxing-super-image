"use client"

import Link from "next/link"

import { cn } from "@/lib/utils"
import { STOCK_VIEWS, type StockView } from "./stock-views"

/** 库存数据页二级视图导航（URL ?view= 驱动，刷新/直链保持；
 *  样式对齐 TEMU 工作台 tab：图标+文字、h-9 胶囊） */

export function StockViewNav({ view }: { view: StockView }) {
  return (
    <div className="inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
      {STOCK_VIEWS.map((v) => (
        <Link
          key={v.value}
          href={`/inventory/stock?view=${v.value}`}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-normal whitespace-nowrap transition-all",
            view === v.value
              ? "bg-background text-foreground shadow-sm"
              : "hover:text-foreground",
          )}
        >
          <v.icon className="size-4" />
          {v.label}
        </Link>
      ))}
    </div>
  )
}
