"use client"

import * as React from "react"
import { Layers, Loader2, Plus, Search } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { MockupExternalTemplateView, MockupGroupView } from "@/lib/mockup/types"
import {
  createCardFromTemplateAction,
  createMockupCardAction,
  listExternalTemplatesAction,
} from "@/server/actions/mockup"
import { ExternalTemplateCard, VisibilityBadge } from "./template-picker"

/**
 * 创建卡片弹窗：按大模板（套组）或直接按小模板创建。
 * 大模板 = 本地套组（可见范围已过滤）；小模板 = 外部 PSD（仅已发布），
 * 选小模板时自动创建/复用单成员套组。支持搜索 + 归属人/可见性展示。
 */
export function CreateCardDialog({
  open,
  onOpenChange,
  groups,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: MockupGroupView[]
  onCreated: () => void
}) {
  const [tab, setTab] = React.useState<"group" | "template">("group")
  const [keyword, setKeyword] = React.useState("")
  const [selected, setSelected] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [templates, setTemplates] = React.useState<MockupExternalTemplateView[]>([])
  const [templatesLoading, setTemplatesLoading] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setSelected(null)
      setKeyword("")
    }
  }, [open])

  // 小模板列表（打开且切到该 Tab 时拉取）
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
    if (open && tab === "template" && templates.length === 0 && !templatesLoading) {
      void loadTemplates()
    }
  }, [open, tab, templates.length, templatesLoading, loadTemplates])

  const kw = keyword.trim().toLowerCase()
  const filteredGroups = kw
    ? groups.filter(
        (g) =>
          g.name.toLowerCase().includes(kw) ||
          g.items.some((i) => i.displayName.toLowerCase().includes(kw)),
      )
    : groups
  const publishedTemplates = templates.filter((t) => t.published)
  const filteredTemplates = kw
    ? publishedTemplates.filter((t) => t.name.toLowerCase().includes(kw))
    : publishedTemplates

  const handleCreate = async () => {
    if (!selected) {
      toast.error(tab === "group" ? "请选择一个大模板" : "请选择一个小模板")
      return
    }
    setCreating(true)
    try {
      const res =
        tab === "group"
          ? await createMockupCardAction(selected)
          : await createCardFromTemplateAction({ templateId: selected })
      if (!res.ok || !res.cardId) {
        toast.error(res.error ?? "创建失败")
        return
      }
      toast.success("卡片已创建，点击小方块配置图层")
      onCreated()
      onOpenChange(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>创建渲染卡片</DialogTitle>
          <DialogDescription>
            选择大模板（套组）或小模板创建卡片；同一模板可创建多张
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v as "group" | "template")
              setSelected(null)
            }}
          >
            <TabsList>
              <TabsTrigger value="group">按大模板</TabsTrigger>
              <TabsTrigger value="template">按小模板</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-[200px]">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索模板名称"
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div className="max-h-[46vh] space-y-1.5 overflow-y-auto">
          {tab === "group" ? (
            filteredGroups.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                没有可用的大模板，可切换「按小模板」直接创建，或在「模板管理」中创建
              </div>
            ) : (
              filteredGroups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelected(g.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${
                    selected === g.id
                      ? "border-primary ring-1 ring-primary/40"
                      : "hover:border-primary/50"
                  }`}
                >
                  <Layers className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {g.name} <VisibilityBadge visibility={g.visibility} />
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {g.items.length} 个样机 · 归属：{g.ownerName || "-"}
                    </span>
                  </span>
                </button>
              ))
            )
          ) : templatesLoading && templates.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              暂无已发布的小模板，请先在「模板管理」中上传 PSD 并发布
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {filteredTemplates.map((t) => (
                <ExternalTemplateCard
                  key={t.templateId}
                  template={t}
                  selected={selected === t.templateId}
                  onToggle={() => setSelected(t.templateId)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button disabled={creating || !selected} onClick={() => void handleCreate()}>
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            创建卡片
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
