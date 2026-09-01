"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/workspace/spinner"
import { cn } from "@/lib/utils"
import { Check } from "lucide-react"
import { listTemplatesAction } from "@/server/actions/workspace"
import type { TemplateRow, TemplateType } from "@/lib/workspace/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: TemplateType
  selected: TemplateRow | null
  onSelect: (t: TemplateRow) => void
}

const typeLabels: Record<TemplateType, string> = {
  fission: "裂变",
  deepen: "细化",
  regenerate: "重生成",
  extract: "提取",
  translate: "翻译",
}

export function TemplateSelectDialog({
  open,
  onOpenChange,
  type,
  selected,
  onSelect,
}: Props) {
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    listTemplatesAction({ type })
      .then((rows) => {
        if (cancelled) return
        setTemplates(rows)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, type])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>选择{typeLabels[type]}模板</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {loading ? (
            <Spinner />
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              暂无模板，请先在管理后台创建
            </p>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                onClick={() => onSelect(t)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2.5 rounded-md border text-left transition-colors",
                  selected?.id === t.id
                    ? "border-primary bg-primary/5 text-primary"
                    : "border-border hover:bg-accent",
                )}
              >
                <div>
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t.chatApiName || "未关联API"}
                    {t.fissionCount ? ` · ${t.fissionCount} 条` : ""}
                  </p>
                </div>
                {selected?.id === t.id && (
                  <Check className="h-4 w-4 shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
