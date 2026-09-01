"use client"

import * as React from "react"
import { Loader2, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** 渲染确认弹窗（张数 × 单价 = 总积分；余额不足时禁止提交） */
export function RenderConfirmDialog({
  open,
  onOpenChange,
  title,
  count,
  cost,
  creditsBalance,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  count: number
  cost: number
  creditsBalance: number
  onConfirm: () => Promise<void>
}) {
  const [confirming, setConfirming] = React.useState(false)
  const insufficient = creditsBalance < cost

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !confirming && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            共 {count} 个样机 · {cost} 积分（当前余额 {creditsBalance}）
          </DialogDescription>
        </DialogHeader>
        {insufficient ? (
          <p className="text-sm text-destructive">
            个人配额不足（需要 {cost}，当前 {creditsBalance}），请先联系管理员分配配额
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={insufficient || confirming}
            onClick={() => void handleConfirm()}
          >
            {confirming ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            开始渲染
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
