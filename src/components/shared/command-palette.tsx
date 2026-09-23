"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * 全局命令面板（Ctrl/Cmd + K，P2-1）
 *
 * 跨模块快速跳转（Linear/Vercel/Notion 标配）：全局快捷键唤出，
 * 输入即过滤导航项，↑↓ 选择、Enter 跳转、Esc 关闭。
 * 导航项由 DashboardShell 从权限过滤后的 navMain 展平传入。
 */

export interface PaletteItem {
  title: string
  url: string
  group: string
}

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)

  // 全局快捷键：Ctrl/Cmd + K 唤出或关闭
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => it.title.toLowerCase().includes(q))
  }, [items, query])

  // 过滤结果变化时重置选中
  React.useEffect(() => {
    setActiveIndex(0)
  }, [query])

  function go(item: PaletteItem) {
    setOpen(false)
    setQuery("")
    router.push(item.url)
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const item = filtered[activeIndex]
      if (item) go(item)
    }
  }

  // 滚动跟随选中项
  const listRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    listRef.current
      ?.querySelector("[data-active='true']")
      ?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, filtered])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery("")
      }}
    >
      <DialogContent
        className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-md"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>命令面板</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索页面，Enter 跳转…"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          className="max-h-80 overflow-y-auto p-1.5"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              没有匹配的页面
            </p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.url}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                data-active={i === activeIndex}
                onClick={() => go(item)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  i === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span className="min-w-0 truncate">{item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.group}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
          ↑↓ 选择 · Enter 跳转 · Ctrl/⌘ K 唤出
        </div>
      </DialogContent>
    </Dialog>
  )
}
