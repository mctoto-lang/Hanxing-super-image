"use client"

import * as React from "react"
import { DashRing } from "@/components/ui/dash-ring"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { sendMaterialsAction, type ProductionOrderRow } from "@/server/actions/inventory-production"

/** 发材料弹窗（确认辅料清单，确认后进入「生产中」） */

export function SendMaterialsDialog({
  order,
  onOpenChange,
  onDone,
}: {
  order: ProductionOrderRow | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [aux, setAux] = React.useState({ barcode: false, manual: false, bubble: false, warn: false })
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (order) setAux(order.aux)
  }, [order])

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>发材料 · {order?.productCode}</DialogTitle>
          <DialogDescription>
            确认随材料发工厂的辅料清单，确认后进入「生产中」。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["barcode", "条码"],
              ["manual", "说明书"],
              ["bubble", "气泡袋"],
              ["warn", "警告标"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5">
              <Checkbox
                checked={aux[k]}
                onCheckedChange={(v) => setAux((a) => ({ ...a, [k]: v === true }))}
              />
              {label}
            </label>
          ))}
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
                // 服务端 zod 键名为 auxBarcode/...（曾用短名 ...aux 被 strip，辅料恒 false）
                const r = await sendMaterialsAction({
                  orderId: order.id,
                  auxBarcode: aux.barcode,
                  auxManual: aux.manual,
                  auxBubble: aux.bubble,
                  auxWarn: aux.warn,
                })
                if (r.ok) {
                  toast.success("已发材料，进入生产中")
                  onOpenChange(false)
                  onDone()
                } else toast.error(r.error)
              })
            }
          >
            {pending && <DashRing className="size-3.5" />}
            确认发材料
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
