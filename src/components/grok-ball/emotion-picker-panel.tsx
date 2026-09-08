"use client"

import { useEffect, useRef, useState } from "react"
import type { EmotionGroup, EmotionSummary, GrokBallEngine } from "./engine/grok-ball"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * 32 表情选择面板：分组网格 + 静态缩略图
 *
 * 缩略图按 SKILL.md 规范用 autostart:false 静态渲染（lite 模式、零帧成本）；
 * 元数据运行时读取 GrokBall.EMOTIONS / GROUPS，注册的自定义表情会自动出现。
 */

interface EmotionPickerPanelProps {
  currentId: string
  onSelect: (emotionId: string) => void
  onHide: () => void
}

interface EmotionMeta {
  groups: EmotionGroup[]
  emotions: EmotionSummary[]
}

export function EmotionPickerPanel({
  currentId,
  onSelect,
  onHide,
}: EmotionPickerPanelProps) {
  const [meta, setMeta] = useState<EmotionMeta | null>(null)
  const cellRefs = useRef(new Map<string, HTMLDivElement>())

  // 引擎元数据（含自定义注册的表情）
  useEffect(() => {
    let disposed = false
    void import("./engine/grok-ball").then(({ GrokBall }) => {
      if (disposed) return
      setMeta({
        groups: GrokBall.GROUPS,
        emotions: [...GrokBall.EMOTIONS].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      })
    })
    return () => {
      disposed = true
    }
  }, [])

  // 元数据就绪、格子渲染后，为每格创建静态缩略图
  useEffect(() => {
    if (!meta) return
    let disposed = false
    const created: GrokBallEngine[] = []
    void import("./engine/grok-ball").then(({ GrokBall }) => {
      if (disposed) return
      for (const emotion of meta.emotions) {
        const cell = cellRefs.current.get(emotion.id)
        if (cell) {
          created.push(
            GrokBall.create(cell, {
              emotion: emotion.id,
              autostart: false,
              eyeScale: 1.4,
            }),
          )
        }
      }
    })
    return () => {
      disposed = true
      created.forEach((engine) => engine.destroy())
    }
  }, [meta])

  if (!meta) {
    return <div className="h-40 animate-pulse rounded-lg bg-muted/50" aria-hidden />
  }

  return (
    <div>
      {/* 隐藏式滚动条：平时不可见，悬停面板时浮现细圆角条 */}
      <div
        className={cn(
          "max-h-[52vh] space-y-3 overflow-y-auto overscroll-contain pr-0.5",
          "[scrollbar-width:thin] [scrollbar-color:transparent_transparent]",
          "hover:[scrollbar-color:var(--color-border)_transparent]",
          "[&::-webkit-scrollbar]:w-1.5",
          "[&::-webkit-scrollbar-track]:bg-transparent",
          "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-thumb]:transition-colors",
          "hover:[&::-webkit-scrollbar-thumb]:bg-border",
        )}
      >
        {meta.groups
          .filter((group) =>
            meta.emotions.some((emotion) => emotion.group === group.key),
          )
          .map((group) => (
            <section key={group.key}>
              <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                {group.name}
              </h3>
              <div className="grid grid-cols-4 gap-1.5">
                {meta.emotions
                  .filter((emotion) => emotion.group === group.key)
                  .map((emotion) => (
                    <button
                      key={emotion.id}
                      type="button"
                      title={emotion.desc ? `${emotion.name} · ${emotion.desc}` : emotion.name}
                      aria-label={`切换表情：${emotion.name}`}
                      aria-pressed={currentId === emotion.id}
                      onClick={() => onSelect(emotion.id)}
                      className={cn(
                        "relative flex aspect-square items-center justify-center rounded-lg border transition-colors",
                        currentId === emotion.id
                          ? "border-primary bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-muted",
                      )}
                    >
                      <div
                        className="h-8 w-8"
                        ref={(el) => {
                          if (el) cellRefs.current.set(emotion.id, el)
                          else cellRefs.current.delete(emotion.id)
                        }}
                      />
                      <span className="absolute inset-x-0 bottom-0.5 truncate px-0.5 text-center text-[9px] leading-none text-muted-foreground">
                        {emotion.name}
                      </span>
                    </button>
                  ))}
              </div>
            </section>
          ))}
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t pt-2">
        <p className="text-[10px] text-muted-foreground">
          双击球旋转 · 聊天中自动联动
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onHide}
        >
          隐藏表情圆球
        </Button>
      </div>
    </div>
  )
}
