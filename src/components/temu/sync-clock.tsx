"use client"

import * as React from "react"
import { Clock } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { formatCnDateTime } from "@/lib/datetime"
import { cn } from "@/lib/utils"

export interface TemuSyncStoreRow {
  id: string
  name: string
  /** 最近一次同步时间（null = 从未同步） */
  lastSyncAt: string | Date | null
  /** 最近一次同步结果（null = 有时间但无状态记录） */
  ok: boolean | null
}

/** 同步状态行：状态点 + 店铺名 + 状态小字 + 右对齐全格式时间（服务可用性同款行布局） */
function SyncRow({ store }: { store: TemuSyncStoreRow }) {
  const never = store.lastSyncAt == null
  const ok = store.ok
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          never ? "bg-muted-foreground/40" : ok === true ? "bg-emerald-500" : ok === false ? "bg-red-500" : "bg-muted-foreground/40",
        )}
      />
      <span className="min-w-0 max-w-[10rem] truncate text-sm font-medium">{store.name}</span>
      <span className="text-xs text-muted-foreground">
        {never ? "从未同步" : ok === true ? "同步成功" : ok === false ? "同步失败" : "已同步"}
      </span>
      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
        {never ? "—" : formatCnDateTime(store.lastSyncAt)}
      </span>
    </div>
  )
}

/**
 * 概览页时间显示框（店铺下拉左侧）：走秒实时时钟，样式与 SelectTrigger 同款外壳；
 * 点击弹出「店铺同步时间」——当前已开启店铺各自最近一次同步时间
 * （服务可用性模板样式：内容区高约 5 行、隐藏滚动条滚动查看）。
 */
export function TemuSyncClock({ stores }: { stores: TemuSyncStoreRow[] }) {
  // 走秒时钟：SSR 渲染服务端时刻，挂载后每秒对齐客户端（suppressHydrationWarning 消差）
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    // 递归 setTimeout 对齐下一整秒边界调度（+5ms 防恰好压线重复渲染同一秒）：
    // setInterval 挂载相位固定、后台节流回前台跳变，均会偏离真实秒边界
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      timer = setTimeout(() => {
        setNow(new Date())
        schedule()
      }, 1000 - (Date.now() % 1000) + 5)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])

  return (
    <Dialog>
      <DialogTrigger
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none select-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
        aria-label="查看店铺同步时间"
      >
        <Clock className="size-3.5" />
        <span suppressHydrationWarning className="tabular-nums">
          {formatCnDateTime(now)}
        </span>
      </DialogTrigger>
      <DialogContent className="gap-6 p-6 sm:max-w-xl">
        <DialogHeader className="space-y-0">
          <DialogTitle>店铺同步时间</DialogTitle>
          <DialogDescription>
            当前已开启店铺最近一次同步（默认 15 分钟一轮，手动同步即时更新）
          </DialogDescription>
        </DialogHeader>
        {/* 内容区高约 5 行（行 ~32px + 行距 16px），超出隐藏滚动条滚动查看 */}
        <div className="scrollbar-hide max-h-[240px] space-y-4 overflow-y-auto pr-1">
          {stores.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无已开启店铺</p>
          ) : (
            stores.map((s) => <SyncRow key={s.id} store={s} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
