"use client"

import { Check } from "lucide-react"
import { Label } from "@/components/ui/label"
import {
  ColorPicker,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
} from "@/components/ui/color-picker"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
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
  nearestColorName,
  rgbToHsb,
} from "@/lib/color/convert"

/** 当前选中色（hsb/rgb 展示值由 hex 推导） */
export interface SelectedColor {
  name: string
  hex: string
}

/**
 * 可视化选色器：常用服装色库预设 + SV 选色面板（弹窗内含色相滑杆与
 * HEX/RGB/HSB 格式切换输入）+ 图片取色（上传图片后在图上吸取像素色）。
 * 自定义色的名称自动匹配最近色库名（提示词注入用）。
 */
export function ColorPickerField({
  value,
  onChange,
}: {
  value: SelectedColor
  onChange: (next: SelectedColor) => void
}) {
  const rgb = hexToRgb(value.hex)
  const hsb = rgb ? rgbToHsb(rgb) : null

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

      {/* 自定义：选色弹窗 + 图片取色 */}
      <div className="space-y-2 rounded-lg border p-2.5">
        <Label className="text-xs">自定义颜色</Label>

        <div className="flex items-center gap-2">
          {/* SV 选色面板 + 色相滑杆 + 格式输入（点击展开弹窗） */}
          <Popover>
            <PopoverTrigger
              aria-label="打开取色面板"
              title="打开取色面板"
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-transparent px-2 text-xs transition-colors hover:bg-accent/50"
            >
              <span
                className="size-4 shrink-0 rounded-[4px] border border-black/10"
                style={{ backgroundColor: value.hex }}
              />
              <span className="truncate font-mono uppercase">{value.hex}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 gap-2">
              <ColorPicker value={value.hex} onChange={applyHex}>
                <ColorPickerSelection />
                <ColorPickerHue />
                <div className="flex items-center gap-2">
                  <ColorPickerOutput />
                  <ColorPickerFormat />
                </div>
              </ColorPicker>
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-medium">{value.name}</span>
                <span className="font-mono text-muted-foreground">
                  {value.hex}
                </span>
              </div>
            </PopoverContent>
          </Popover>
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
