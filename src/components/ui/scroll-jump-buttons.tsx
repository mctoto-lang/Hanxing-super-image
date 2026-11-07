"use client"

import * as React from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * 跳转顶部/底部悬浮按钮（共享组件，自批量生图工作台抽出）
 *
 * - 点按：平滑滚动到容器顶部/底部（与原工作台行为一致）
 * - 按住 ≥ holdDelayMs：进入慢速滚动，rAF 循环按 holdSpeedPxPerS 像素/秒
 *   持续上滚/下滚，到边缘自动停止；松开即停且不触发点按
 * - 显隐：距顶部/底部超过 threshold 才显示对应按钮（原工作台阈值 240px）
 * - 定位：sticky 贴滚动容器右下角（仅适用于纵向滚动的容器）。注意 sticky
 *   的包含块是滚动容器盒：横向也会滚动的容器（如宽表 overflow-x-auto）内
 *   sticky right 只能把按钮向左推入包含块、不能向右拉到视口右缘，按钮会随
 *   内容横滚出视口——此类挂载方须把本组件移到滚动容器外，用
 *   className="absolute ..." 覆盖定位（见 inventory/data-table.tsx）
 * - 滚动容器：优先 containerRef；缺省自动探测最近 overflow-y 可滚祖先
 */
interface ScrollJumpButtonsProps {
  /** 滚动容器；缺省自动探测最近可滚祖先 */
  containerRef?: React.RefObject<HTMLElement | null>
  /** 距顶/底超过该像素才显示对应按钮 */
  threshold?: number
  /** 按住多少毫秒后进入慢速滚动 */
  holdDelayMs?: number
  /** 慢速滚动速度（像素/秒） */
  holdSpeedPxPerS?: number
  className?: string
}

/** 最近 overflow-y 可滚祖先。只看 overflow 样式不校验当前是否已溢出：
    首屏未溢出时 scrollHeight 比较会误绑到更外层滚动容器 */
function findScrollParent(start: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = start.parentElement
  while (p) {
    const oy = window.getComputedStyle(p).overflowY
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return p
    p = p.parentElement
  }
  return null
}

const BTN_BASE =
  "flex h-12 w-12 select-none touch-none items-center justify-center rounded-full border border-border/70 bg-background/95 text-foreground shadow-lg backdrop-blur transition-all duration-300 ease-out hover:-translate-y-0.5 hover:bg-accent"

// visibility 离散过渡：可见→隐藏在过渡末尾才生效、隐藏→可见立即生效，
// 配合 transition-all 既让隐藏态脱离 Tab 序列/a11y 树，又保住淡出动画
const VISIBLE = "translate-y-0 opacity-100 pointer-events-auto"
const HIDDEN = "translate-y-3 opacity-0 pointer-events-none invisible"

export function ScrollJumpButtons({
  containerRef,
  threshold = 240,
  holdDelayMs = 300,
  holdSpeedPxPerS = 80,
  className,
}: ScrollJumpButtonsProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  // 滚动容器在 effect 里解析（渲染期读 ref.current 违反 react-hooks/refs）
  const [el, setEl] = React.useState<HTMLElement | null>(null)
  const [showUp, setShowUp] = React.useState(false)
  const [showDown, setShowDown] = React.useState(false)

  // 解析滚动容器：外部 ref 优先，缺省自动探测。
  // 不加依赖数组（每次渲染重解析）：ref 对象引用恒定，containerRef.current
  // 换指向新元素（父层 key 重建滚动容器复用同一 ref）时 [containerRef] 不会
  // 变化，会漏重解析使 el 停在已卸载节点；setEl 相等守卫避免渲染循环
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (containerRef) {
      const target = containerRef.current ?? null
      setEl((prev) => (prev === target ? prev : target))
      return
    }
    const root = rootRef.current
    if (!root) return
    const found = findScrollParent(root)
    setEl((prev) => (prev === found ? prev : found))
  })

  // 显隐同步：scroll 事件 + 尺寸观察（无限加载追加行不触发 scroll）。
  // RO 只观察挂载时的 firstElementChild，其被条件分支/key 重建替换后（DOM
  // 移除不产生 RO 记录）内容增长即失联——补 MutationObserver：子树 childList
  // 变更（卡片流式到达等）直接 sync，firstElementChild 换人则改观察新节点
  React.useEffect(() => {
    if (!el) return
    let child: HTMLElement | null =
      el.firstElementChild instanceof HTMLElement ? el.firstElementChild : null
    const sync = () => {
      setShowUp(el.scrollTop > threshold)
      setShowDown(el.scrollHeight - el.scrollTop - el.clientHeight > threshold)
    }
    sync()
    el.addEventListener("scroll", sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    if (child) ro.observe(child)
    const mo = new MutationObserver(() => {
      const next = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : null
      if (next !== child) {
        if (child) ro.unobserve(child)
        if (next) ro.observe(next)
        child = next
      }
      sync()
    })
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener("scroll", sync)
      ro.disconnect()
      mo.disconnect()
    }
  }, [el, threshold])

  /** 一次按压的会话：dir=-1 上滚 / +1 下滚；holding=已进入长按慢滚 */
  const pressRef = React.useRef<{ dir: 1 | -1; raf: number; lastTs: number; holding: boolean } | null>(null)
  const holdTimerRef = React.useRef<number | null>(null)

  const stopPress = React.useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    const press = pressRef.current
    if (press) {
      cancelAnimationFrame(press.raf)
      pressRef.current = null
    }
    return press
  }, [])

  // 卸载时终止按压会话：按钮可能先于滚动容器卸载（如 scrollJump 条件翻转、
  // 容器 div 持续挂载），不清理的话 rAF 慢滚循环/长按定时器会继续把容器滚到边缘
  React.useEffect(() => {
    return () => {
      stopPress()
    }
  }, [stopPress])

  const startPress = React.useCallback(
    (dir: 1 | -1) => {
      if (!el) return
      stopPress()
      const press = { dir, raf: 0, lastTs: 0, holding: false }
      pressRef.current = press
      holdTimerRef.current = window.setTimeout(() => {
        press.holding = true
        press.lastTs = performance.now()
        const tick = (ts: number) => {
          if (pressRef.current !== press || !el.isConnected) return
          const dt = Math.min((ts - press.lastTs) / 1000, 0.1)
          press.lastTs = ts
          const max = el.scrollHeight - el.clientHeight
          el.scrollTop =
            press.dir < 0
              ? Math.max(0, el.scrollTop - holdSpeedPxPerS * dt)
              : Math.min(max, el.scrollTop + holdSpeedPxPerS * dt)
          const done = press.dir < 0 ? el.scrollTop <= 0 : el.scrollTop >= max - 0.5
          if (!done) press.raf = requestAnimationFrame(tick)
        }
        press.raf = requestAnimationFrame(tick)
      }, holdDelayMs)
    },
    [el, holdDelayMs, holdSpeedPxPerS, stopPress],
  )

  /** 结束按压；tap=true 且未进入长按 → 平滑跳到顶/底 */
  const endPress = React.useCallback(
    (tap: boolean) => {
      const press = stopPress()
      if (tap && press && !press.holding && el) {
        el.scrollTo({ top: press.dir < 0 ? 0 : el.scrollHeight, behavior: "smooth" })
      }
    },
    [el, stopPress],
  )

  return (
    <div
      ref={rootRef}
      className={cn("sticky bottom-5 right-5 ml-auto mr-5 mb-5 flex w-fit flex-col gap-2", className)}
    >
      <button
        type="button"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault() // 防按压拖选文本
          startPress(-1)
        }}
        onPointerUp={() => endPress(true)}
        onPointerLeave={() => {
          if (pressRef.current?.dir === -1) endPress(false)
        }}
        onPointerCancel={() => {
          if (pressRef.current?.dir === -1) endPress(false)
        }}
        // 触屏长按系统菜单与慢滚冲突
        onContextMenu={(e) => e.preventDefault()}
        // 键盘：Enter/Space 等价点按（长按无键盘等价）；隐藏态不响应
        onKeyDown={(e) => {
          if (!showUp || (e.key !== "Enter" && e.key !== " ")) return
          e.preventDefault()
          el?.scrollTo({ top: 0, behavior: "smooth" })
        }}
        className={cn(BTN_BASE, showUp ? VISIBLE : HIDDEN)}
        aria-label="回到顶部"
        title="回到顶部（长按持续上滚）"
      >
        <ArrowUp className="h-5 w-5" />
      </button>
      <button
        type="button"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          startPress(1)
        }}
        onPointerUp={() => endPress(true)}
        onPointerLeave={() => {
          if (pressRef.current?.dir === 1) endPress(false)
        }}
        onPointerCancel={() => {
          if (pressRef.current?.dir === 1) endPress(false)
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (!showDown || (e.key !== "Enter" && e.key !== " ")) return
          e.preventDefault()
          el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
        }}
        className={cn(BTN_BASE, showDown ? VISIBLE : HIDDEN)}
        aria-label="跳转到底部"
        title="跳转到底部（长按持续下滚）"
      >
        <ArrowDown className="h-5 w-5" />
      </button>
    </div>
  )
}
