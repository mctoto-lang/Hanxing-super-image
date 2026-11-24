"use client"

import * as React from "react"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm, useWatch } from "react-hook-form"
import { z } from "zod"
import { DashRing } from "@/components/ui/dash-ring"
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
import { SELECTION_PRIORITY_LABELS } from "@/components/selection/labels"
import { updateSelectionBookmarkAction } from "@/server/actions/selection"
import { cn } from "@/lib/utils"

/**
 * 编辑收藏（全站统一的 RHF + zod 口径）：集合 / 优先级 / 标签 / 笔记。
 * 优先级用分段按钮（RHF 受控），集合输入带既有集合的 datalist。
 */

const editSchema = z.object({
  collectionName: z.string().trim().max(100, "集合名过长"),
  priority: z.string(),
  customTags: z.string().max(200, "标签过长"),
  notes: z.string().max(2000, "笔记过长"),
})
type EditValues = z.input<typeof editSchema>

const PRIORITIES = ["high", "medium", "low"] as const

export function BookmarkEditDialog({
  resultId,
  open,
  initial,
  collections,
  onClose,
  onSaved,
}: {
  resultId: string
  open: boolean
  initial: {
    collectionName: string | null
    priority: string | null
    customTags: string[] | null
    notes: string | null
  } | null
  /** 既有集合名（datalist 建议） */
  collections: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const form = useForm<EditValues>({
    resolver: standardSchemaResolver(editSchema),
    defaultValues: {
      collectionName: initial?.collectionName ?? "",
      priority: initial?.priority ?? "medium",
      customTags: (initial?.customTags ?? []).join(", "),
      notes: initial?.notes ?? "",
    },
  })
  const pending = form.formState.isSubmitting
  // useWatch 而非内联 form.watch（react-compiler 兼容，见 react-hooks/incompatible-library）
  const priority = useWatch({ control: form.control, name: "priority" })

  // 每次打开以当前收藏内容回填
  React.useEffect(() => {
    if (open) {
      form.reset({
        collectionName: initial?.collectionName ?? "",
        priority: initial?.priority ?? "medium",
        customTags: (initial?.customTags ?? []).join(", "),
        notes: initial?.notes ?? "",
      })
    }
  }, [open, initial, form])

  const submit = form.handleSubmit(async (v) => {
    const res = await updateSelectionBookmarkAction({
      resultId,
      notes: v.notes.trim() || null,
      collectionName: v.collectionName.trim() || null,
      priority: PRIORITIES.includes(v.priority as (typeof PRIORITIES)[number]) ? v.priority : null,
      customTags: v.customTags.trim()
        ? v.customTags
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 10)
        : null,
    })
    if (!res.ok) {
      form.setError("root.serverError", { message: res.error })
      return
    }
    onSaved()
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>编辑收藏</DialogTitle>
          <DialogDescription>归入集合、标记优先级、写选品笔记（导出 Excel 会带上）。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="bm-collection" className="text-sm font-medium">
              集合
            </label>
            <Input
              id="bm-collection"
              placeholder="如：2026 春季选品（留空 = 未分组）"
              list="mine-edit-collection-options"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.collectionName)}
              {...form.register("collectionName")}
            />
            <datalist id="mine-edit-collection-options">
              {collections.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {form.formState.errors.collectionName ? (
              <p className="text-xs text-destructive">{form.formState.errors.collectionName.message}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">优先级</p>
            <div className="flex gap-1.5" role="group" aria-label="优先级">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={priority === p}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs transition-colors",
                    priority === p
                      ? "border-primary bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  onClick={() => form.setValue("priority", p, { shouldDirty: true })}
                >
                  {SELECTION_PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bm-tags" className="text-sm font-medium">
              标签
            </label>
            <Input
              id="bm-tags"
              placeholder="逗号分隔，如：高潜力, 供应链易找"
              aria-invalid={Boolean(form.formState.errors.customTags)}
              {...form.register("customTags")}
            />
            {form.formState.errors.customTags ? (
              <p className="text-xs text-destructive">{form.formState.errors.customTags.message}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bm-notes" className="text-sm font-medium">
              笔记
            </label>
            <textarea
              id="bm-notes"
              rows={4}
              placeholder="选品理由、跟进事项、供应商信息…"
              aria-invalid={Boolean(form.formState.errors.notes)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              {...form.register("notes")}
            />
            {form.formState.errors.notes ? (
              <p className="text-xs text-destructive">{form.formState.errors.notes.message}</p>
            ) : null}
          </div>

          {form.formState.errors.root?.serverError ? (
            <p className="text-sm text-destructive">{form.formState.errors.root.serverError.message}</p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <DashRing className="size-4" /> : null}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
