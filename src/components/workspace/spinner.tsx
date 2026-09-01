"use client"

import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { cn } from "@/lib/utils"

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center p-8", className)}>
      <MorphingInfinity className="h-8 w-8 text-primary" />
    </div>
  )
}
