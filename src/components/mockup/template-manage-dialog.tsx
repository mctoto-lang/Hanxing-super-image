"use client"

import * as React from "react"
import {
  FileUp,
  Image as ImageIcon,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupBindingDef } from "@/db/schema"
import type { ExternalLayerNode } from "@/lib/mockup/client"
import type { MockupExternalTemplateView, MockupGroupView } from "@/lib/mockup/types"
import {
  createMockupGroupAction,
  deleteMockupGroupAction,
  getExternalTemplateDetailAction,
  listExternalTemplatesAction,
  regenerateTemplateThumbnailAction,
  updateMockupGroupAction,
  uploadPsdTemplateAction,
} from "@/server/actions/mockup"
import { BindingEditorDialog } from "./binding-editor-dialog"

/** 模板缩略图代理地址（外部无缩略图/未加端点时 onError 占位） */
function thumbnailSrc(templateId: string) {
  return `/api/mockup/template-thumbnail?templateId=${encodeURIComponent(templateId)}`
}

/** 小模板库卡片（勾选态由父级 groupForm 持有） */
function ExternalTemplateCard({
  template,
  checked,
  onToggle,
  onEditBindings,
  onRegenerate,
  regenerating,
}: {
  template: MockupExternalTemplateView
  checked?: boolean
  onToggle?: () => void
  onEditBindings?: () => void
  onRegenerate?: () => void
  regenerating?: boolean
}) {
  const [thumbErrored, setThumbErrored] = React.useState(false)
  const showPlaceholder = !template.hasThumbnail || thumbErrored
  return (
    <div
      className={`relative flex w-[124px] flex-col overflow-hidden rounded-lg border bg-card ${
        checked ? "border-primary ring-1 ring-primary/40" : ""
      }`}
    >
      {onToggle ? (
        <button
          type="button"
          className="block text-left"
          onClick={onToggle}
          title={template.name}
        >
          <ThumbArea
            templateId={template.templateId}
            showPlaceholder={showPlaceholder}
            onErrored={() => setThumbErrored(true)}
          />
        </button>
      ) : (
        <ThumbArea
          templateId={template.templateId}
          showPlaceholder={showPlaceholder}
          onErrored={() => setThumbErrored(true)}
        />
      )}
      <div className="flex flex-1 flex-col gap-1 p-2">
        <span className="line-clamp-1 text-xs font-medium" title={template.name}>
          {template.name}
          {template.visibility === "private" ? (
            <span className="ml-1 rounded bg-amber-500/15 px-1 text-[9px] text-amber-600">
              私有
            </span>
          ) : null}
        </span>
        <span className="text-[10px] text-muted-foreground">
          v{template.latestVersion} ·{" "}
          {template.published ? "已发布" : template.statusLabel}
        </span>
        {!template.hasThumbnail && onRegenerate ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full justify-start px-1 text-xs"
            disabled={regenerating}
            onClick={onRegenerate}
          >
            <RefreshCw className={`size-3 ${regenerating ? "animate-spin" : ""}`} />
            {regenerating ? "生成中…" : "生成缩略图"}
          </Button>
        ) : null}
        {onEditBindings ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-full justify-start px-1 text-xs"
            onClick={onEditBindings}
          >
            <Settings2 className="size-3" /> 编辑绑定
          </Button>
        ) : null}
      </div>
      {onToggle ? (
        <span className="absolute right-1.5 top-1.5">
          <Checkbox checked={checked === true} onCheckedChange={() => onToggle()} />
        </span>
      ) : null}
    </div>
  )
}

function ThumbArea({
  templateId,
  showPlaceholder,
  onErrored,
}: {
  templateId: string
  showPlaceholder: boolean
  onErrored: () => void
}) {
  if (showPlaceholder) {
    return (
      <span className="flex aspect-square items-center justify-center bg-muted/50">
        <ImageIcon className="size-6 text-muted-foreground/40" />
      </span>
    )
  }
  return (
    <SmartImage
      src={thumbnailSrc(templateId)}
      alt="模板缩略图"
      className="aspect-square w-full object-cover"
      onError={onErrored}
    />
  )
}

/* ─── 大模板表单（新建/编辑） ─── */

interface GroupFormValue {
  id: string | null
  name: string
  selected: string[] // templateId 顺序即成员顺序
}

function GroupFormDialog({
  open,
  onOpenChange,
  templates,
  initial,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: MockupExternalTemplateView[]
  initial: GroupFormValue
  onSaved: () => void
}) {
  const [value, setValue] = React.useState<GroupFormValue>(initial)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) setValue(initial)
  }, [open, initial])

  const published = templates.filter((t) => t.published)

  const toggle = (templateId: string) => {
    setValue((prev) => ({
      ...prev,
      selected: prev.selected.includes(templateId)
        ? prev.selected.filter((id) => id !== templateId)
        : [...prev.selected, templateId],
    }))
  }

  const handleSave = async () => {
    if (!value.name.trim()) {
      toast.error("请输入大模板名称")
      return
    }
    if (value.selected.length === 0) {
      toast.error("请至少选择 1 个小模板")
      return
    }
    setSaving(true)
    try {
      const items = value.selected.map((templateId, idx) => ({
        templateId,
        sortOrder: idx,
      }))
      const res = value.id
        ? await updateMockupGroupAction({ id: value.id, name: value.name.trim(), items })
        : await createMockupGroupAction({ name: value.name.trim(), items })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(value.id ? "大模板已更新" : "大模板已创建")
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{value.id ? "编辑大模板" : "新建大模板"}</DialogTitle>
          <DialogDescription>
            勾选小模板组成套组（勾选顺序即成员顺序）；版本钉住加入时的已发布版本
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Input
            value={value.name}
            onChange={(e) => setValue((p) => ({ ...p, name: e.target.value }))}
            placeholder="大模板名称（如：T恤全家福套组）"
          />
          <div className="max-h-[45vh] overflow-y-auto rounded-lg border p-2">
            {published.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                暂无已发布的小模板，请先在下方上传 PSD 并发布
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {published.map((t) => (
                  <ExternalTemplateCard
                    key={t.templateId}
                    template={t}
                    checked={value.selected.includes(t.templateId)}
                    onToggle={() => toggle(t.templateId)}
                  />
                ))}
              </div>
            )}
          </div>
          {value.selected.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              已选 {value.selected.length} 个：{value.selected
                .map((id) => published.find((t) => t.templateId === id)?.name ?? id)
                .join(" → ")}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={saving} onClick={() => void handleSave()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 模板管理主弹窗 ─── */

interface TemplateManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: MockupGroupView[]
  onChanged: () => void
}

export function TemplateManageDialog({
  open,
  onOpenChange,
  groups,
  onChanged,
}: TemplateManageDialogProps) {
  const [templates, setTemplates] = React.useState<MockupExternalTemplateView[]>([])
  const [loading, setLoading] = React.useState(false)
  const [regenId, setRegenId] = React.useState<string | null>(null)
  const [uploadVisibility, setUploadVisibility] = React.useState<
    "public" | "private"
  >("public")
  const [groupForm, setGroupForm] = React.useState<GroupFormValue | null>(null)
  const [deletingGroup, setDeletingGroup] = React.useState<MockupGroupView | null>(null)
  const [uploadingPsd, setUploadingPsd] = React.useState(false)
  const psdInputRef = React.useRef<HTMLInputElement>(null)

  // 绑定编辑器状态（PSD 上传后 / 编辑既有）
  const [editor, setEditor] = React.useState<{
    templateId: string | null
    name: string
    layerTree: ExternalLayerNode[]
    bindings: MockupBindingDef[]
  } | null>(null)

  const loadTemplates = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await listExternalTemplatesAction()
      if (!res.ok) {
        toast.error(res.error ?? "模板列表获取失败")
        return
      }
      setTemplates(res.templates)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) void loadTemplates()
  }, [open, loadTemplates])

  const handleRegenerate = async (templateId: string) => {
    setRegenId(templateId)
    try {
      const res = await regenerateTemplateThumbnailAction(templateId)
      if (!res.ok) {
        toast.error(res.error ?? "缩略图生成失败")
        return
      }
      toast.success("缩略图已生成")
      await loadTemplates()
    } finally {
      setRegenId(null)
    }
  }

  const openEditorForTemplate = async (templateId: string) => {
    const res = await getExternalTemplateDetailAction(templateId)
    if (!res.ok || !res.detail) {
      toast.error(res.error ?? "模板详情获取失败")
      return
    }
    setEditor({
      templateId: res.detail.templateId,
      name: res.detail.name,
      layerTree: res.detail.layerTree,
      bindings: res.detail.bindings,
    })
  }

  const handlePsdSelected = async (file: File | undefined) => {
    if (!file) return
    if (!/\.psd$/i.test(file.name)) {
      toast.error("请选择 .psd 文件")
      return
    }
    setUploadingPsd(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("visibility", uploadVisibility)
      const res = await uploadPsdTemplateAction(formData)
      if (!res.ok || !res.templateId) {
        toast.error(res.error ?? "PSD 上传解析失败")
        return
      }
      toast.success("PSD 解析完成，请配置可替换图层")
      setEditor({
        templateId: res.templateId,
        name: file.name.replace(/\.psd$/i, ""),
        layerTree: res.layerTree,
        bindings: [],
      })
      void loadTemplates()
    } finally {
      setUploadingPsd(false)
      if (psdInputRef.current) psdInputRef.current.value = ""
    }
  }

  const handleDeleteGroup = async () => {
    if (!deletingGroup) return
    const res = await deleteMockupGroupAction(deletingGroup.id)
    if (!res.ok) {
      toast.error(res.error ?? "删除失败")
      return
    }
    toast.success("大模板已删除")
    setDeletingGroup(null)
    onChanged()
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle>模板管理</DialogTitle>
            <DialogDescription>
              大模板（套组）组织小模板；小模板来自渲染服务的 PSD（上传 →
              配置绑定 → 发布）
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[65vh] space-y-4 overflow-y-auto">
            {/* 大模板套组 */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Layers className="size-4" /> 大模板（套组）
                </h3>
                <Button
                  size="sm"
                  onClick={() =>
                    setGroupForm({ id: null, name: "", selected: [] })
                  }
                >
                  <Plus className="size-3.5" /> 新建大模板
                </Button>
              </div>
              {groups.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                  还没有大模板，点击「新建大模板」创建
                </div>
              ) : (
                <div className="space-y-1.5">
                  {groups.map((g) => (
                    <div
                      key={g.id}
                      className="flex items-center gap-2 rounded-lg border p-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{g.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {g.items.length} 个小模板：
                          {g.items.map((i) => i.displayName).join("、")}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="编辑"
                        onClick={() =>
                          setGroupForm({
                            id: g.id,
                            name: g.name,
                            selected: g.items.map(
                              (i) => i.externalTemplateId,
                            ),
                          })
                        }
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="删除（套组下的卡片一并删除，历史渲染保留）"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeletingGroup(g)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <Separator />

            {/* 小模板库 */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <ImageIcon className="size-4" /> 小模板库（PSD 样机）
                </h3>
                <div className="flex items-center gap-1">
                  <Select
                    value={uploadVisibility}
                    onValueChange={(v) =>
                      setUploadVisibility(v as "public" | "private")
                    }
                  >
                    <SelectTrigger className="h-8 w-[96px] text-xs" title="上传模板的可见性">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">公开</SelectItem>
                      <SelectItem value="private">非公开</SelectItem>
                    </SelectContent>
                  </Select>
                  <input
                    ref={psdInputRef}
                    type="file"
                    accept=".psd"
                    className="hidden"
                    onChange={(e) => void handlePsdSelected(e.target.files?.[0])}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={uploadingPsd}
                    onClick={() => psdInputRef.current?.click()}
                  >
                    {uploadingPsd ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <FileUp className="size-3.5" />
                    )}
                    上传 PSD
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void loadTemplates()}
                    disabled={loading}
                  >
                    <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
              {loading && templates.length === 0 ? (
                <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
                </div>
              ) : templates.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                  渲染服务中还没有模板，点击「上传 PSD」创建
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {templates.map((t) => (
                    <ExternalTemplateCard
                      key={t.templateId}
                      template={t}
                      onEditBindings={() => void openEditorForTemplate(t.templateId)}
                      onRegenerate={() => void handleRegenerate(t.templateId)}
                      regenerating={regenId === t.templateId}
                    />
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                提示：DRAFT 模板需「编辑绑定 → 保存并发布」后才能加入大模板
              </p>
            </section>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新建/编辑大模板 */}
      <GroupFormDialog
        open={groupForm !== null}
        onOpenChange={(o) => !o && setGroupForm(null)}
        templates={templates}
        initial={groupForm ?? { id: null, name: "", selected: [] }}
        onSaved={onChanged}
      />

      {/* 删除大模板确认 */}
      <Dialog
        open={deletingGroup !== null}
        onOpenChange={(o) => !o && setDeletingGroup(null)}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>删除大模板「{deletingGroup?.name}」？</DialogTitle>
            <DialogDescription>
              套组下的渲染卡片会一并删除；历史渲染结果保留在资产管理页
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingGroup(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteGroup()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 绑定编辑器 */}
      <BindingEditorDialog
        open={editor !== null}
        onOpenChange={(o) => !o && setEditor(null)}
        templateId={editor?.templateId ?? null}
        templateName={editor?.name ?? ""}
        layerTree={editor?.layerTree ?? []}
        initialBindings={editor?.bindings ?? []}
        onSaved={() => void loadTemplates()}
      />
    </>
  )
}
