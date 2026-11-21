"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm, useWatch } from "react-hook-form"
import { z } from "zod"
import { Pencil, Download, Trash2, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { SmartImage } from "@/components/ui/smart-image"
import { DashRing } from "@/components/ui/dash-ring"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { compactNumber, platformLabel } from "./labels"
import {
  exportSelectionBookmarksExcelAction,
  listSelectionBookmarksAction,
  removeSelectionBookmarksAction,
  updateSelectionBookmarkAction,
} from "@/server/actions/selection"

/**
 * 我的选品（收藏网格 + 集合筛选 + 笔记/标签编辑 + 批量移除 + Excel 导出）
 *
 * 初始数据 RSC 注入；集合切换/翻页走 action 重取（客户端状态驱动，无路由参数）。
 */

/** 收藏结果行的 UI 投影（listSelectionBookmarksAction 返回的 result 形状） */
export interface SelectionResultItem {
  id: string
  platform: string
  title: string | null
  content: string | null
  price: string | null
  originalPrice: string | null
  currency: string | null
  rating: string | null
  reviewCount: number | null
  salesCount: number | null
  likesCount: number | null
  commentsCount: number | null
  sharesCount: number | null
  viewsCount: number | null
  sellerName: string | null
  images: string[] | null
  sourceUrl: string | null
  tags: string[] | null
  category: string | null
  publishedAt: Date | string | null
}

export interface BookmarkItem {
  id: string
  resultId: string
  notes: string | null
  customTags: string[] | null
  collectionName: string | null
  priority: string | null
  createdAt: Date | string
  result: SelectionResultItem
}

const PRIORITY_OPTIONS = [
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
]

const editSchema = z.object({
  collectionName: z.string().trim().max(100, "集合名过长"),
  priority: z.string(),
  customTags: z.string().max(200, "标签过长"),
  notes: z.string().max(2000, "笔记过长"),
})
type EditValues = z.input<typeof editSchema>

export function SelectionMineClient({
  initialItems,
  initialTotal,
  collections,
}: {
  initialItems: BookmarkItem[]
  initialTotal: number
  collections: Array<{ name: string | null; count: number }>
}) {
  const [items, setItems] = React.useState(initialItems)
  const [total, setTotal] = React.useState(initialTotal)
  const [collection, setCollection] = React.useState<string | null>(null) // null=全部
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [editTarget, setEditTarget] = React.useState<BookmarkItem | null>(null)
  const [removeOpen, setRemoveOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const router = useRouter()

  const pageSize = 24

  const load = React.useCallback(
    async (nextCollection: string | null, nextPage: number) => {
      setLoading(true)
      try {
        const res = await listSelectionBookmarksAction({
          collectionName: nextCollection ?? undefined,
          page: nextPage,
          pageSize,
        })
        if (res.ok) {
          setItems(res.items as BookmarkItem[])
          setTotal(res.total)
          setPage(res.page)
        }
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  const switchCollection = (name: string | null) => {
    setCollection(name)
    setSelected(new Set())
    void load(name, 1)
  }

  const toggleSelect = (resultId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(resultId)) next.delete(resultId)
      else next.add(resultId)
      return next
    })
  }

  const doRemove = async () => {
    if (selected.size === 0) return
    const ids = [...selected]
    const res = await removeSelectionBookmarksAction(ids)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success(`已移除 ${ids.length} 项收藏`)
    setSelected(new Set())
    setRemoveOpen(false)
    void load(collection, page)
    // collections 来自 RSC props，刷新让集合筛选条（名称/计数）同步
    router.refresh()
  }

  const doExport = async () => {
    setExporting(true)
    try {
      const res = await exportSelectionBookmarksExcelAction({
        collectionName: collection ?? undefined,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      // base64 → Blob 下载（对齐库存导出模式）
      const bin = atob(res.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      )
      const a = document.createElement("a")
      a.href = url
      a.download = res.filename
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const form = useForm<EditValues>({
    resolver: standardSchemaResolver(editSchema),
    defaultValues: { collectionName: "", priority: "medium", customTags: "", notes: "" },
  })

  const openEdit = (item: BookmarkItem) => {
    setEditTarget(item)
    form.reset({
      collectionName: item.collectionName ?? "",
      priority: item.priority ?? "medium",
      customTags: (item.customTags ?? []).join(", "),
      notes: item.notes ?? "",
    })
  }

  // useWatch 而非内联 form.watch（react-compiler 兼容，见 react-hooks/incompatible-library）
  const priorityValue = useWatch({ control: form.control, name: "priority" })

  const submitEdit = form.handleSubmit(async (v) => {
    if (!editTarget) return
    const res = await updateSelectionBookmarkAction({
      resultId: editTarget.resultId,
      notes: v.notes.trim() || null,
      collectionName: v.collectionName.trim() || null,
      priority:
        v.priority === "high" || v.priority === "medium" || v.priority === "low"
          ? v.priority
          : null,
      customTags: v.customTags.trim()
        ? v.customTags.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 10)
        : null,
    })
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    toast.success("已保存")
    setEditTarget(null)
    void load(collection, page)
    // 编辑可能改动了集合归属，刷新让集合筛选条（名称/计数）同步
    router.refresh()
  })

  return (
    <div className="space-y-4">
      {/* 集合筛选 + 导出 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={collection === null ? "default" : "outline"}
          size="sm"
          onClick={() => switchCollection(null)}
        >
          全部（{collections.reduce((s, c) => s + c.count, 0)}）
        </Button>
        <Button
          variant={collection === "" ? "default" : "outline"}
          size="sm"
          onClick={() => switchCollection("")}
        >
          未分组
        </Button>
        {collections
          .filter((c) => c.name != null)
          .map((c) => (
            <Button
              key={c.name}
              variant={collection === c.name ? "default" : "outline"}
              size="sm"
              onClick={() => switchCollection(c.name)}
            >
              {c.name}（{c.count}）
            </Button>
          ))}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={exporting || total === 0}
          onClick={() => void doExport()}
        >
          {exporting ? <DashRing className="size-4" /> : <Download className="size-4" />}
          导出 Excel
        </Button>
      </div>

      {/* 批量条 */}
      {selected.size > 0 ? (
        <div className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
          <span>已选 {selected.size} 项</span>
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setRemoveOpen(true)}>
            <Trash2 className="size-4" />
            移除收藏
          </Button>
        </div>
      ) : null}

      {/* 网格 */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          暂无收藏。在市场分析/选品发现的结果列表点星标即可收藏到这里。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((b) => {
            const r = b.result
            const img = r.images?.[0] ?? null
            return (
              <div key={b.id} className="flex gap-3 rounded-xl border p-3">
                <div className="flex flex-col items-center gap-2">
                  <Checkbox
                    checked={selected.has(b.resultId)}
                    onCheckedChange={() => toggleSelect(b.resultId)}
                    aria-label="选择"
                  />
                  {img ? (
                    <SmartImage
                      src={img}
                      alt={(r.title ?? r.content ?? "").slice(0, 40)}
                      className="size-20 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex size-20 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
                      无图
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {platformLabel(r.platform)}
                    </Badge>
                    {b.collectionName ? (
                      <Badge className="bg-secondary text-secondary-foreground text-[10px]">
                        {b.collectionName}
                      </Badge>
                    ) : null}
                    {b.priority === "high" ? (
                      <Badge className="bg-amber-500/15 text-amber-600 text-[10px] dark:text-amber-400">
                        高优
                      </Badge>
                    ) : null}
                  </div>
                  <p className="line-clamp-2 text-sm" title={r.title ?? r.content ?? ""}>
                    {r.title ?? r.content ?? "（无标题）"}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    {r.price != null ? (
                      <span className="font-medium text-foreground">
                        {Number(r.price).toFixed(2)} {r.currency ?? ""}
                      </span>
                    ) : null}
                    {r.salesCount != null ? <span>销 {compactNumber(r.salesCount)}</span> : null}
                    {r.likesCount != null ? <span>赞 {compactNumber(r.likesCount)}</span> : null}
                    {r.rating != null ? <span>★ {Number(r.rating).toFixed(1)}</span> : null}
                  </div>
                  {b.customTags && b.customTags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {b.customTags.slice(0, 4).map((t) => (
                        <Badge key={t} variant="outline" className="text-[10px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {b.notes ? (
                    <p className="line-clamp-1 text-xs text-muted-foreground" title={b.notes}>
                      📝 {b.notes}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-1 pt-0.5">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(b)}>
                      <Pencil className="size-3.5" />
                      编辑
                    </Button>
                    {r.sourceUrl ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        nativeButton={false}
                        render={<a href={r.sourceUrl} target="_blank" rel="noreferrer" />}
                      >
                        <ExternalLink className="size-3.5" />
                        原链
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 翻页 */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            第 {page} / {totalPages} 页（共 {total} 项）{loading ? " · 加载中…" : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => void load(collection, page - 1)}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || loading}
            onClick={() => void load(collection, page + 1)}
          >
            下一页
          </Button>
        </div>
      ) : null}

      {/* 编辑弹窗 */}
      <Dialog open={editTarget != null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>编辑收藏</DialogTitle>
            <DialogDescription>
              归入集合、标记优先级、写选品笔记（导出 Excel 会带上）。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitEdit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bm-collection">集合</Label>
              <Input
                id="bm-collection"
                placeholder="如：2026 春季选品（留空=未分组）"
                {...form.register("collectionName")}
              />
            </div>
            <div className="space-y-1.5">
              <Label>优先级</Label>
              <Select
                items={PRIORITY_OPTIONS}
                value={priorityValue}
                onValueChange={(v) => {
                  if (v != null) form.setValue("priority", String(v))
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bm-tags">标签</Label>
              <Input
                id="bm-tags"
                placeholder="逗号分隔，如：高潜力, 供应链易找"
                {...form.register("customTags")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bm-notes">笔记</Label>
              <Textarea
                id="bm-notes"
                rows={4}
                placeholder="选品理由、跟进事项、供应商信息…"
                {...form.register("notes")}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                取消
              </Button>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`移除 ${selected.size} 项收藏？`}
        description="仅移除收藏，不影响已抓取的数据；移除后不可恢复。"
        confirmText="移除"
        destructive
        onConfirm={() => void doRemove()}
      />
    </div>
  )
}
