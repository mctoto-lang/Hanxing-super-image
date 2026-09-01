"use client"

import { useCallback, useEffect, useState } from "react"
import { LibraryBig, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Combobox } from "@/components/ui/combobox"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/workspace/spinner"
import { toast } from "sonner"
import {
  createTemplateAction,
  deleteTemplateAction,
  listChatApisAction,
  listTemplatesAction,
  updateTemplateAction,
} from "@/server/actions/workspace"
import { workspaceTemplateTypes } from "@/lib/workspace/helpers"
import type {
  ChatApiOption,
  TemplateRow,
  TemplateType,
} from "@/lib/workspace/types"

/**
 * 提示词模板管理页（自批量生图的模板管理弹窗迁移而来）。
 *
 * 模板仅被批量生图（裂变/细化/重生成/提取/翻译）消费，
 * 变更后由 server action 同时 revalidate /workspace 与 /templates。
 */

type FormState = {
  name: string
  type: TemplateType
  content: string
  chatApiId: string
  fissionCount: string
  visibility: "private" | "public"
}

const emptyForm: FormState = {
  name: "",
  type: "fission",
  content: "",
  chatApiId: "",
  fissionCount: "",
  visibility: "private",
}

function typeLabel(type: TemplateType): string {
  return workspaceTemplateTypes.find((i) => i.value === type)?.label ?? type
}

export function PromptTemplateManager() {
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [chatApis, setChatApis] = useState<ChatApiOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deletingPending, setDeletingPending] = useState(false)
  const [editing, setEditing] = useState<TemplateRow | null>(null)
  const [deleting, setDeleting] = useState<TemplateRow | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [activeType, setActiveType] = useState<TemplateType>("fission")

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await listTemplatesAction({ type: activeType })
      setTemplates(rows)
    } catch {
      toast.error("获取模板失败")
    } finally {
      setLoading(false)
    }
  }, [activeType])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    listChatApisAction()
      .then(setChatApis)
      .catch(() => setChatApis([]))
  }, [])

  const openCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm, type: activeType })
    setShowForm(true)
  }

  const openEdit = (template: TemplateRow) => {
    setEditing(template)
    setForm({
      name: template.name,
      type: template.type,
      content: template.content,
      chatApiId: template.chatApiId ?? "",
      fissionCount:
        template.fissionCount != null ? String(template.fissionCount) : "",
      visibility: template.visibility,
    })
    setShowForm(true)
  }

  const save = async () => {
    if (!form.name.trim() || !form.content.trim()) {
      toast.error("名称和内容不能为空")
      return
    }
    setSaving(true)
    try {
      const fissionCount =
        form.type === "fission" && form.fissionCount
          ? Number(form.fissionCount)
          : null
      if (editing) {
        const res = await updateTemplateAction(editing.id, {
          name: form.name.trim(),
          content: form.content,
          chatApiId: form.chatApiId,
          fissionCount,
          visibility: form.visibility,
        })
        if (!res.ok) throw new Error(res.error || "保存失败")
        toast.success("模板已更新")
      } else {
        const res = await createTemplateAction({
          type: form.type,
          name: form.name.trim(),
          content: form.content,
          chatApiId: form.chatApiId,
          fissionCount,
          visibility: form.visibility,
        })
        if (!res.ok) throw new Error(res.error || "保存失败")
        toast.success("模板已创建")
      }
      setShowForm(false)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeletingPending(true)
    try {
      const res = await deleteTemplateAction(deleting.id)
      if (!res.ok) throw new Error(res.error || "删除失败")
      toast.success("模板已删除")
      setDeleting(null)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setDeletingPending(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <LibraryBig className="h-6 w-6" />
          提示词模板
        </h1>
        <p className="text-sm text-muted-foreground">
          管理批量生图使用的提示词模板（裂变 / 细化 / 重生成 / 提取 / 翻译）
        </p>
      </div>

      {loading && templates.length === 0 ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {workspaceTemplateTypes.map((item) => (
                <Button
                  key={item.value}
                  variant={activeType === item.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveType(item.value as TemplateType)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <Button onClick={openCreate} size="sm">
              <Plus />
              新建模板
            </Button>
          </div>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模板名称</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>关联对话模型</TableHead>
                  <TableHead>可见性</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-8 text-center text-muted-foreground"
                    >
                      暂无模板
                    </TableCell>
                  </TableRow>
                ) : (
                  templates.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {typeLabel(t.type)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t.chatApiName || "未关联"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {t.visibility === "public" ? "公开" : "仅自己"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(t.createdAt).toLocaleDateString("zh-CN")}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="ghost" size="icon-sm" />}
                          >
                            <span className="sr-only">打开菜单</span>
                            <MoreVertical />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(t)}>
                              <Pencil />
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleting(t)}
                            >
                              <Trash2 />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑模板" : "新建模板"}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto py-1 pr-1">
            <div className="flex flex-col gap-1">
              <Label>模板名称</Label>
              <Input
                value={form.name}
                onChange={(e) =>
                  setForm((cur) => ({ ...cur, name: e.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>模板类型</Label>
              <Select
                value={form.type}
                onValueChange={(v) =>
                  setForm((cur) => ({ ...cur, type: (v ?? "fission") as TemplateType }))
                }
                disabled={!!editing}
                items={workspaceTemplateTypes}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaceTemplateTypes.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>关联对话模型</Label>
              <Combobox
                value={form.chatApiId || null}
                onChange={(v) =>
                  setForm((cur) => ({ ...cur, chatApiId: v }))
                }
                options={chatApis.map((api) => ({
                  value: api.id,
                  label: api.displayName || api.name,
                  description: api.name,
                  badge: api.isPlatformPreset ? "平台" : "企业",
                }))}
                placeholder="选择对话模型"
                searchPlaceholder="搜索对话模型..."
                emptyText="暂无可用对话模型，请联系管理员配置"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>可见性</Label>
              <Select
                value={form.visibility}
                onValueChange={(v) =>
                  setForm((cur) => ({
                    ...cur,
                    visibility: (v ?? "private") as "private" | "public",
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {form.visibility === "public" ? "所有用户" : "仅自己"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">仅自己</SelectItem>
                  <SelectItem value="public">所有用户</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.type === "fission" && (
              <div className="flex flex-col gap-1">
                <Label>裂变数量</Label>
                <Input
                  type="number"
                  value={form.fissionCount}
                  onChange={(e) =>
                    setForm((cur) => ({ ...cur, fissionCount: e.target.value }))
                  }
                />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label>模板内容</Label>
              <Textarea
                rows={8}
                className="font-mono text-xs"
                value={form.content}
                onChange={(e) =>
                  setForm((cur) => ({ ...cur, content: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowForm(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存模板"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
          </DialogHeader>
          <p className="py-2 text-sm text-muted-foreground">
            确认删除模板“{deleting?.name}”？此操作无法恢复。
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={deletingPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deletingPending}
            >
              {deletingPending ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
