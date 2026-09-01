"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { ModelSizePreset } from "@/db/schema"
import { DEFAULT_SIZE_PRESETS } from "@/lib/image-sizes"

/**
 * 尺寸预设编辑器
 *
 * 每个比例可独立：命名(label)、开启/关闭(enabled)、实际宽高。
 * 比例名称直接展示给终端用户（创作页/商品主图的比例选择文字）。
 * 关闭的比例在用户端置灰不可选、且不计入提交尺寸白名单。
 */
export function SizePresetsEditor({
  value,
  onChange,
}: {
  value: ModelSizePreset[]
  onChange: (v: ModelSizePreset[]) => void
}) {
  // 空值（新建模型）时以默认 8 项初始化，仅回写一次
  const initialized = React.useRef(false)
  React.useEffect(() => {
    if (!initialized.current && value.length === 0) {
      initialized.current = true
      onChange(DEFAULT_SIZE_PRESETS.map((p) => ({ ...p })))
    }
  }, [value, onChange])

  const rows = value.length > 0 ? value : DEFAULT_SIZE_PRESETS

  function update(i: number, patch: Partial<ModelSizePreset>) {
    onChange(rows.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  }
  function setAllEnabled(enabled: boolean) {
    onChange(rows.map((p) => ({ ...p, enabled })))
  }
  function resetDefault() {
    onChange(DEFAULT_SIZE_PRESETS.map((p) => ({ ...p })))
    initialized.current = true
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => setAllEnabled(true)}
        >
          全部开启
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => setAllEnabled(false)}
        >
          全部关闭
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={resetDefault}
        >
          恢复默认
        </Button>
      </div>

      {rows.map((preset, i) => {
        const enabled = preset.enabled !== false
        return (
          <div
            key={i}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2 py-1.5",
              !enabled && "opacity-60",
            )}
          >
            <Switch
              checked={enabled}
              onCheckedChange={(v) => update(i, { enabled: v })}
            />
            <RatioPreview width={preset.width} height={preset.height} />
            <Input
              value={preset.label}
              onChange={(e) => update(i, { label: e.target.value })}
              maxLength={20}
              disabled={!enabled}
              className="h-8 w-28 shrink-0 text-sm"
              placeholder="比例名称"
            />
            <Input
              type="number"
              min={1}
              value={preset.width}
              onChange={(e) => update(i, { width: Number(e.target.value) || 0 })}
              disabled={!enabled}
              className="h-8 w-full text-sm tabular-nums"
              placeholder="宽"
            />
            <span className="text-muted-foreground">×</span>
            <Input
              type="number"
              min={1}
              value={preset.height}
              onChange={(e) => update(i, { height: Number(e.target.value) || 0 })}
              disabled={!enabled}
              className="h-8 w-full text-sm tabular-nums"
              placeholder="高"
            />
            <span className="text-[11px] text-muted-foreground">px</span>
          </div>
        )
      })}

      <p className="text-xs text-muted-foreground">
        比例名称将展示给用户（如「方形 1:1」「竖版 3:4」），可自定义命名；关闭的比例用户端将置灰不可选。
      </p>
    </div>
  )
}

/** 按宽高比绘制小比例示意图标 */
function RatioPreview({
  width,
  height,
}: {
  width: number
  height: number
}) {
  const max = 22
  const w = Number(width)
  const h = Number(height)
  let dw: number, dh: number
  if (w > 0 && h > 0) {
    const ratio = w / h
    if (ratio >= 1) {
      dw = max
      dh = Math.max(6, Math.round(max / ratio))
    } else {
      dh = max
      dw = Math.max(6, Math.round(max * ratio))
    }
  } else {
    dw = max
    dh = max
  }
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center")}
      style={{ width: max, height: max }}
    >
      <span
        className="block rounded-[3px] border-2 border-current opacity-70 text-muted-foreground"
        style={{ width: dw, height: dh }}
      />
    </span>
  )
}
