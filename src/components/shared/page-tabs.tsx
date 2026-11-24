"use client"

import * as React from "react"
import Link from "next/link"
import { Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { shouldCollapsePageTabs } from "@/components/shared/page-tabs-collapse"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * 页面级 tab 切换条（宽度自适应，全站复用）：
 * - 宽度足够：整条 tab，与原内联写法逐 class 一致（TEMU 工作台 tab / shadcn Tabs）；
 * - tab 条 + 右侧工具挤不下一行：折叠为「单 tab（当前项）+ 下拉切换」，表头恒单行。
 * 判定靠实测：整条 tab 始终渲染（折叠态隐形绝对定位，仅用于测量自然宽度），
 * useLayoutEffect 首帧前校正、ResizeObserver 跟随侧栏折叠/窗口缩放/工具变化。
 * 图标以 ReactNode 传入（Lucide 是 client 组件，元素可跨 Server→Client 边界序列化）。
 */

export interface PageTabItem {
  value: string
  label: string
  /** Link 驱动（页面级切换条，URL 保持）；缺省走 onValueChange 受控 */
  href?: string
  icon?: React.ReactNode
}

type PageTabsSize = "default" | "sm"

/** 整条容器：default = TEMU 工作台 tab 同款 h-9；sm = shadcn TabsList 同款 h-8 */
const BOX: Record<PageTabsSize, string> = {
  default: "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
  sm: "inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground h-8",
}

/** 单个 tab：default 照抄 TEMU 内联条；sm 照抄 ui/tabs.tsx 的 TabsTrigger（含 dark 激活态） */
const ITEM: Record<PageTabsSize, string> = {
  default:
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
  sm: "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
}

/** 激活态（元素带 data-active 属性时生效，与 TabsTrigger 同构） */
const ACTIVE_ATTR: Record<PageTabsSize, string> = {
  default: "bg-background text-foreground shadow-sm",
  sm: "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground data-active:shadow-sm",
}

/** 激活态（无条件生效；折叠态的单 tab 触发器用——它本身恒为当前项） */
const ACTIVE_ON: Record<PageTabsSize, string> = {
  default: ACTIVE_ATTR.default,
  sm: "bg-background text-foreground dark:border-input dark:bg-input/30 dark:text-foreground shadow-sm",
}

export function PageTabs({
  tabs,
  value,
  onValueChange,
  size = "default",
  className,
  children,
}: {
  tabs: PageTabItem[]
  /** 当前激活 value */
  value: string
  /** 无 href 的受控模式（同页 state 切换） */
  onValueChange?: (value: string) => void
  size?: PageTabsSize
  /** 追加到整行（如 gap-2 覆盖默认行间距） */
  className?: string
  /** 右侧工具组（参与折叠判定） */
  children?: React.ReactNode
}) {
  const rowRef = React.useRef<HTMLDivElement>(null)
  const barRef = React.useRef<HTMLDivElement>(null)
  const toolsRef = React.useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = React.useState(false)
  const hasTools = React.Children.toArray(children).length > 0
  const active = tabs.find((t) => t.value === value)

  const measure = React.useCallback(() => {
    const row = rowRef.current
    const bar = barRef.current
    const tools = toolsRef.current
    if (!row || !bar) return
    setCollapsed(
      shouldCollapsePageTabs({
        barWidth: bar.getBoundingClientRect().width,
        toolsWidth: tools && tools.childElementCount > 0 ? tools.getBoundingClientRect().width : 0,
        gap: Number.parseFloat(getComputedStyle(row).columnGap) || 0,
        rowWidth: row.clientWidth,
      }),
    )
  }, [])

  // 每次渲染后在绘制前测量：SSR 与首帧按展开渲染（宽屏零闪烁、无 hydration 差异），
  // 窄屏在首帧绘制前即折叠；工具组随 tab 变化（如概览页时钟）也在同一时机重新判定
  React.useLayoutEffect(measure)

  React.useEffect(() => {
    const row = rowRef.current
    const bar = barRef.current
    const tools = toolsRef.current
    if (!row || !bar || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    // 监听三者：行宽（侧栏折叠/窗口缩放）、tab 条自然宽（字体加载）、工具组宽（内容变化）
    observer.observe(row)
    observer.observe(bar)
    if (tools) observer.observe(tools)
    return () => observer.disconnect()
  }, [measure])

  return (
    <div
      ref={rowRef}
      data-slot="page-tabs"
      className={cn("relative flex flex-wrap items-center justify-between", size === "sm" ? "gap-4" : "gap-3", className)}
    >
      {/* 整条 tab：展开态可见占位；折叠态隐形绝对定位——只用于测量自然宽度
          （visibility:hidden 同时移出 Tab 键序与无障碍树） */}
      <div
        ref={barRef}
        className={cn(BOX[size], collapsed && "invisible pointer-events-none absolute top-0 left-0 w-max")}
        aria-hidden={collapsed ? true : undefined}
      >
        {tabs.map((t) => {
          const isActive = t.value === value
          const itemCls = cn(ITEM[size], isActive ? ACTIVE_ATTR[size] : "hover:text-foreground")
          return t.href ? (
            <Link
              key={t.value}
              href={t.href}
              className={itemCls}
              // sm 变体的激活样式是 data-active: 变体（与 TabsTrigger 同构），链接与按钮都须带该属性
              data-active={isActive ? "" : undefined}
              aria-current={isActive ? "page" : undefined}
            >
              {t.icon}
              {t.label}
            </Link>
          ) : (
            // 受控模式：tab 外观不是按钮外观（无 hover 底色），沿用 tab 条自身的裸 button
            <button
              key={t.value}
              type="button"
              className={itemCls}
              data-active={isActive ? "" : undefined}
              aria-pressed={isActive}
              onClick={() => onValueChange?.(t.value)}
            >
              {t.icon}
              {t.label}
            </button>
          )
        })}
      </div>

      {collapsed && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(BOX[size], "cursor-pointer")}
            aria-label={`切换页面（当前：${active?.label ?? "功能"}）`}
          >
            <span className={cn(ITEM[size], ACTIVE_ON[size])}>
              {active?.icon}
              {active?.label ?? "功能"}
              <ChevronDown className="size-4 text-muted-foreground" />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-max min-w-(--anchor-width)">
            {tabs.map((t) => {
              const isActive = t.value === value
              return (
                <DropdownMenuItem
                  key={t.value}
                  render={t.href ? <Link href={t.href} /> : undefined}
                  className={cn("cursor-pointer", isActive && "bg-accent text-accent-foreground")}
                  onClick={t.href ? undefined : () => onValueChange?.(t.value)}
                >
                  {t.icon}
                  <span>{t.label}</span>
                  {isActive && <Check className="ml-auto" />}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {hasTools && (
        <div ref={toolsRef} className="flex shrink-0 items-center gap-2">
          {children}
        </div>
      )}
    </div>
  )
}
