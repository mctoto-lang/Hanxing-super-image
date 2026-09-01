"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { MODEL_BADGE_COLOR_OPTIONS } from "@/lib/model-badges"
import { ModelBadge } from "@/components/model-badge"

/**
 * 模型勋章配置（需求 4）
 *
 * 文字 + 预设色板 + 实时药丸预览。两者均空 = 不显示勋章。
 */
export function BadgeField({
  text,
  color,
  onTextChange,
  onColorChange,
}: {
  text: string
  color: string
  onTextChange: (v: string) => void
  onColorChange: (v: string) => void
}) {
  // 色板默认选中蓝色
  const activeColor = color || "blue"
  const preview = text.trim()

  return (
    <div className="grid gap-2">
      <Label>名称勋章（可选）</Label>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="如 NEW / 热门"
          maxLength={30}
          className="h-9 w-40 text-sm"
        />
        {/* 实时预览 */}
        {preview ? (
          <ModelBadge text={preview} color={activeColor} className="text-xs" />
        ) : (
          <span className="text-xs text-muted-foreground">输入文字后预览</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {MODEL_BADGE_COLOR_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            title={opt.label}
            onClick={() => onColorChange(opt.key)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full ring-2 ring-offset-1 ring-offset-background transition",
              opt.swatch,
              activeColor === opt.key
                ? "ring-foreground"
                : "ring-transparent hover:ring-border",
            )}
          />
        ))}
      </div>
    </div>
  )
}
