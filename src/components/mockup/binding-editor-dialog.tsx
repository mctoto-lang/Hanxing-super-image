"use client"

import * as React from "react"
import { FileUp, Loader2, Trash2, Type } from "lucide-react"
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  ExternalFont,
  ExternalLayerNode,
} from "@/lib/mockup/client"
import { MAX_FONT_UPLOAD_BYTES } from "@/lib/mockup/limits"
import type { MockupBindingDef } from "@/db/schema"
import {
  listMockupFontsAction,
  saveTemplateBindingsAction,
  setExternalTemplateVisibilityAction,
} from "@/server/actions/mockup"

/**
 * 小模板绑定编辑器（模板管理内：PSD 上传后配置 / 编辑既有绑定）
 *
 * 左列 = PSD 解析出的图层树（缩进展平），勾选 smartObject/pixel/text 图层
 * 作为可替换绑定；右列 = 必填开关、显示名、图片适配模式、背景标记。
 * 保存即发布新版本；背景标记存本地扩展表（快照与批量替换页识别用）。
 * 已发布版本的结构外部不可改：仅调整背景标记时服务端跳过外部保存，
 * 只落本地扩展表（绑定结构有变则提示需重新上传 PSD）。
 */

const FIT_OPTIONS: { value: MockupBindingDef["fit"]; label: string }[] = [
  { value: "stretch", label: "拉伸" },
  { value: "cover", label: "覆盖" },
  { value: "contain", label: "包含" },
]

/** 图片适配模式完整说明（悬停 Tooltip 显示，语义与 PS-API 渲染预处理一致） */
const FIT_DESCRIPTIONS: Record<MockupBindingDef["fit"], string> = {
  stretch: "拉伸：强制缩放到目标尺寸，图片完整显示，但比例可能变形",
  cover: "覆盖：等比缩放铺满目标区域并裁掉超出部分，不变形但可能裁剪边缘",
  contain: "包含：等比缩放完整放入目标区域，不变形不裁剪，留白处填充白色",
}

/** 图层名启发式：像素/智能对象图层名含「背景/bg/background」默认标记为背景 */
const BACKGROUND_NAME_RE = /(背景|background|^bg$)/i

/** 字体下拉显示名：家族名 + 样式（非 Regular 时） */
function fontLabel(f: ExternalFont | undefined): string {
  if (!f) return "字体：默认"
  return f.style && f.style !== "Regular"
    ? `${f.familyName} ${f.style}`
    : f.familyName
}

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
  /** text 类型：关联字体版本（空=跟随渲染服务默认） */
  defaultFontVersionId: string
  /** 本地扩展标记：该绑定图层是样机背景（AI 生图/批量替换时默认不轮换） */
  background: boolean
}

interface BindingEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  templateId: string | null
  templateName: string
  layerTree: ExternalLayerNode[]
  initialBindings: MockupBindingDef[]
  /** 既有背景标记（本地扩展表） */
  initialBackgroundBindingIds?: string[]
  /** 模板当前可见性（编辑器内可切换，即时生效） */
  initialVisibility?: "public" | "private"
  /** 可见性变更回执（父层同步状态；实际落库在本组件内调 action） */
  onVisibilityChange?: (v: "public" | "private") => void
  /** 删除模板入口（点击弹确认，由外层处理） */
  onDelete?: () => void
  onSaved: () => void
}

export function BindingEditorDialog({
  open,
  onOpenChange,
  templateId,
  templateName,
  layerTree,
  initialBindings,
  initialBackgroundBindingIds = [],
  initialVisibility = "public",
  onVisibilityChange,
  onDelete,
  onSaved,
}: BindingEditorDialogProps) {
  const [rows, setRows] = React.useState<EditorRow[]>([])
  const [saving, setSaving] = React.useState(false)
  const [visibility, setVisibility] = React.useState<"public" | "private">(
    initialVisibility,
  )
  const [fonts, setFonts] = React.useState<ExternalFont[]>([])
  const [fontsLoading, setFontsLoading] = React.useState(false)
  const [uploadingFont, setUploadingFont] = React.useState(false)
  const fontInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setVisibility(initialVisibility)
  }, [initialVisibility])

  const handleVisibilityChange = async (v: "public" | "private") => {
    if (!templateId || v === visibility) return
    const prev = visibility
    setVisibility(v) // 乐观更新，失败回滚
    onVisibilityChange?.(v)
    const res = await setExternalTemplateVisibilityAction({
      templateId,
      visibility: v,
    })
    if (!res.ok) {
      setVisibility(prev)
      onVisibilityChange?.(prev)
      toast.error(res.error ?? "可见性设置失败")
    }
  }

  const loadFonts = React.useCallback(async () => {
    setFontsLoading(true)
    try {
      const res = await listMockupFontsAction()
      if (res.ok) setFonts(res.fonts)
    } finally {
      setFontsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    void loadFonts()
  }, [open, loadFonts])

  const handleFontSelected = async (file: File | undefined) => {
    if (!file) return
    if (!/\.(ttf|otf|ttc)$/i.test(file.name)) {
      toast.error("仅支持 .ttf / .otf / .ttc 字体文件")
      return
    }
    if (file.size > MAX_FONT_UPLOAD_BYTES) {
      toast.error("字体文件过大，上限 50MB")
      return
    }
    setUploadingFont(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch("/api/mockup/font-upload", {
        method: "POST",
        body: formData,
      })
      const json = (await res.json()) as {
        ok: boolean
        error: string | null
        font?: { familyName: string }
      }
      if (!json.ok) {
        toast.error(json.error ?? "字体上传失败")
        return
      }
      toast.success(`字体「${json.font?.familyName ?? file.name}」已上传`)
      void loadFonts()
    } catch {
      toast.error("字体上传失败，请重试")
    } finally {
      setUploadingFont(false)
      if (fontInputRef.current) fontInputRef.current.value = ""
    }
  }

  React.useEffect(() => {
    if (!open) return
    // 既有绑定按 layerPath 匹配（layerId 可能重复，路径才是稳定定位）
    const existing = new Map(initialBindings.map((b) => [b.layerPath, b]))
    const hasExisting = initialBindings.length > 0
    const background = new Set(initialBackgroundBindingIds)
    const layers = flattenLayerTree(layerTree)
    setRows(
      layers.map((l, idx) => {
        const prev = existing.get(l.layerPath)
        const looksBackground =
          l.type !== "text" && BACKGROUND_NAME_RE.test(l.name)
        // 无既有绑定时：智能对象/文字图层自动勾选；疑似背景的图片图层
        // 也勾选并标记为背景（可手动取消），其余像素图层默认不勾
        const autoCheck =
          !hasExisting &&
          (l.type === "smartObject" ||
            l.type === "text" ||
            (l.type === "pixel" && looksBackground))
        const prevBackground =
          (prev?.bindingId != null && background.has(prev.bindingId)) || false
        return {
          ...l,
          uid: idx,
          bindingId: prev?.bindingId ?? `b${idx}`,
          checked: prev != null ? true : autoCheck,
          label: prev?.label ?? l.name,
          required: prev?.required ?? true,
          fit: prev?.fit ?? "stretch",
          defaultFontVersionId: prev?.defaultFontVersionId ?? "",
          background: hasExisting ? prevBackground : looksBackground && autoCheck,
        }
      }),
    )
  }, [open, layerTree, initialBindings, initialBackgroundBindingIds])

  const toggleRow = (uid: number, checked: boolean) => {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, checked } : r)),
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
        ...(r.type === "text" && r.defaultFontVersionId
          ? { defaultFontVersionId: r.defaultFontVersionId }
          : {}),
      }))
    const backgroundBindingIds = rows
      .filter((r) => r.checked && r.background)
      .map((r) => r.bindingId)
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
        backgroundBindingIds,
      })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(
        res.unchanged ? "背景标记已保存（绑定结构未变更）" : "绑定已保存并发布",
      )
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const checkedCount = rows.filter((r) => r.checked).length
  const backgroundCount = rows.filter((r) => r.checked && r.background).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>
            <FileUp className="mr-1 inline size-4" />
            编辑绑定 · {templateName}
          </DialogTitle>
          <DialogDescription>
            勾选作为「可替换」的图层（智能对象/像素图层替换图片，文字图层替换文字）；
            标记「背景」的图层用于 AI 生成背景图与批量替换时默认固定。
            已勾选 {checkedCount} 个（背景 {backgroundCount} 个）。保存后自动发布为新版本。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <Type className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {fontsLoading
              ? "字体库加载中…"
              : fonts.length > 0
                ? `字体库 ${fonts.length} 个字体 · 文字图层可关联字体（缺失字体会导致渲染丢字效）`
                : "字体库为空 · PSD 文字图层缺失对应字体时渲染会丢字效，建议上传"}
          </span>
          <input
            ref={fontInputRef}
            type="file"
            accept=".ttf,.otf,.ttc"
            className="hidden"
            onChange={(e) => void handleFontSelected(e.target.files?.[0])}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={uploadingFont}
            onClick={() => fontInputRef.current?.click()}
          >
            {uploadingFont ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileUp className="size-3.5" />
            )}
            上传字体
          </Button>
        </div>

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
                  {r.type === "text" ? (
                    <Select
                      value={r.defaultFontVersionId}
                      onValueChange={(v) =>
                        patchRow(r.uid, { defaultFontVersionId: v ?? "" })
                      }
                    >
                      <SelectTrigger size="sm" className="w-[120px] text-xs">
                        <SelectValue>
                          {r.defaultFontVersionId
                            ? fontLabel(
                                fonts.find(
                                  (f) => f.fontId === r.defaultFontVersionId,
                                ),
                              )
                            : "字体：默认"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">字体：默认</SelectItem>
                        {fonts.map((f) => (
                          <SelectItem key={f.fontId} value={f.fontId}>
                            {fontLabel(f)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {r.type !== "text" ? (
                    <>
                      <Select
                        value={r.fit}
                        onValueChange={(v) =>
                          patchRow(r.uid, { fit: v as EditorRow["fit"] })
                        }
                      >
                        <SelectTrigger size="sm" className="w-[72px] text-xs">
                          <SelectValue>
                            {FIT_OPTIONS.find((o) => o.value === r.fit)?.label}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FIT_OPTIONS.map((o) => (
                            <Tooltip key={o.value}>
                              <TooltipTrigger
                                render={<SelectItem value={o.value} />}
                              >
                                {o.label}
                              </TooltipTrigger>
                              <TooltipContent className="max-w-64">
                                {FIT_DESCRIPTIONS[o.value]}
                              </TooltipContent>
                            </Tooltip>
                          ))}
                        </SelectContent>
                      </Select>
                      <label
                        className="flex items-center gap-1 text-xs text-muted-foreground"
                        title="背景图层：AI 生图入口主要面向背景；批量替换时默认固定不轮换"
                      >
                        <Checkbox
                          checked={r.background}
                          onCheckedChange={(v) =>
                            patchRow(r.uid, { background: v === true })
                          }
                        />
                        背景
                      </label>
                    </>
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
          {onDelete ? (
            <Button
              variant="outline"
              className="mr-auto text-destructive hover:text-destructive"
              disabled={saving || !templateId}
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              删除模板
            </Button>
          ) : null}
          <Select
            value={visibility}
            onValueChange={(v) =>
              v && void handleVisibilityChange(v as "public" | "private")
            }
          >
            <SelectTrigger
              size="sm"
              className="w-[120px] text-xs"
              title="公开=企业内可见可渲染；非公开=仅自己与企业管理员可见"
            >
              <SelectValue>
                {visibility === "public" ? "可见性：公开" : "可见性：非公开"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">可见性：公开</SelectItem>
              <SelectItem value="private">可见性：非公开</SelectItem>
            </SelectContent>
          </Select>
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
