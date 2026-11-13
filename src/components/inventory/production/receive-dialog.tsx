"use client"

import * as React from "react"
import { DashRing } from "@/components/ui/dash-ring"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { receiveProductionAction, type ProductionOrderRow } from "@/server/actions/inventory-production"

/** 生产入库弹窗（支持分批，累计满量自动转「已入库」；单仓制固定主仓） */

export function ReceiveDialog({
  order,
  onOpenChange,
  onDone,
}: {
  order: ProductionOrderRow | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [qty, setQty] = React.useState("")
  const [boxQty, setBoxQty] = React.useState("")
  const [note, setNote] = React.useState("")
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (order) {
      setQty(String(Math.max(0, order.remainQty)))
      setBoxQty("")
      setNote("")
    }
  }, [order])

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>货物入库 · {order?.productCode}</DialogTitle>
          <DialogDescription>
            剩余待入库 {order?.remainQty ?? 0} 件；支持分批，累计满量自动转「已入库」。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>入仓</Label>
              <div className="flex h-9 items-center rounded-lg border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground">
                主仓（固定）
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rv-qty">件数 *</Label>
              <Input
                id="rv-qty"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
                className="h-9"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rv-box">箱数</Label>
              <Input
                id="rv-box"
                value={boxQty}
                onChange={(e) => setBoxQty(e.target.value)}
                inputMode="numeric"
                placeholder="选填（尾数箱）"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rv-note">备注</Label>
              <Input
                id="rv-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              order &&
              startSubmit(async () => {
                const qtyN = Number.parseInt(qty, 10)
                if (!Number.isInteger(qtyN) || qtyN <= 0) {
                  toast.error("件数须为正整数")
                  return
                }
                const boxN = boxQty.trim() ? Number.parseInt(boxQty, 10) : null
                const r = await receiveProductionAction({
                  orderId: order.id,
                  qty: qtyN,
                  boxQty: boxN,
                  note: note.trim() || null,
                })
                if (r.ok) {
                  toast.success("入库完成")
                  onOpenChange(false)
                  onDone()
                } else toast.error(r.error)
              })
            }
          >
            {pending && <DashRing className="size-3.5" />}
            确认入库
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
