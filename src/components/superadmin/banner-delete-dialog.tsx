"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { deleteBannerAction } from "@/server/actions/platform-banners"

/** 删除横幅（二次确认） */
export function BannerDeleteButton({ id, title }: { id: string; title: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const confirmDelete = async () => {
    setLoading(true)
    try {
      const res = await deleteBannerAction({ id })
      if (!res.ok) {
        toast.error(res.error ?? "删除失败")
        return
      }
      toast.success("横幅已删除")
      setOpen(false)
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
        aria-label="删除横幅"
      >
        <Trash2 className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>删除横幅</DialogTitle>
          <DialogDescription>
            确定删除「{title}」？删除后立即从全站轮换中移除，且不可恢复。
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={loading}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
