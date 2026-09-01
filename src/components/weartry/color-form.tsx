"use client"

import { useEffect, useState } from "react"
import { Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { ReferenceImageUpload } from "@/components/product/reference-image-upload"
import {
  generateWeartryColorAction,
  type GenerateWeartryResult,
} from "@/server/actions/weartry"
import type { WeartryModelRow } from "@/lib/weartry/types"
import {
  COLOR_LIBRARY_FLAT,
  RECENT_COLORS_MAX,
  RECENT_COLORS_STORAGE_KEY,
  type RecentColorEntry,
} from "@/lib/weartry/dictionaries"
import { pushRecentColor } from "@/lib/weartry/prompt"
import { formatHsb, formatRgb, hexToRgb, rgbToHsb } from "@/lib/color/convert"
import { cn } from "@/lib/utils"
import {
  ColorPickerField,
  type SelectedColor,
} from "./color-picker-field"
import { ModelRatioSelects, unitCostOf } from "./model-ratio-selects"

/** 读取最近使用颜色（本地缓存；解析失败静默忽略） */
function loadRecentColors(): RecentColorEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RecentColorEntry[]) : []
  } catch {
    return []
  }
}

/**
 * AI换色表单
 *
 * 区块：① 上传图片 ② 选色器（色库 + RGB/HEX/CMYK + 最近 5 色本地缓存）
 * ③ 换色部位 ④ 补充要求 ⑤ 图片模型/比例 ⑥ 生成按钮（提示词注入）。
 */
export function ColorForm({
  models,
  creditsBalance,
  submitting,
  onSubmit,
}: {
  models: WeartryModelRow[]
  creditsBalance: number
  submitting: boolean
  onSubmit: (run: () => Promise<GenerateWeartryResult>) => void
}) {
  const [referenceImage, setReferenceImage] = useState<string | null>(null)
  const [color, setColor] = useState<SelectedColor>({
    name: COLOR_LIBRARY_FLAT[4]!.name,
    hex: COLOR_LIBRARY_FLAT[4]!.hex,
  })
  const [part, setPart] = useState("")
  const [additionalPrompt, setAdditionalPrompt] = useState("")
  const [modelId, setModelId] = useState<string | null>(models[0]?.id ?? null)
  const [size, setSize] = useState<string | null>(null)
  const [recentColors, setRecentColors] = useState<RecentColorEntry[]>([])

  // 挂载后读取本地缓存的最近使用颜色
  useEffect(() => {
    setRecentColors(loadRecentColors())
  }, [])

  const unitCost = unitCostOf(models, modelId)

  const trySubmit = () => {
    if (!referenceImage) return toast.error("请上传图片")
    if (!part.trim()) return toast.error("请填写换色部位")
    if (creditsBalance < unitCost)
      return toast.error(
        `个人配额不足，还需 ${unitCost - creditsBalance} 积分，请联系管理员分配`,
      )
    const rgb = hexToRgb(color.hex)!
    const hsb = rgbToHsb(rgb)
    // 记录最近使用颜色（本地缓存，去重保留最近 5 条）
    const next = pushRecentColor(
      recentColors,
      {
        name: color.name,
        hex: color.hex,
        hsb: formatHsb(hsb),
      },
      RECENT_COLORS_MAX,
    )
    setRecentColors(next)
    try {
      localStorage.setItem(RECENT_COLORS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式等场景写入失败不阻断生成
    }

    onSubmit(() =>
      generateWeartryColorAction({
        modelId: modelId!,
        size: size ?? undefined,
        referenceImage,
        part: part.trim(),
        colorName: color.name,
        colorHex: color.hex,
        colorHsb: formatHsb(hsb),
        colorRgb: formatRgb(rgb),
        additionalPrompt: additionalPrompt.trim() || undefined,
      }),
    )
  }

  return (
    <>
      {/* ① 上传图片 */}
      <div className="space-y-2">
        <Label>
          上传图片
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            支持 1 张，待换色的服装图
          </span>
        </Label>
        <ReferenceImageUpload
          images={referenceImage ? [referenceImage] : []}
          onChange={(imgs) => setReferenceImage(imgs[0] ?? null)}
          maxImages={1}
        />
      </div>

      {/* ② 图片模型 / 图片比例 */}
      <ModelRatioSelects
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        size={size}
        onSizeChange={setSize}
      />

      {/* ③ 选色器 */}
      <div className="space-y-2">
        <Label>选择颜色</Label>
        <ColorPickerField value={color} onChange={setColor} />

        {/* 最近使用（浏览器本地缓存，最近 5 个） */}
        {recentColors.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">最近使用</p>
            <div className="flex flex-wrap gap-1.5">
              {recentColors.map((c, i) => {
                const active =
                  color.hex.toUpperCase() === c.hex.toUpperCase()
                return (
                  <button
                    key={`${c.hex}-${i}`}
                    type="button"
                    title={`${c.name} ${c.hex}`}
                    onClick={() =>
                      setColor({ name: c.name, hex: c.hex })
                    }
                    className={cn(
                      "flex h-7 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors",
                      active
                        ? "border-primary bg-primary/5 text-foreground"
                        : "text-muted-foreground hover:border-primary/40",
                    )}
                  >
                    <span
                      className="size-4 rounded border"
                      style={{ backgroundColor: c.hex }}
                    />
                    <span className="max-w-14 truncate">{c.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ④ 换色部位 */}
      <div className="space-y-1.5">
        <Label>换色部位</Label>
        <Input
          value={part}
          onChange={(e) => setPart(e.target.value)}
          placeholder="如：上衣主体、裙摆、领口、口袋…"
        />
        <p className="text-xs text-muted-foreground">
          描述要换色的部位，其余区域保持不变
        </p>
      </div>

      {/* ⑤ 补充要求 */}
      <div className="space-y-2">
        <Label>补充要求</Label>
        <Textarea
          value={additionalPrompt}
          onChange={(e) => setAdditionalPrompt(e.target.value)}
          placeholder="补充要求（可选），如：同时把纽扣换成同色系…"
          rows={3}
          className="text-sm"
        />
      </div>

      {/* ⑥ 生成 */}
      <div className="border-t pt-3">
        <Button className="w-full" onClick={trySubmit} disabled={submitting}>
          {submitting ? (
            <MorphingInfinity className="mr-1 size-4" />
          ) : (
            <Wand2 className="mr-1 size-4" />
          )}
          开始换色（{unitCost}积分）
        </Button>
        {/* 色块预览（提交前的当前选择） */}
        <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className="size-4 rounded border"
            style={{ backgroundColor: color.hex }}
            aria-hidden
          />
          {color.name} · {color.hex}
        </div>
      </div>
    </>
  )
}
