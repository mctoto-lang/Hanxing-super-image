"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { ModelSizePreset } from "@/db/schema"
import { DEFAULT_SIZE_PRESETS, gcdRatio } from "@/lib/image-sizes"
import { RatioIcon, nextIconStyle } from "@/components/model-form/ratio-icon"

/**
 * 尺寸预设编辑器（可增删行）
 *
 * 每行配置：启用开关、展示比例（ratio，如 16:9；留空由宽高归约推导）、
 * 实际宽高（px，比例协议模型在适配器内换算为比例参数，宽高用于图标与
 * 提交白名单）、图标样式（点击预览循环切换：描边框 → 实底块 → 形状图标，
 * 预置样式不可上传）。
 * ratio 为终端用户看到的比例文字；关闭的行用户端置灰不可选、不计入白名单。
 */
export function SizePresetsEditor({
  value,
  onChange,
  /** 比例协议提示（Gemini 官方 / Midjourney 等只按比例生图时展示） */
  ratioOnlyHint,
}: {
  value: ModelSizePreset[]
  onChange: (v: ModelSizePreset[]) => void
  ratioOnlyHint?: string
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
  function addRow() {
    onChange([
      ...rows,
      { ratio: "", width: 1024, height: 1024, icon: "outline", enabled: true },
    ])
  }
  function removeRow(i: number) {
    onChange(rows.filter((_, idx) => idx !== i))
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
          onClick={addRow}
        >
          <Plus className="size-3.5" /> 添加比例
        </Button>
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
        const derivedRatio = gcdRatio(Number(preset.width), Number(preset.height))
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
              aria-label="启用该比例"
            />
            <button
              type="button"
              title="点击切换图标样式：描边框 / 实底块 / 形状图标"
              onClick={() => update(i, { icon: nextIconStyle(preset.icon) })}
              className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <RatioIcon
                size={{ width: Number(preset.width), height: Number(preset.height) }}
                icon={preset.icon ?? "outline"}
                boxSize={22}
              />
            </button>
            <Input
              value={preset.ratio ?? ""}
              onChange={(e) => update(i, { ratio: e.target.value })}
              maxLength={20}
              disabled={!enabled}
              className="h-8 w-20 shrink-0 text-sm tabular-nums"
              placeholder={derivedRatio || "W:H"}
              aria-label="展示比例"
            />
            <Input
              type="number"
              min={1}
              value={preset.width}
              onChange={(e) => update(i, { width: Number(e.target.value) || 0 })}
              disabled={!enabled}
              className="h-8 w-full text-sm tabular-nums"
              placeholder="宽"
              aria-label="宽度 px"
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
              aria-label="高度 px"
            />
            <span className="shrink-0 text-[11px] text-muted-foreground">px</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeRow(i)}
              disabled={rows.length <= 1}
              aria-label="删除该比例"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )
      })}

      <p className="text-xs text-muted-foreground">
        比例（如「16:9」）展示给用户、留空自动按宽高归约；宽高（px）为实际请求尺寸{ratioOnlyHint ? `；${ratioOnlyHint}` : "；点击左侧图标可切换预置图标样式"}。关闭的比例用户端将置灰不可选。
      </p>
    </div>
  )
}
