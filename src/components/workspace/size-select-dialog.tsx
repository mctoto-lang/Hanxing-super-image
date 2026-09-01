"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { Check } from "lucide-react"
import { resolveSizePresets } from "@/lib/image-sizes"
import type { ImageModelRow } from "@/lib/workspace/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  model: ImageModelRow | null
  selected: string | null
  onSelect: (size: string) => void
}

export function SizeSelectDialog({
  open,
  onOpenChange,
  model,
  selected,
  onSelect,
}: Props) {
  const sizes = resolveSizePresets(model?.sizePresets)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>选择出图尺寸</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {sizes.map((s) => (
            <button
              key={s.value}
              onClick={() => onSelect(s.value)}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2.5 rounded-md border text-left transition-colors",
                selected === s.value
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border hover:bg-accent"
              )}
            >
              <div>
                <p className="text-sm font-medium">{s.label}</p>
                <p className="text-xs text-muted-foreground">{s.value}</p>
              </div>
              {selected === s.value && <Check className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
