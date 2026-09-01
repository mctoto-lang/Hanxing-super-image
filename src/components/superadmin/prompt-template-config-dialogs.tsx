"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { TemplateVarChips } from "@/components/superadmin/template-var-chips"
import {
  createPromptTemplateConfigAction,
  togglePromptTemplateConfigActiveAction,
  updatePromptTemplateConfigAction,
} from "@/server/actions/platform-product-config"
import { PRODUCT_PROMPT_SCENES } from "@/db/schema"
import { SCENE_TEMPLATE_VARS } from "@/lib/product/prompt-vars"
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_SCENE_LABELS,
  PROMPT_SCENE_NOTES,
} from "@/lib/product/prompt-defaults"
import {
  PRODUCT_ONLY_PROMPT_SCENES,
  WEARTRY_DEFAULT_PROMPT_TEMPLATES,
  WEARTRY_PROMPT_SCENE_LABELS,
  WEARTRY_PROMPT_SCENE_NOTES,
  WEARTRY_PROMPT_SCENES,
} from "@/lib/weartry/prompt-defaults"
import { WEARTRY_SCENE_TEMPLATE_VARS } from "@/lib/weartry/prompt-vars"

/** 配置中心归属：商品图片 / 穿戴图片（场景清单与默认值按端隔离，互不可见） */
export type PromptConfigVariant = "product" | "weartry"

/** 按端取场景清单 / 标签 / 默认模板 / 说明 / 变量注册表 */
function getVariantMaps(variant: PromptConfigVariant) {
  if (variant === "weartry") {
    return {
      scenes: WEARTRY_PROMPT_SCENES,
      labels: WEARTRY_PROMPT_SCENE_LABELS,
      defaults: WEARTRY_DEFAULT_PROMPT_TEMPLATES,
      notes: WEARTRY_PROMPT_SCENE_NOTES,
      vars: WEARTRY_SCENE_TEMPLATE_VARS,
    }
  }
  return {
    scenes: PRODUCT_ONLY_PROMPT_SCENES,
    labels: PROMPT_SCENE_LABELS,
    defaults: DEFAULT_PROMPT_TEMPLATES,
    notes: PROMPT_SCENE_NOTES,
    vars: SCENE_TEMPLATE_VARS,
  }
}

/** 提示词模板行（编辑回填用） */
export interface PromptTemplateConfigRow {
  id: string
  scene: string
  name: string
  template: string
  note: string | null
  sortOrder: number
  isActive: boolean
}

function PromptTemplateForm({
  row,
  onDone,
  variant = "product",
}: {
  row: PromptTemplateConfigRow | null
  onDone: () => void
  variant?: PromptConfigVariant
}) {
  const maps = getVariantMaps(variant)
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [scene, setScene] = useState<string>(row?.scene ?? "")
  const [name, setName] = useState(row?.name ?? "")
  const [template, setTemplate] = useState(row?.template ?? "")
  const [note, setNote] = useState(row?.note ?? "")
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 99)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const sceneNote = scene ? row?.note || maps.notes[scene] || "" : ""
  const sceneVars = scene ? (maps.vars[scene] ?? []) : []
  const isCustomScene = row !== null

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        name,
        template,
        note: note || undefined,
        sortOrder,
      }
      const res = row
        ? await updatePromptTemplateConfigAction(row.id, base)
        : await createPromptTemplateConfigAction({
            ...base,
            scene: scene as (typeof PRODUCT_PROMPT_SCENES)[number],
          })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(row ? "模板已更新" : "模板已创建")
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  /** 恢复内置默认模板（seed 同源） */
  const resetToDefault = () => {
    if (scene && maps.defaults[scene]) {
      setTemplate(maps.defaults[scene]!)
      toast.info("已填入内置默认模板，保存后生效")
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>场景（scene）</Label>
          {isCustomScene ? (
            <Input value={maps.labels[scene] ?? scene} disabled />
          ) : (
            <select
              value={scene}
              onChange={(e) => {
                setScene(e.target.value)
                setName(maps.labels[e.target.value] ?? e.target.value)
                if (maps.defaults[e.target.value]) {
                  setTemplate(maps.defaults[e.target.value]!)
                }
              }}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
            >
              <option value="">选择场景…</option>
              {maps.scenes.map((s) => (
                <option key={s} value={s}>
                  {maps.labels[s] ?? s}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>模板名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="套图 AI 帮写" />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>提示词模板</Label>
          {scene && maps.defaults[scene] && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={resetToDefault}
            >
              <RotateCcw className="mr-1 size-3" />
              恢复默认
            </Button>
          )}
        </div>
        <Textarea
          ref={textareaRef}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={10}
          className="field-sizing-fixed font-mono text-xs"
          placeholder="模板正文，支持 {{platformLabel}} 等变量；未引用的变量不注入"
        />
        <TemplateVarChips
          vars={sceneVars}
          template={template}
          textareaRef={textareaRef}
          onTemplateChange={setTemplate}
        />
        <p className="text-xs text-muted-foreground">
          {sceneNote || "选择场景后显示可用变量说明"}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>变量说明（note）</Label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="留空使用内置说明"
          />
        </div>
        <div className="space-y-1.5">
          <Label>排序</Label>
          <Input
            type="number"
            min={0}
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button onClick={submit} disabled={submitting || !scene}>
          {submitting && <MorphingInfinity className="mr-1 size-4" />}
          保存
        </Button>
      </div>
    </div>
  )
}

/** 新增模板（补建缺失场景） */
export function PromptTemplateFormDialog({
  variant = "product",
}: {
  variant?: PromptConfigVariant
} = {}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增模板
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle>新增提示词模板</DialogTitle>
          <DialogDescription>
            为缺失场景补建模板（内置默认已覆盖全部场景，通常只需编辑现有行）
          </DialogDescription>
          <PromptTemplateForm
            row={null}
            onDone={() => setOpen(false)}
            variant={variant}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑模板 */
export function PromptTemplateEditButton({
  row,
  variant = "product",
}: {
  row: PromptTemplateConfigRow
  variant?: PromptConfigVariant
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle>编辑模板：{row.name}</DialogTitle>
          <DialogDescription>scene: {row.scene}</DialogDescription>
          <PromptTemplateForm
            row={row}
            onDone={() => setOpen(false)}
            variant={variant}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用模板（停用后运行时回退内置默认） */
export function PromptTemplateToggleActiveButton({
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
          const res = await togglePromptTemplateConfigActiveAction(id)
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
