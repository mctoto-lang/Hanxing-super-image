"use client"

/**
 * 桌面（≥sm）居中 Dialog / 移动端底部 Sheet 的双壳弹窗。
 * 两壳共享同一份受控状态与内容；水合后按视口二选一渲染，
 * 避免双挂载导致的焦点争夺。
 */
import { useEffect, useState, type ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true)
  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)")
    const update = () => setIsDesktop(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return isDesktop
}

export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  badge,
  description,
  children,
  desktopClassName,
  mobileClassName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  badge?: ReactNode
  description?: ReactNode
  children: ReactNode
  desktopClassName?: string
  mobileClassName?: string
}) {
  const isDesktop = useIsDesktop()

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("gap-4", desktopClassName)}>
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {title}
              {badge}
            </DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn("max-h-[92svh] gap-4 overflow-y-auto rounded-t-2xl p-4 pb-6", mobileClassName)}
      >
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {title}
            {badge}
          </SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  )
}
