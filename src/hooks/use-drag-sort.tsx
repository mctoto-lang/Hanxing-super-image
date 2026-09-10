"use client"

import * as React from "react"
import { GripVertical } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

/**
 * 轻量 HTML5 拖拽排序 hook（超管配置表格共用，无第三方依赖）。
 *
 * - 拖拽由行首手柄激活（onPointerDown 置行 draggable；整行常开 draggable
 *   会与行内按钮点击/文本选择冲突）
 * - 拖动经过目标行时乐观换位预览，drop 后一次性 commit(orderedIds)；
 *   保存失败（含异常）回滚为服务端原序并 toast
 * - 键盘替代：手柄聚焦后 Alt+↑/↓ 与相邻行换位并保存（WCAG 2.1.1）
 * - items 的 id 序列变化（router.refresh 后）自动与服务端顺序对齐；
 *   乐观重排期间 id 集不变、不触发对齐
 */
export function useDragSort<T extends { id: string }>(opts: {
  items: T[]
  commit: (orderedIds: string[]) => Promise<{ ok: boolean; error?: string | null }>
}) {
  const { items, commit } = opts
  const idsKey = items.map((i) => i.id).join(",")

  const [order, setOrder] = React.useState<string[]>(() => idsKey.split(","))
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  /** 手柄按下激活 draggable 的行 id */
  const [armedId, setArmedId] = React.useState<string | null>(null)
  const dragIdRef = React.useRef<string | null>(null)
  const orderRef = React.useRef(order)
  const finalizedRef = React.useRef(false)
  const itemsRef = React.useRef(items)
  // 事件回调里读取最新顺序/数据（render 期不可写 ref，统一在 effect 同步）
  React.useEffect(() => {
    orderRef.current = order
    itemsRef.current = items
  })

  // 手柄按下后指针在手柄外释放/取消（无 window 级监听则行保持 draggable，
  // 之后在行上做文本选择会误触发行拖拽）
  React.useEffect(() => {
    if (!armedId) return
    const clear = () => setArmedId(null)
    window.addEventListener("pointerup", clear)
    window.addEventListener("pointercancel", clear)
    return () => {
      window.removeEventListener("pointerup", clear)
      window.removeEventListener("pointercancel", clear)
    }
  }, [armedId])

  // 服务端顺序变化时对齐（按 id 序列签名，避免数组引用抖动）
  React.useEffect(() => {
    setOrder(idsKey.split(","))
  }, [idsKey])

  const byId = React.useMemo(
    () => new Map(items.map((i) => [i.id, i])),
    [items],
  )
  const ordered = order
    .map((id) => byId.get(id))
    .filter((x): x is T => x != null)

  const move = (from: string, to: string) => {
    setOrder((prev) => {
      const fromIdx = prev.indexOf(from)
      const toIdx = prev.indexOf(to)
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev
      const next = [...prev]
      next.splice(fromIdx, 1)
      next.splice(toIdx, 0, from)
      return next
    })
  }

  const persist = async (ids: string[]) => {
    if (ids.length === 0) return
    try {
      const res = await commit(ids)
      if (!res.ok) {
        setOrder(itemsRef.current.map((i) => i.id))
        toast.error(res.error ?? "排序保存失败")
      }
    } catch {
      setOrder(itemsRef.current.map((i) => i.id))
      toast.error("排序保存失败")
    }
  }

  const finalize = async () => {
    if (finalizedRef.current) return
    finalizedRef.current = true
    const ids = orderRef.current
    dragIdRef.current = null
    setDraggingId(null)
    setArmedId(null)
    await persist(ids)
  }

  /** 铺到 TableRow 上（handleProps 激活后可拖；extraCls 为行自身附加类名） */
  const rowProps = (id: string, extraCls?: string) => ({
    draggable: armedId === id,
    onDragStart: (e: React.DragEvent) => {
      dragIdRef.current = id
      finalizedRef.current = false
      setDraggingId(id)
      e.dataTransfer.effectAllowed = "move"
      // Firefox 需要 setData 才会真正启动拖拽
      e.dataTransfer.setData("text/plain", id)
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      const from = dragIdRef.current
      if (from && from !== id) move(from, id)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      void finalize()
    },
    onDragEnd: () => {
      void finalize()
    },
    className: cn(extraCls, draggingId === id && "opacity-40"),
  })

  /** 铺到行首手柄上（可聚焦；Alt+↑/↓ 为键盘替代路径） */
  const handleProps = (id: string) => ({
    onPointerDown: () => setArmedId(id),
    "aria-label": "拖动调整顺序，或聚焦后按 Alt+↑/↓ 移动",
    role: "button" as const,
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
      e.preventDefault()
      const prev = orderRef.current
      const idx = prev.indexOf(id)
      const to = e.key === "ArrowUp" ? idx - 1 : idx + 1
      if (idx < 0 || to < 0 || to >= prev.length) return
      const next = [...prev]
      next.splice(idx, 1)
      next.splice(to, 0, id)
      setOrder(next)
      void persist(next)
    },
    className:
      "flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground/50 hover:bg-accent hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  })

  return { ordered, draggingId, rowProps, handleProps }
}

/** 行首拖拽手柄（w-8 表格首列；hidden lg:flex 打印/窄屏隐藏） */
export function DragHandle({
  handleProps,
}: {
  handleProps: React.HTMLAttributes<HTMLSpanElement> & {
    "aria-label"?: string
    role?: string
    tabIndex?: number
  }
}) {
  return (
    <span {...handleProps}>
      <GripVertical className="size-4" />
    </span>
  )
}
