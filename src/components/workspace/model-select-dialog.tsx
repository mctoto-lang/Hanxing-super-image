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
import { cn, toImageSrc } from "@/lib/utils"
import { Check, Cpu } from "lucide-react"
import { listWorkspaceModelsAction } from "@/server/actions/workspace"
import type { ImageModelRow } from "@/lib/workspace/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: ImageModelRow | null
  onSelect: (m: ImageModelRow) => void
}

export function ModelSelectDialog({
  open,
  onOpenChange,
  selected,
  onSelect,
}: Props) {
  const [models, setModels] = useState<ImageModelRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    listWorkspaceModelsAction()
      .then((rows) => {
        if (cancelled) return
        const mapped: ImageModelRow[] = rows.map((m) => ({
          id: m.id,
          name: m.name,
          displayName: m.displayName,
          sizePresets: m.sizePresets,
          iconUrl: m.iconUrl,
          supportsReferenceImage: m.supportsReferenceImage,
          maxReferenceImages: m.maxReferenceImages,
          costPerImage: m.costPerImage,
        }))
        setModels(mapped)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>选择图片模型</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {loading ? (
            <Spinner />
          ) : models.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              暂无可用模型
            </p>
          ) : (
            models.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelect(m)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left transition-colors",
                  selected?.id === m.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent",
                )}
              >
                {m.iconUrl ? (
                  // 远程动态图标，经存储代理加载；尺寸/来源不可控，沿用 <img>
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={toImageSrc(m.iconUrl)}
                    alt=""
                    className="h-8 w-8 rounded object-cover shrink-0"
                  />
                ) : (
                  <div className="h-8 w-8 rounded bg-muted flex items-center justify-center shrink-0">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {m.displayName || m.name}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {m.name}
                  </p>
                </div>
                {selected?.id === m.id && (
                  <Check className="h-4 w-4 text-primary shrink-0" />
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
