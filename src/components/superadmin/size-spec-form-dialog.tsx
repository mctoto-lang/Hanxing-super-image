"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createSizeSpecAction,
  toggleSizeSpecActiveAction,
  updateSizeSpecAction,
} from "@/server/actions/platform-product"
import { PLATFORMS, PRODUCT_MODE_LABELS } from "@/lib/product/dictionaries"

export interface SizeSpecRow {
  id: string
  platformKey: string
  label: string
  width: number
  height: number
  ratioLabel: string | null
  note: string | null
  appliesTo: string[]
  sortOrder: number
  isActive: boolean
}

function SizeSpecForm({ row, onDone }: { row: SizeSpecRow | null; onDone: () => void }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [platformKey, setPlatformKey] = useState(row?.platformKey ?? "amazon")
  const [label, setLabel] = useState(row?.label ?? "")
  const [width, setWidth] = useState(row?.width ?? 970)
  const [height, setHeight] = useState(row?.height ?? 600)
  const [ratioLabel, setRatioLabel] = useState(row?.ratioLabel ?? "")
  const [note, setNote] = useState(row?.note ?? "")
  const [appliesTo, setAppliesTo] = useState<string[]>(row?.appliesTo ?? ["detail"])
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 99)

  const toggleScope = (scope: string) => {
    setAppliesTo((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    )
  }

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        platformKey,
        label,
        width,
        height,
        ratioLabel: ratioLabel || undefined,
        note: note || undefined,
        appliesTo: appliesTo as ("suite" | "detail")[],
        sortOrder,
      }
      const res = row
        ? await updateSizeSpecAction(row.id, base)
        : await createSizeSpecAction(base)
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(row ? "规范已更新" : "规范已创建")
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>平台</Label>
          <Select
            value={platformKey}
            onValueChange={(v) => setPlatformKey(v ?? "amazon")}
            items={PLATFORMS}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {PLATFORMS.find((p) => p.value === platformKey)?.label ?? platformKey}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>尺寸名称</Label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="高级A+（Web端）"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>宽（px）</Label>
          <Input
            type="number"
            min={64}
            max={8192}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value) || 970)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>高（px）</Label>
          <Input
            type="number"
            min={64}
            max={8192}
            value={height}
            onChange={(e) => setHeight(Number(e.target.value) || 600)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>比例文案</Label>
          <Input
            value={ratioLabel}
            onChange={(e) => setRatioLabel(e.target.value)}
            placeholder="长图 / 4:3"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>规范说明</Label>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Premium A+ 桌面端全宽模块（1464px 宽）"
        />
      </div>
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <Label>适用子功能</Label>
          {(["suite", "detail"] as const).map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={appliesTo.includes(s)}
                onCheckedChange={() => toggleScope(s)}
              />
              {PRODUCT_MODE_LABELS[s]}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Label>排序</Label>
          <Input
            type="number"
            min={0}
            className="w-20"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button onClick={submit} disabled={submitting}>
          {submitting && <MorphingInfinity className="mr-1 size-4" />}
          保存
        </Button>
      </DialogFooter>
    </div>
  )
}

/** 新增尺寸规范 */
export function SizeSpecFormDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增规范
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新增尺寸规范</DialogTitle>
          <DialogDescription>
            平台有具体尺寸规范的场景（如 Amazon A+ 模块尺寸）
          </DialogDescription>
          <SizeSpecForm row={null} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑尺寸规范 */
export function SizeSpecEditButton({ row }: { row: SizeSpecRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>编辑规范：{row.label}</DialogTitle>
          <DialogDescription>平台：{row.platformKey}</DialogDescription>
          <SizeSpecForm row={row} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用 */
export function SizeSpecToggleActiveButton({
  id,
  isActive,
}: {
  id: string
  isActive: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={loading}
      onClick={async () => {
        setLoading(true)
        try {
          const res = await toggleSizeSpecActiveAction(id)
          if (!res.ok) {
            toast.error(res.error ?? "操作失败")
            return
          }
          router.refresh()
        } finally {
          setLoading(false)
        }
      }}
    >
      <Power className="mr-1 size-3.5" />
      {isActive ? "停用" : "启用"}
    </Button>
  )
}
