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
import { registerFactoryShipAction, type ProductionOrderRow } from "@/server/actions/inventory-production"
import { todayStr } from "./shared"

/** 登记工厂发货弹窗（转「工厂已发（待入库）」） */

export function FactoryShipDialog({
  order,
  onOpenChange,
  onDone,
}: {
  order: ProductionOrderRow | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [boxQty, setBoxQty] = React.useState("")
  const [shipDate, setShipDate] = React.useState(todayStr())
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (order) {
      setBoxQty(order.factoryBoxQty != null ? String(order.factoryBoxQty) : "")
      setShipDate(order.factoryShipDate ?? todayStr())
    }
  }, [order])

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>工厂出货 · {order?.productCode}</DialogTitle>
          <DialogDescription>
            确认后状态转为「工厂已发（待入库）」，之后可登记直发/入库。
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="fs-box">工厂发货箱数</Label>
            <Input
              id="fs-box"
              value={boxQty}
              onChange={(e) => setBoxQty(e.target.value)}
              inputMode="numeric"
              placeholder="选填"
              className="h-9"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fs-date">发货日期 *</Label>
            <Input
              id="fs-date"
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
              className="h-9"
            />
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
                const boxN = boxQty.trim() ? Number.parseInt(boxQty, 10) : null
                if (boxN != null && (!Number.isInteger(boxN) || boxN <= 0)) {
                  toast.error("箱数须为正整数")
                  return
                }
                const r = await registerFactoryShipAction({
                  orderId: order.id,
                  boxQty: boxN,
                  shipDate,
                })
                if (r.ok) {
                  toast.success("已登记工厂发货")
                  onOpenChange(false)
                  onDone()
                } else toast.error(r.error)
              })
            }
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
