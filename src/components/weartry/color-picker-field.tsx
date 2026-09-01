"use client"

import { useEffect, useState } from "react"
import { Check } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { ImageEyedropperButton } from "./image-eyedropper"
import {
  COLOR_LIBRARY,
  COLOR_LIBRARY_FLAT,
} from "@/lib/weartry/dictionaries"
import {
  formatHsb,
  formatRgb,
  hexToRgb,
  hsbToRgb,
  nearestColorName,
  parseHsb,
  parseRgb,
  rgbToHex,
  rgbToHsb,
} from "@/lib/color/convert"

/** 当前选中色（hsb/rgb 展示值由 hex 推导） */
export interface SelectedColor {
  name: string
  hex: string
}

type InputMode = "hex" | "hsb" | "rgb"

/**
 * 可视化选色器：常用服装色库预设 + HEX/HSB/RGB 三模式自定义输入 + 原生
 * 取色器 + 图片取色（上传图片后在图上吸取像素色）。
 * 自定义色的名称自动匹配最近色库名（提示词注入用）。
 */
export function ColorPickerField({
  value,
  onChange,
}: {
  value: SelectedColor
  onChange: (next: SelectedColor) => void
}) {
  const [mode, setMode] = useState<InputMode>("hex")
  const [hexDraft, setHexDraft] = useState(value.hex)
  const [hsbDraft, setHsbDraft] = useState("")
  const [rgbDraft, setRgbDraft] = useState("")

  const rgb = hexToRgb(value.hex)
  const hsb = rgb ? rgbToHsb(rgb) : null

  // 外部变更（色库点选/最近使用回选）→ 同步草稿
  useEffect(() => {
    setHexDraft(value.hex)
    setHsbDraft(hsb ? formatHsb(hsb) : "")
    setRgbDraft(rgb ? formatRgb(rgb) : "")
  }, [value.hex]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyHex = (hex: string, name?: string) => {
    const nextName =
      name ?? nearestColorName(hex, COLOR_LIBRARY_FLAT) ?? "自定义色"
    onChange({ name: nextName, hex })
  }

  return (
    <div className="space-y-3">
      {/* 常用服装色库（分组 swatch） */}
      <div className="space-y-2">
        {COLOR_LIBRARY.map((group) => (
          <div key={group.group} className="space-y-1">
            <p className="text-[11px] text-muted-foreground">{group.group}</p>
            <div className="flex flex-wrap gap-1.5">
              {group.colors.map((c) => {
                const active = value.hex.toUpperCase() === c.hex.toUpperCase()
                return (
                  <button
                    key={c.hex}
                    type="button"
                    title={`${c.name} ${c.hex}`}
                    onClick={() => applyHex(c.hex, c.name)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md border transition-transform hover:scale-110",
                      active ? "ring-2 ring-primary ring-offset-1" : "",
                    )}
                    style={{ backgroundColor: c.hex }}
                  >
                    {active && (
                      <Check
                        className={cn(
                          "size-3.5",
                          // 深色背景用白勾、浅色用黑勾
                          isLightColor(c.hex) ? "text-black/70" : "text-white",
                        )}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 自定义：模式切换 + 输入 + 原生取色器 */}
      <div className="space-y-2 rounded-lg border p-2.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">自定义颜色</Label>
          <div className="flex rounded-md border p-0.5 text-[11px]">
            {(["hex", "hsb", "rgb"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-2 py-0.5 uppercase transition-colors",
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="取色器"
            value={value.hex}
            onChange={(e) => applyHex(e.target.value)}
            className="size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
          />
          {mode === "hex" && (
            <Input
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={() => {
                const next = hexDraft.trim().replace(/^#/, "")
                if (/^[0-9a-fA-F]{6}$/.test(next)) applyHex(`#${next}`)
                else setHexDraft(value.hex)
              }}
              placeholder="#1F2A44"
              className="h-8 font-mono text-xs uppercase"
            />
          )}
          {mode === "hsb" && (
            <Input
              value={hsbDraft}
              onChange={(e) => {
                setHsbDraft(e.target.value)
                const parsed = parseHsb(e.target.value)
                if (parsed) applyHex(rgbToHex(hsbToRgb(parsed)))
              }}
              placeholder="231, 55, 27"
              className="h-8 font-mono text-xs"
            />
          )}
          {mode === "rgb" && (
            <Input
              value={rgbDraft}
              onChange={(e) => {
                setRgbDraft(e.target.value)
                const parsed = parseRgb(e.target.value)
                if (parsed) applyHex(rgbToHex(parsed))
              }}
              placeholder="31, 42, 68"
              className="h-8 font-mono text-xs"
            />
          )}
          {/* 图片取色：上传一张图片后在图上吸取像素色（仅本地读取） */}
          <ImageEyedropperButton onPick={applyHex} />
        </div>

        {/* 当前色信息（名称 + 三种色值，注入提示词同名） */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
            {value.name}
          </span>
          <span className="font-mono">{value.hex}</span>
          {hsb && <span className="font-mono">HSB {formatHsb(hsb)}</span>}
          {rgb && <span className="font-mono">RGB {formatRgb(rgb)}</span>}
        </div>
      </div>
    </div>
  )
}

/** 背景是否偏浅（勾选图标配色用） */
function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex)
  if (!rgb) return false
  return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 > 160
}
