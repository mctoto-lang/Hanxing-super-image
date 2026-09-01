"use client"

import * as React from "react"
import { FileUp, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ExternalLayerNode } from "@/lib/mockup/client"
import type { MockupBindingDef } from "@/db/schema"
import { saveTemplateBindingsAction } from "@/server/actions/mockup"

/**
 * 小模板绑定编辑器（模板管理内：PSD 上传后配置 / 编辑既有绑定）
 *
 * 左列 = PSD 解析出的图层树（缩进展平），勾选 smartObject/pixel/text 图层
 * 作为可替换绑定；右列 = 必填开关、显示名、图片适配模式。保存即发布新版本。
 */

const FIT_OPTIONS: { value: MockupBindingDef["fit"]; label: string }[] = [
  { value: "stretch", label: "拉伸" },
  { value: "cover", label: "覆盖" },
  { value: "contain", label: "包含" },
]

interface FlatLayer {
  layerId: number
  layerPath: string
  name: string
  type: string
  depth: number
  bindable: boolean
  defaultText?: string
}

function flattenLayerTree(nodes: ExternalLayerNode[]): FlatLayer[] {
  const out: FlatLayer[] = []
  const walk = (list: ExternalLayerNode[], depth: number) => {
    for (const n of list) {
      out.push({
        layerId: n.layerId,
        layerPath: n.layerPath,
        name: n.name,
        type: n.type,
        depth,
        bindable: ["smartObject", "text", "pixel"].includes(n.type),
        defaultText: n.defaultText,
      })
      if (n.children?.length) walk(n.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

interface EditorRow extends FlatLayer {
  /** 行唯一标识（展平序号）。解析器给出的 layerId 可能重复（实测多个文字层
   *  同为 0），不能作为 key / bindingId 生成依据 */
  uid: number
  /** 保存时使用的绑定 ID（匹配到既有绑定则沿用，否则按序号生成保证唯一） */
  bindingId: string
  checked: boolean
  label: string
  required: boolean
  fit: MockupBindingDef["fit"]
}

interface BindingEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  templateId: string | null
  templateName: string
  layerTree: ExternalLayerNode[]
  initialBindings: MockupBindingDef[]
  onSaved: () => void
}

export function BindingEditorDialog({
  open,
  onOpenChange,
  templateId,
  templateName,
  layerTree,
  initialBindings,
  onSaved,
}: BindingEditorDialogProps) {
  const [rows, setRows] = React.useState<EditorRow[]>([])
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    // 既有绑定按 layerPath 匹配（layerId 可能重复，路径才是稳定定位）
    const existing = new Map(initialBindings.map((b) => [b.layerPath, b]))
    const hasExisting = initialBindings.length > 0
    const layers = flattenLayerTree(layerTree)
    setRows(
      layers.map((l, idx) => {
        const prev = existing.get(l.layerPath)
        // 无既有绑定时自动勾选智能对象与文字图层（最常见诉求），
        // 像素图层（可能是背景）默认不勾，由管理员手动加
        const autoCheck = !hasExisting && (l.type === "smartObject" || l.type === "text")
        return {
          ...l,
          uid: idx,
          bindingId: prev?.bindingId ?? `b${idx}`,
          checked: prev != null ? true : autoCheck,
          label: prev?.label ?? l.name,
          required: prev?.required ?? true,
          fit: prev?.fit ?? "stretch",
        }
      }),
    )
  }, [open, layerTree, initialBindings])

  const toggleRow = (uid: number, checked: boolean) => {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, checked: checked } : r)),
    )
  }

  const patchRow = (uid: number, patch: Partial<EditorRow>) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)))
  }

  const handleSave = async () => {
    if (!templateId) return
    const bindings: MockupBindingDef[] = rows
      .filter((r) => r.checked)
      .map((r) => ({
        bindingId: r.bindingId,
        layerId: r.layerId,
        layerPath: r.layerPath,
        type: r.type as MockupBindingDef["type"],
        required: r.required,
        label: r.label || r.name,
        fit: r.fit,
      }))
    // bindingId 必须唯一（外部服务按它映射替换值）
    if (new Set(bindings.map((b) => b.bindingId)).size !== bindings.length) {
      toast.error("绑定 ID 冲突，请重新打开编辑器重试")
      return
    }
    if (bindings.length === 0) {
      toast.error("请至少勾选 1 个可替换图层")
      return
    }
    setSaving(true)
    try {
      const res = await saveTemplateBindingsAction({
        templateId,
        bindings,
        publish: true,
      })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success("绑定已保存并发布")
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const checkedCount = rows.filter((r) => r.checked).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            <FileUp className="mr-1 inline size-4" />
            编辑绑定 · {templateName}
          </DialogTitle>
          <DialogDescription>
            勾选作为「可替换」的图层（智能对象/像素图层替换图片，文字图层替换文字）；
            保存后自动发布为新版本。已勾选 {checkedCount} 个。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-1.5 overflow-y-auto">
          {rows.map((r) => (
            <div
              key={r.uid}
              className={`flex items-center gap-2 rounded-lg border p-2 ${
                r.checked ? "border-primary/50" : ""
              } ${r.bindable ? "" : "opacity-50"}`}
              style={{ paddingLeft: `${r.depth * 14 + 8}px` }}
            >
              {r.bindable ? (
                <Checkbox
                  checked={r.checked}
                  onCheckedChange={(v) => toggleRow(r.uid, v === true)}
                />
              ) : (
                <span className="w-4" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm" title={r.layerPath}>
                {r.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {r.type === "smartObject"
                    ? "智能对象"
                    : r.type === "text"
                      ? "文字"
                      : r.type === "pixel"
                        ? "像素"
                        : r.type === "group"
                          ? "图层组"
                          : r.type}
                </span>
              </span>

              {r.bindable && r.checked ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Input
                    value={r.label}
                    onChange={(e) => patchRow(r.uid, { label: e.target.value })}
                    placeholder="显示名"
                    className="h-7 w-24 text-xs"
                  />
                  {r.type !== "text" ? (
                    <Select
                      value={r.fit}
                      onValueChange={(v) =>
                        patchRow(r.uid, { fit: v as EditorRow["fit"] })
                      }
                    >
                      <SelectTrigger className="h-7 w-[72px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Checkbox
                      checked={r.required}
                      onCheckedChange={(v) =>
                        patchRow(r.uid, { required: v === true })
                      }
                    />
                    必填
                  </label>
                </div>
              ) : null}
            </div>
          ))}
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              图层树为空（PSD 无图层或解析失败）
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={saving || !templateId}
            onClick={() => void handleSave()}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存并发布
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
