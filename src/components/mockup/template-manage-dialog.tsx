"use client"

import * as React from "react"
import {
  Eye,
  EyeOff,
  FileImage,
  FileUp,
  Layers,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { MockupBindingDef } from "@/db/schema"
import type { ExternalLayerNode } from "@/lib/mockup/client"
import { MAX_PSD_UPLOAD_BYTES } from "@/lib/mockup/limits"
import type {
  MockupExternalTemplateView,
  MockupGroupManageView,
} from "@/lib/mockup/types"
import {
  createMockupGroupAction,
  deleteExternalTemplateAction,
  deleteMockupGroupAction,
  getExternalTemplateDetailAction,
  listExternalTemplatesAction,
  listMockupGroupsManageAction,
  setMockupGroupVisibilityAction,
  updateMockupGroupAction,
} from "@/server/actions/mockup"
import { BindingEditorDialog } from "./binding-editor-dialog"
import {
  ExternalTemplateCard,
  VisibilityBadge,
} from "./template-picker"

/* ─── 大模板表单（新建/编辑） ─── */

interface GroupFormValue {
  id: string | null
  name: string
  visibility: "public" | "private"
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
        ? await updateMockupGroupAction({
            id: value.id,
            name: value.name.trim(),
            visibility: value.visibility,
            items,
          })
        : await createMockupGroupAction({
            name: value.name.trim(),
            visibility: value.visibility,
            items,
          })
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
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{value.id ? "编辑大模板" : "新建大模板"}</DialogTitle>
          <DialogDescription>
            勾选小模板组成套组（勾选顺序即成员顺序）；版本钉住加入时的已发布版本。
            公开要求所有成员小模板均为公开。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={value.name}
              onChange={(e) => setValue((p) => ({ ...p, name: e.target.value }))}
              placeholder="大模板名称（如：T恤全家福套组）"
            />
            <Select
              value={value.visibility}
              onValueChange={(v) =>
                setValue((p) => ({ ...p, visibility: v as "public" | "private" }))
              }
            >
              <SelectTrigger className="h-9 w-[110px] shrink-0">
                <SelectValue>
                  {value.visibility === "public" ? "公开" : "非公开"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">公开</SelectItem>
                <SelectItem value="private">非公开</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-[42vh] overflow-y-auto rounded-lg border p-2">
            {templates.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                暂无已发布的小模板，请先在「小模板」页上传 PSD 并发布
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {templates.map((t) => (
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
                .map((id) => templates.find((t) => t.templateId === id)?.name ?? id)
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

/* ─── 模板管理主弹窗（大模板 / 小模板 分开查看） ─── */

interface TemplateManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前用户 id（判定可管理的小模板） */
  currentUserId: string
  isAdmin: boolean
  onChanged: () => void
}

export function TemplateManageDialog({
  open,
  onOpenChange,
  currentUserId,
  isAdmin,
  onChanged,
}: TemplateManageDialogProps) {
  const [tab, setTab] = React.useState<"group" | "template">("group")

  // 大模板
  const [groups, setGroups] = React.useState<MockupGroupManageView[]>([])
  const [groupsLoading, setGroupsLoading] = React.useState(false)
  const [groupKeyword, setGroupKeyword] = React.useState("")
  const [showAuto, setShowAuto] = React.useState(false)
  const [groupForm, setGroupForm] = React.useState<GroupFormValue | null>(null)
  const [deletingGroup, setDeletingGroup] = React.useState<MockupGroupManageView | null>(null)
  const [deletingTemplate, setDeletingTemplate] = React.useState<MockupExternalTemplateView | null>(null)
  const [deletingTemplateBusy, setDeletingTemplateBusy] = React.useState(false)

  // 小模板
  const [templates, setTemplates] = React.useState<MockupExternalTemplateView[]>([])
  const [templatesLoading, setTemplatesLoading] = React.useState(false)
  const [templateKeyword, setTemplateKeyword] = React.useState("")
  /** 小模板列表可见性筛选（全部/公开/非公开） */
  const [visibilityFilter, setVisibilityFilter] = React.useState<
    "all" | "public" | "private"
  >("all")
  const [uploadingPsd, setUploadingPsd] = React.useState(false)
  const psdInputRef = React.useRef<HTMLInputElement>(null)

  // 绑定编辑器状态（PSD 上传后 / 编辑既有）
  const [editor, setEditor] = React.useState<{
    templateId: string | null
    name: string
    layerTree: ExternalLayerNode[]
    bindings: MockupBindingDef[]
    backgroundBindingIds: string[]
    visibility: "public" | "private"
  } | null>(null)

  const loadGroups = React.useCallback(async (q?: string) => {
    setGroupsLoading(true)
    try {
      const res = await listMockupGroupsManageAction(q)
      if (!res.ok) {
        toast.error(res.error ?? "大模板列表获取失败")
        return
      }
      setGroups(res.groups)
    } finally {
      setGroupsLoading(false)
    }
  }, [])

  const loadTemplates = React.useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const res = await listExternalTemplatesAction()
      if (!res.ok) {
        toast.error(res.error ?? "模板列表获取失败")
        return
      }
      setTemplates(res.templates)
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    void loadGroups(groupKeyword || undefined)
    void loadTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 当前用户可加入套组的小模板：公开或自己的（外部已按可见性过滤，这里再限定归属） */
  const canUseTemplate = (t: MockupExternalTemplateView) =>
    isAdmin || t.visibility === "public" || t.ownerUserId === currentUserId
  const usableTemplates = templates.filter((t) => t.published && canUseTemplate(t))

  const openEditorForTemplate = async (templateId: string) => {
    const res = await getExternalTemplateDetailAction(templateId)
    if (!res.ok || !res.detail) {
      toast.error(res.error ?? "模板详情获取失败")
      return
    }
    // 可见性取列表项（详情接口无该字段），列表缺失时默认公开
    const t = templates.find((x) => x.templateId === templateId)
    setEditor({
      templateId: res.detail.templateId,
      name: res.detail.name,
      layerTree: res.detail.layerTree,
      bindings: res.detail.bindings,
      backgroundBindingIds: res.detail.backgroundBindingIds,
      visibility: t?.visibility ?? "public",
    })
  }

  const handlePsdSelected = async (file: File | undefined) => {
    if (!file) return
    if (!/\.psd$/i.test(file.name)) {
      toast.error("请选择 .psd 文件")
      return
    }
    if (file.size > MAX_PSD_UPLOAD_BYTES) {
      toast.error("PSD 文件过大，上限 300MB")
      return
    }
    setUploadingPsd(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      // 上传默认非公开：如需企业内共享，在编辑绑定中切换可见性
      formData.append("visibility", "private")
      // PSD 走 /api 路由而非 Server Action：大文件 multipart 在 Action 链路会被截断
      const res = await fetch("/api/mockup/psd-upload", {
        method: "POST",
        body: formData,
      })
      const json = (await res.json()) as {
        ok: boolean
        error: string | null
        templateId: string | null
        canvasWidth: number | null
        canvasHeight: number | null
        layerTree: ExternalLayerNode[]
      }
      if (!json.ok || !json.templateId) {
        toast.error(json.error ?? "PSD 上传解析失败")
        return
      }
      toast.success("PSD 解析完成，请配置可替换图层")
      setEditor({
        templateId: json.templateId,
        name: file.name.replace(/\.psd$/i, ""),
        layerTree: json.layerTree,
        bindings: [],
        backgroundBindingIds: [],
        visibility: "private",
      })
      void loadTemplates()
    } catch {
      toast.error("PSD 上传失败，请重试")
    } finally {
      setUploadingPsd(false)
      if (psdInputRef.current) psdInputRef.current.value = ""
    }
  }

  const handleToggleVisibility = async (g: MockupGroupManageView) => {
    const next = g.visibility === "public" ? "private" : "public"
    const res = await setMockupGroupVisibilityAction({
      groupId: g.id,
      visibility: next,
    })
    if (!res.ok) {
      toast.error(res.error ?? "设置失败")
      return
    }
    toast.success(next === "public" ? "已设为公开" : "已设为非公开")
    void loadGroups(groupKeyword || undefined)
    onChanged()
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
    void loadGroups(groupKeyword || undefined)
    onChanged()
  }

  const handleDeleteTemplate = async () => {
    if (!deletingTemplate) return
    setDeletingTemplateBusy(true)
    try {
      const res = await deleteExternalTemplateAction(deletingTemplate.templateId)
      if (!res.ok) {
        toast.error(res.error ?? "删除失败")
        return
      }
      toast.success("小模板已删除")
      // 删除入口在编辑绑定弹窗内：一并关闭编辑器
      if (editor?.templateId === deletingTemplate.templateId) setEditor(null)
      setDeletingTemplate(null)
      void loadTemplates()
      onChanged()
    } finally {
      setDeletingTemplateBusy(false)
    }
  }

  const kw = groupKeyword.trim().toLowerCase()
  const visibleGroups = (kw
    ? groups.filter((g) => g.name.toLowerCase().includes(kw))
    : groups
  ).filter((g) => showAuto || !g.autoGenerated)

  const tKw = templateKeyword.trim().toLowerCase()
  const visibleTemplates = (
    tKw
      ? templates.filter(
          (t) =>
            t.name.toLowerCase().includes(tKw) ||
            (t.ownerName ?? "").toLowerCase().includes(tKw),
        )
      : templates
  ).filter((t) => visibilityFilter === "all" || t.visibility === visibilityFilter)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>模板管理</DialogTitle>
            <DialogDescription>
              大模板（套组）组织小模板；小模板来自渲染服务的 PSD（上传 →
              配置绑定 → 发布）。模板按归属人管理，企业管理员可管理本企业全部。
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "group" | "template")}
          >
            <TabsList>
              <TabsTrigger value="group">
                <Layers className="mr-1 size-3.5" /> 大模板
              </TabsTrigger>
              <TabsTrigger value="template">
                <FileImage className="mr-1 size-3.5" /> 小模板
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* 固定高度内容区：两 Tab 等高（以高的为准），记录超出隐藏滚动条滑动 */}
          <div className="flex h-[420px] flex-col">
            {tab === "group" ? (
              <section className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <div className="relative w-[220px]">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={groupKeyword}
                      onChange={(e) => {
                        setGroupKeyword(e.target.value)
                        void loadGroups(e.target.value.trim() || undefined)
                      }}
                      placeholder="搜索大模板名称"
                      className="h-7 pl-8 text-xs"
                    />
                  </div>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Checkbox
                      checked={showAuto}
                      onCheckedChange={(v) => setShowAuto(v === true)}
                    />
                    显示单模板自动组
                  </label>
                  <Button
                    size="sm"
                    disabled={usableTemplates.length === 0}
                    title={
                      usableTemplates.length === 0
                        ? "暂无可用的已发布小模板"
                        : undefined
                    }
                    onClick={() =>
                      setGroupForm({
                        id: null,
                        name: "",
                        visibility: "private",
                        selected: [],
                      })
                    }
                  >
                    <Plus className="size-3.5" /> 新建大模板
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
                  {groupsLoading && groups.length === 0 ? (
                    <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
                    </div>
                  ) : visibleGroups.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                      {kw
                        ? "没有匹配的大模板"
                        : "还没有大模板，点击「新建大模板」创建"}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                    {visibleGroups.map((g) => {
                      const canManage =
                        isAdmin || g.ownerUserId === currentUserId
                      return (
                        <div
                          key={g.id}
                          className="flex items-center gap-2 rounded-lg border p-2.5"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                              {g.name}
                              <VisibilityBadge visibility={g.visibility} />
                              {g.autoGenerated ? (
                                <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">
                                  自动
                                </span>
                              ) : null}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {g.items.length} 个小模板 · 归属：
                              {g.ownerName || "-"} · {g.cardCount} 张卡片
                            </div>
                          </div>
                          {canManage ? (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                title={
                                  g.visibility === "public"
                                    ? "设为非公开"
                                    : "设为公开（需成员小模板全部公开）"
                                }
                                onClick={() => void handleToggleVisibility(g)}
                              >
                                {g.visibility === "public" ? (
                                  <Eye className="size-4" />
                                ) : (
                                  <EyeOff className="size-4" />
                                )}
                              </Button>
                              {!g.autoGenerated ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  title="编辑"
                                  onClick={() =>
                                    setGroupForm({
                                      id: g.id,
                                      name: g.name,
                                      visibility: g.visibility,
                                      selected: g.items.map(
                                        (i) => i.externalTemplateId,
                                      ),
                                    })
                                  }
                                >
                                  <Pencil className="size-4" />
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                size="icon"
                                title="删除（套组下的卡片一并删除，历史渲染保留）"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setDeletingGroup(g)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      )
                    })}
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <div className="relative w-[220px]">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={templateKeyword}
                      onChange={(e) => setTemplateKeyword(e.target.value)}
                      placeholder="搜索小模板名称 / 归属人"
                      className="h-7 pl-8 text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <Select
                      value={visibilityFilter}
                      onValueChange={(v) =>
                        setVisibilityFilter(
                          (v ?? "all") as "all" | "public" | "private",
                        )
                      }
                    >
                      <SelectTrigger size="sm" className="w-[96px] text-xs" title="按可见性筛选">
                        <SelectValue>
                          {visibilityFilter === "all"
                            ? "全部可见性"
                            : visibilityFilter === "public"
                              ? "公开"
                              : "非公开"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">全部可见性</SelectItem>
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
                      variant="outline"
                      onClick={() => void loadTemplates()}
                      disabled={templatesLoading}
                      title="刷新模板列表"
                    >
                      <RefreshCw className={`size-3.5 ${templatesLoading ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
                  {templatesLoading && templates.length === 0 ? (
                    <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
                    </div>
                  ) : visibleTemplates.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                      {tKw
                        ? "没有匹配的小模板"
                        : "渲染服务中还没有模板，点击「上传 PSD」创建"}
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                      {visibleTemplates.map((t) => {
                        const canManage =
                          isAdmin || t.ownerUserId === currentUserId
                        return (
                          <ExternalTemplateCard
                            key={t.templateId}
                            template={t}
                            onClick={
                              canManage
                                ? () => void openEditorForTemplate(t.templateId)
                                : undefined
                            }
                          />
                        )
                      })}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    提示：DRAFT 模板需「编辑绑定 → 保存并发布」后才能加入大模板或批量替换
                  </p>
                </div>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 新建/编辑大模板 */}
      <GroupFormDialog
        open={groupForm !== null}
        onOpenChange={(o) => !o && setGroupForm(null)}
        templates={usableTemplates}
        initial={groupForm ?? { id: null, name: "", visibility: "private", selected: [] }}
        onSaved={() => {
          void loadGroups(groupKeyword || undefined)
          onChanged()
        }}
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
              套组下的 {deletingGroup?.cardCount ?? 0}{" "}
              张渲染卡片会一并删除；历史渲染结果保留在资产管理页
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

      {/* 删除小模板确认 */}
      <Dialog
        open={deletingTemplate !== null}
        onOpenChange={(o) => !o && setDeletingTemplate(null)}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>删除小模板「{deletingTemplate?.name}」？</DialogTitle>
            <DialogDescription>
              该模板会从渲染服务移除（已发布将自动归档后删除）；
              所属套组成员会一并移除，历史渲染任务与批次记录保留
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deletingTemplateBusy}
              onClick={() => setDeletingTemplate(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deletingTemplateBusy}
              onClick={() => void handleDeleteTemplate()}
            >
              {deletingTemplateBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
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
        initialBackgroundBindingIds={editor?.backgroundBindingIds ?? []}
        initialVisibility={editor?.visibility ?? "public"}
        onVisibilityChange={(v) => {
          // 即时生效（与大模板可见性切换同语义）；编辑器内部自行乐观更新
          if (editor) setEditor({ ...editor, visibility: v })
        }}
        onDelete={
          editor
            ? () => {
                const t = templates.find(
                  (x) => x.templateId === editor.templateId,
                )
                if (t) setDeletingTemplate(t)
              }
            : undefined
        }
        onSaved={() => void loadTemplates()}
      />
    </>
  )
}
