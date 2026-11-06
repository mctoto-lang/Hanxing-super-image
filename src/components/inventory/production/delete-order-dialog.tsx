"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"

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
import { deleteProductionOrderAction, type ProductionOrderRow } from "@/server/actions/inventory-production"

/** 删除生产单弹窗（有直发/入库记录自动反向冲正） */

export function DeleteOrderDialog({
  order,
  onOpenChange,
  onDone,
}: {
  order: ProductionOrderRow | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [reason, setReason] = React.useState("")
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (order) setReason("")
  }, [order])

  const hasRecords = Boolean(order && (order.directQty > 0 || order.shippedQty > 0))

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>删除生产单 · {order?.productCode}</DialogTitle>
          <DialogDescription>
            {hasRecords
              ? `该单已有直发 ${order!.directQty} 件、入库 ${order!.shippedQty} 件，删除将自动生成反向冲正流水（冲正后库存可能为负，需盘点修正）。`
              : "该单无任何直发/入库记录，将直接删除。"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="del-reason">删除原因 *</Label>
          <Input
            id="del-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="如：建错单/重复单"
            className="h-9"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              order &&
              startSubmit(async () => {
                if (!reason.trim()) {
                  toast.error("请填写删除原因")
                  return
                }
                const r = await deleteProductionOrderAction({
                  orderId: order.id,
                  reason: reason.trim(),
                })
                if (r.ok) {
                  toast.success(
                    r.reversed > 0 ? `已删除并生成 ${r.reversed} 条冲正流水` : "生产单已删除",
                  )
                  onOpenChange(false)
                  onDone()
                } else toast.error(r.error)
              })
            }
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
