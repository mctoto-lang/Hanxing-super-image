"use client"

import * as React from "react"
import { Layers, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { MockupGroupView } from "@/lib/mockup/types"
import { createMockupCardAction } from "@/server/actions/mockup"

/** 创建卡片弹窗（选择大模板 → 下方新增一张渲染卡片） */
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
  const [selected, setSelected] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (open) setSelected(null)
  }, [open])

  const handleCreate = async () => {
    if (!selected) {
      toast.error("请选择一个大模板")
      return
    }
    setCreating(true)
    try {
      const res = await createMockupCardAction(selected)
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
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>创建渲染卡片</DialogTitle>
          <DialogDescription>
            选择一个大模板（套组），将在下方新增一张卡片；同一大模板可创建多张
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {groups.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              还没有大模板，请先在「模板管理」中创建
            </div>
          ) : (
            groups.map((g) => (
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
                  <span className="block truncate text-sm font-medium">{g.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {g.items.length} 个样机：
                    {g.items.map((i) => i.displayName).join("、")}
                  </span>
                </span>
              </button>
            ))
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
