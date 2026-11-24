"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Download, FolderInput, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DashRing } from "@/components/ui/dash-ring"
import { FilterSelect } from "@/components/selection/filter-select"
import { ResultCard } from "@/components/selection/result-card"
import { ResultDetailDialog } from "@/components/selection/result-detail-dialog"
import { SelectionEmpty } from "@/components/selection/empty-state"
import { BookmarkEditDialog } from "@/components/selection/mine/bookmark-edit-dialog"
import { platformLabel, SELECTION_PRIORITY_LABELS } from "@/components/selection/labels"
import { SELECTION_PLATFORMS, isSelectionPlatform } from "@/lib/selection/platforms"
import { BOOKMARK_SORTS, BOOKMARK_SORT_LABELS, isBookmarkSort, type BookmarkSort } from "@/lib/selection/pool-url"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"
import { formatDateTime } from "@/lib/datetime"
import {
  batchUpdateSelectionBookmarksAction,
  exportSelectionBookmarksExcelAction,
  removeSelectionBookmarksAction,
} from "@/server/actions/selection"
import { cn } from "@/lib/utils"

/**
 * 我的选品（收藏管理，个人维度）：集合 / 平台 / 优先级 / 关键词 / 排序筛选全部 URL
 * 驱动；卡片复用数据池的 ResultCard + 详情弹窗（多选模式）；批量条支持归入集合 /
 * 设优先级 / 移除；编辑弹窗维护笔记 / 标签 / 集合 / 优先级。
 */

export interface BookmarkItem {
  id: string
  resultId: string
  notes: string | null
  customTags: string[] | null
  collectionName: string | null
  priority: string | null
  createdAt: Date
  updatedAt: Date
  result: SelectionPoolItem
}

export interface MineFilter {
  /** 集合名；空串 = 未分组；缺省 = 全部 */
  collection: string
  platform: string
  priority: string
  q: string
  sort: BookmarkSort
}

const BASE_PATH = "/selection/mine"
/** URL 里「未分组」的哨兵值（空串在 URL 里无法与「全部」区分） */
const UNGROUPED = "__ungrouped__"
export const MINE_UNGROUPED = UNGROUPED

function buildQuery(filter: MineFilter, patch: Partial<MineFilter>, page = 1, pageSize?: number): string {
  const f = { ...filter, ...patch }
  const params = new URLSearchParams()
  if (f.collection) params.set("collection", f.collection)
  if (f.platform) params.set("platform", f.platform)
  if (f.priority) params.set("priority", f.priority)
  if (f.q) params.set("q", f.q)
  if (f.sort && f.sort !== "newest") params.set("sort", f.sort)
  if (page > 1) params.set("page", String(page))
  if (pageSize && pageSize !== 24) params.set("pageSize", String(pageSize))
  const qs = params.toString()
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH
}

/** 优先级徽标配色 */
const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  medium: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  low: "bg-muted text-muted-foreground",
}

export function SelectionMineClient({
  initialItems,
  initialTotal,
  page,
  collections,
  filter,
}: {
  initialItems: BookmarkItem[]
  initialTotal: number
  /** 当前页（URL 驱动，分页条在服务端渲染） */
  page: number
  /** 集合清单（null = 未分组），含计数 */
  collections: Array<{ name: string | null; count: number }>
  filter: MineFilter
}) {
  const router = useRouter()
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [editTarget, setEditTarget] = React.useState<BookmarkItem | null>(null)
  const [moveOpen, setMoveOpen] = React.useState(false)
  const [removeOpen, setRemoveOpen] = React.useState(false)
  const [openItem, setOpenItem] = React.useState<SelectionPoolItem | null>(null)
  const [pending, setPending] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)

  // 翻页 / 筛选变化后清空选择（服务端换页 = 新 props）
  React.useEffect(() => {
    setSelected(new Set())
  }, [initialItems])

  const push = (patch: Partial<MineFilter>) => router.push(buildQuery(filter, patch))

  const refresh = () => React.startTransition(() => router.refresh())

  const toggleSelect = (resultId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(resultId)) next.delete(resultId)
      else next.add(resultId)
      return next
    })
  }

  /** 取消收藏（卡片星标 / 详情弹窗里的收藏按钮都走这里） */
  const unbookmark = (resultId: string) => {
    void (async () => {
      const res = await removeSelectionBookmarksAction([resultId])
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success("已移除收藏")
      setSelected((s) => { const n = new Set(s); n.delete(resultId); return n })
      if (openItem?.id === resultId) setOpenItem(null)
      refresh()
    })()
  }

  const runBatch = async (fn: () => Promise<{ ok: boolean; error?: string }>, successText: string) => {
    setPending(true)
    try {
      const res = await fn()
      if (!res.ok) throw new Error(res.error ?? "操作失败")
      toast.success(successText)
      setSelected(new Set())
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败，请重试")
    } finally {
      setPending(false)
    }
  }

  const doExport = async () => {
    setExporting(true)
    try {
      const res = await exportSelectionBookmarksExcelAction({
        // URL 里 __ungrouped__ 表示未分组；action 用空串表示未分组、缺省表示全部。
        // 平台/优先级/关键词/排序与列表同口径一并传入：此前只传集合名，按平台或
        // 优先级筛完导出的是全部收藏
        collectionName: filter.collection === UNGROUPED ? "" : filter.collection || undefined,
        platform: filter.platform || undefined,
        priority: (filter.priority || undefined) as "high" | "medium" | "low" | undefined,
        q: filter.q || undefined,
        sort: filter.sort,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      const bin = atob(res.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      )
      const a = document.createElement("a")
      a.href = url
      a.download = res.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败")
    } finally {
      setExporting(false)
    }
  }

  const totalCount = collections.reduce((s, c) => s + c.count, 0)
  const ungrouped = collections.find((c) => c.name == null)?.count ?? 0
  const named = collections.filter((c) => c.name != null)
  const hasFilter = Boolean(filter.collection || filter.platform || filter.priority || filter.q || filter.sort !== "newest")

  return (
    <div className="space-y-4">
      {/* 集合 + 筛选 + 导出 */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          ariaLabel="集合筛选"
          placeholder="全部收藏"
          value={filter.collection}
          onChange={(v) => push({ collection: v })}
          items={[
            { value: "", label: `全部收藏（${totalCount}）` },
            ...(ungrouped > 0 ? [{ value: UNGROUPED, label: `未分组（${ungrouped}）` }] : []),
            ...named.map((c) => ({ value: c.name!, label: `${c.name}（${c.count}）` })),
          ]}
          width="w-44"
        />
        <FilterSelect
          ariaLabel="平台筛选"
          placeholder="全部平台"
          value={isSelectionPlatform(filter.platform) ? filter.platform : ""}
          onChange={(v) => push({ platform: v })}
          items={[{ value: "", label: "全部平台" }, ...SELECTION_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) }))]}
          width="w-32"
        />
        <FilterSelect
          ariaLabel="优先级筛选"
          placeholder="全部优先级"
          value={filter.priority}
          onChange={(v) => push({ priority: v })}
          items={[
            { value: "", label: "全部优先级" },
            { value: "high", label: "高" },
            { value: "medium", label: "中" },
            { value: "low", label: "低" },
          ]}
          width="w-30"
        />
        <FilterSelect
          ariaLabel="排序"
          placeholder="最近收藏"
          value={filter.sort}
          onChange={(v) => push({ sort: isBookmarkSort(v) ? v : "newest" })}
          items={(BOOKMARK_SORTS as readonly string[]).map((s) => ({ value: s, label: BOOKMARK_SORT_LABELS[s as BookmarkSort] }))}
          width="w-32"
        />
        <input
          type="search"
          aria-label="搜索收藏"
          placeholder="搜索标题 / 笔记"
          defaultValue={filter.q}
          maxLength={120}
          onKeyDown={(e) => {
            if (e.key === "Enter") push({ q: e.currentTarget.value.trim() })
          }}
          className="h-8 w-52 rounded-md border border-input bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={exporting || initialTotal === 0}
          onClick={() => void doExport()}
        >
          {exporting ? <DashRing className="size-4" /> : <Download className="size-4" />}
          导出 Excel
        </Button>
      </div>

      {/* 批量条 */}
      {selected.size > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 text-sm backdrop-blur">
          <span>已选 {selected.size} 项</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={() => setMoveOpen(true)}>
            <FolderInput className="size-3.5" />
            归入集合
          </Button>
          {(["high", "medium", "low"] as const).map((p) => (
            <Button
              key={p}
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() =>
                void runBatch(
                  () => batchUpdateSelectionBookmarksAction({ resultIds: [...selected], priority: p }),
                  `已设为${SELECTION_PRIORITY_LABELS[p]}优先级`,
                )
              }
            >
              设为{SELECTION_PRIORITY_LABELS[p]}
            </Button>
          ))}
          <Button
            variant="destructive"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={pending}
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2 className="size-3.5" />
            移除收藏
          </Button>
        </div>
      ) : null}

      {/* 卡片网格 */}
      {initialItems.length === 0 ? (
        <SelectionEmpty
          icon={<StarIcon />}
          title={hasFilter ? "没有符合筛选条件的收藏" : "暂无收藏"}
          description={
            hasFilter
              ? "试试切换集合或清除筛选。"
              : "在选品发现、市场分析的卡片上点星标即可收藏到这里，再按集合与优先级整理。"
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {initialItems.map((b) => (
              <ResultCard
                key={b.id}
                item={b.result}
                bookmarked
                selectable
                selected={selected.has(b.resultId)}
                onToggleSelect={toggleSelect}
                onToggleBookmark={unbookmark}
                onOpen={setOpenItem}
                footnote={<Footnote b={b} onEdit={() => setEditTarget(b)} />}
              />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            共 {initialTotal} 项 · 第 {page} 页
          </p>
        </>
      )}

      <ResultDetailDialog
        item={openItem}
        open={openItem !== null}
        onOpenChange={(o) => !o && setOpenItem(null)}
        bookmarked
        onToggleBookmark={unbookmark}
      />

      <BookmarkEditDialog
        resultId={editTarget?.resultId ?? ""}
        open={editTarget != null}
        initial={
          editTarget
            ? {
                collectionName: editTarget.collectionName,
                priority: editTarget.priority,
                customTags: editTarget.customTags,
                notes: editTarget.notes,
              }
            : null
        }
        collections={named.map((c) => c.name!)}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          toast.success("已保存")
          setEditTarget(null)
          refresh()
        }}
      />

      {/* 归入集合 */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>把 {selected.size} 项归入集合</DialogTitle>
            <DialogDescription>输入集合名（可新建）；留空表示移出分组。</DialogDescription>
          </DialogHeader>
          <MoveForm
            collections={named.map((c) => c.name!)}
            pending={pending}
            onCancel={() => setMoveOpen(false)}
            onSubmit={(name) =>
              runBatch(
                () => batchUpdateSelectionBookmarksAction({ resultIds: [...selected], collectionName: name }),
                name ? `已归入「${name}」` : "已移出分组",
              ).then(() => setMoveOpen(false))
            }
          />
        </DialogContent>
      </Dialog>

      <RemoveConfirm
        open={removeOpen}
        count={selected.size}
        pending={pending}
        onOpenChange={setRemoveOpen}
        onConfirm={() =>
          runBatch(() => removeSelectionBookmarksAction([...selected]), `已移除 ${selected.size} 项收藏`).then(() =>
            setRemoveOpen(false),
          )
        }
      />
    </div>
  )
}

/** 卡片下方：集合 / 优先级 / 自定义标签 / 笔记 + 编辑、原链 */
function Footnote({ b, onEdit }: { b: BookmarkItem; onEdit: () => void }) {
  return (
    <div className="space-y-1 px-0.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{platformLabel(b.result.platform)}</span>
        {b.collectionName ? (
          <span className="max-w-28 truncate rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
            {b.collectionName}
          </span>
        ) : null}
        {b.priority ? (
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", PRIORITY_BADGE[b.priority] ?? PRIORITY_BADGE.low)}>
            {SELECTION_PRIORITY_LABELS[b.priority] ?? b.priority}
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground">收藏于 {formatDateTime(b.createdAt)}</span>
      </div>
      {b.customTags && b.customTags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {b.customTags.slice(0, 4).map((t) => (
            <span key={t} className="rounded border px-1 py-px text-[10px] text-muted-foreground">
              {t}
            </span>
          ))}
          {b.customTags.length > 4 ? (
            <span className="rounded border px-1 py-px text-[10px] text-muted-foreground">+{b.customTags.length - 4}</span>
          ) : null}
        </div>
      ) : null}
      {b.notes ? <p className="line-clamp-2 text-[11px] text-muted-foreground">{b.notes}</p> : null}
      <div className="flex items-center gap-1 pt-0.5">
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onEdit}>
          <Pencil className="size-3" />
          编辑
        </Button>
        {b.result.sourceUrl ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            nativeButton={false}
            render={<a href={b.result.sourceUrl} target="_blank" rel="noreferrer" />}
          >
            原链
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8L12 3z" strokeLinejoin="round" />
    </svg>
  )
}

function MoveForm({
  collections,
  pending,
  onCancel,
  onSubmit,
}: {
  collections: string[]
  pending: boolean
  onCancel: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState("")
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit(name.trim())
      }}
      className="space-y-2"
    >
      <Input
        autoFocus
        value={name}
        maxLength={100}
        placeholder="如：2026 春季选品（留空 = 移出分组）"
        list="mine-collection-options"
        onChange={(e) => setName(e.target.value)}
      />
      <datalist id="mine-collection-options">
        {collections.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <DashRing className="size-4" /> : null}
          确定
        </Button>
      </DialogFooter>
    </form>
  )
}

function RemoveConfirm({
  open,
  count,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  count: number
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>移除 {count} 项收藏？</DialogTitle>
          <DialogDescription>仅移除收藏，不影响已抓取的数据；移除后不可恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => void onConfirm()}>
            移除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
