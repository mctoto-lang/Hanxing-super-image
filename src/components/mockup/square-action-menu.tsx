"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Eye, Layers, Sparkles, Split, Wand2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * 样机方块操作菜单（水平居中于方块的竖排选项，选项左对齐；portal +
 * fixed 定位避免被卡片列表 overflow 裁剪；上方空间不足则翻转到下方）
 *
 * 选项：替换图层 / AI背景 / AI渲染 / 查看原图 / 查看对比；
 * 不满足条件的选项灰显并注明原因。
 */

export interface SquareMenuState {
  rect: DOMRect
  /** 历史曾成功出图（跨全部批次；AI 功能与查看的参考基准、仅首次渲染规则） */
  hasRendered: boolean
  /** 模板是否含背景绑定（AI背景 前提） */
  hasBackgroundBinding: boolean
  /** 生成配置是否已选模型 */
  modelReady: boolean
  /** 是否有 AI 结果（查看对比 前提） */
  hasAi: boolean
  onReplaceLayers: () => void
  onAiBackground: () => void
  onAiRender: () => void
  onViewOriginal: () => void
  onCompare: () => void
}

const MENU_WIDTH = 112
const MENU_GAP = 6

export function SquareActionMenu({
  state,
  onClose,
}: {
  state: SquareMenuState | null
  onClose: () => void
}) {
  // Esc / 点击外部关闭
  React.useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof HTMLElement)) return
      if (e.target.closest("[data-square-menu]")) return
      onClose()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onPointer, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onPointer, true)
    }
  }, [state, onClose])

  if (!state) return null

  const estimatedHeight = 5 * 30 + 8 // 5 项紧凑高度
  const above = state.rect.top > estimatedHeight
  const top = above
    ? state.rect.top - MENU_GAP
    : state.rect.bottom + MENU_GAP
  // 水平居中于方块（菜单比方块宽，两侧均匀外扩），钳制在视口内
  const left = Math.max(
    Math.min(
      state.rect.left + state.rect.width / 2 - MENU_WIDTH / 2,
      window.innerWidth - MENU_WIDTH - 4,
    ),
    4,
  )

  const items: Array<{
    key: string
    label: string
    icon: React.ReactNode
    disabled: boolean
    reason?: string
    onClick: () => void
  }> = [
    {
      key: "replace",
      label: "替换图层",
      icon: <Layers className="size-3.5" />,
      // 仅首次渲染：已出图方块的图层配置锁定（改了也无法再渲染）
      disabled: state.hasRendered,
      reason: state.hasRendered ? "已出图，图层配置已锁定" : undefined,
      onClick: state.onReplaceLayers,
    },
    {
      key: "ai-bg",
      label: "AI背景",
      icon: <Sparkles className="size-3.5" />,
      disabled: !state.hasRendered || !state.hasBackgroundBinding || !state.modelReady,
      reason: !state.modelReady
        ? "请先在顶栏「生成配置」选择模型"
        : !state.hasRendered
          ? "请先完成一次样机渲染"
          : !state.hasBackgroundBinding
            ? "该模板未标记背景图层"
            : undefined,
      onClick: state.onAiBackground,
    },
    {
      key: "ai-render",
      label: "AI渲染",
      icon: <Wand2 className="size-3.5" />,
      disabled: !state.hasRendered || !state.modelReady,
      reason: !state.modelReady
        ? "请先在顶栏「生成配置」选择模型"
        : !state.hasRendered
          ? "请先完成一次样机渲染"
          : undefined,
      onClick: state.onAiRender,
    },
    {
      key: "view",
      label: "查看原图",
      icon: <Eye className="size-3.5" />,
      disabled: !state.hasRendered,
      reason: !state.hasRendered ? "尚未渲染" : undefined,
      onClick: state.onViewOriginal,
    },
    {
      key: "compare",
      label: "查看对比",
      icon: <Split className="size-3.5" />,
      disabled: !state.hasAi,
      reason: !state.hasAi ? "暂无 AI 结果" : undefined,
      onClick: state.onCompare,
    },
  ]

  return createPortal(
    <div
      data-square-menu
      style={{
        position: "fixed",
        top,
        left,
        width: MENU_WIDTH,
        transform: above ? "translateY(-100%)" : undefined,
      }}
      className="z-50 flex flex-col gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
    >
      {items.map((item) => {
        // disabled <button> 不派发鼠标事件：禁用项的按钮 pointer-events-none，
        // 悬停落在 TooltipTrigger 的 span 包裹层上（否则 Tooltip 无法触发）
        const button = (
          <button
            type="button"
            disabled={item.disabled}
            className={cn(
              "flex w-full items-center justify-start gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs transition",
              item.disabled
                ? "cursor-not-allowed pointer-events-none text-muted-foreground/40"
                : "text-foreground hover:bg-accent hover:text-accent-foreground",
            )}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onClick()
            }}
          >
            {item.icon}
            {item.label}
          </button>
        )
        if (!item.disabled) {
          return <React.Fragment key={item.key}>{button}</React.Fragment>
        }
        return (
          <TooltipProvider key={item.key}>
            <Tooltip>
              <TooltipTrigger
                render={<span className="block w-full cursor-not-allowed" />}
              >
                {button}
              </TooltipTrigger>
              <TooltipContent side="right">
                {item.reason ?? "当前不可用"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      })}
    </div>,
    document.body,
  )
}
