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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { addDirectShipAction, type ProductionOrderRow } from "@/server/actions/inventory-production"
import { todayStr } from "./shared"

/** 工厂直发登记弹窗（TEMU 备货直发不动库存；直发入自有仓=单仓制固定主仓） */

export function DirectShipDialog({
  order,
  onOpenChange,
  onDone,
}: {
  order: ProductionOrderRow | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [destType, setDestType] = React.useState<"temu" | "warehouse">("temu")
  const [qty, setQty] = React.useState("")
  const [boxQty, setBoxQty] = React.useState("")
  const [shipDate, setShipDate] = React.useState(todayStr())
  const [temuRef, setTemuRef] = React.useState("")
  const [note, setNote] = React.useState("")
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (order) {
      setDestType("temu")
      setQty("")
      setBoxQty("")
      setShipDate(todayStr())
      setTemuRef("")
      setNote("")
    }
  }, [order])

  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>工厂代发 · {order?.productCode}</DialogTitle>
          <DialogDescription>
            剩余可发 {order?.remainQty ?? 0} 件。TEMU 备货直发不动库存；
            直发入自有仓计入库存。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>目的地 *</Label>
              <Select
                value={destType}
                onValueChange={(v) => v && setDestType(v as "temu" | "warehouse")}
                items={[
                  { value: "temu", label: "TEMU 备货直发（不入库）" },
                  { value: "warehouse", label: "直发入自有仓（计库存）" },
                ]}
              >
                <SelectTrigger className="h-9!">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="temu">TEMU 备货直发（不入库）</SelectItem>
                  <SelectItem value="warehouse">直发入自有仓（计库存）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {destType === "warehouse" ? (
              <div className="grid gap-1.5">
                <Label>入仓</Label>
                <div className="flex h-9 items-center rounded-lg border border-input bg-muted/40 px-2.5 text-sm text-muted-foreground">
                  主仓（固定）
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="ds-ref">TEMU 单号备注</Label>
                <Input
                  id="ds-ref"
                  value={temuRef}
                  onChange={(e) => setTemuRef(e.target.value)}
                  placeholder="备货单/发货单号，选填"
                  className="h-9"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ds-qty">件数 *</Label>
              <Input
                id="ds-qty"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ds-box">箱数</Label>
              <Input
                id="ds-box"
                value={boxQty}
                onChange={(e) => setBoxQty(e.target.value)}
                inputMode="numeric"
                placeholder="选填"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ds-date">日期 *</Label>
              <Input
                id="ds-date"
                type="date"
                value={shipDate}
                onChange={(e) => setShipDate(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ds-note">备注</Label>
            <Input
              id="ds-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
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
                const qtyN = Number.parseInt(qty, 10)
                if (!Number.isInteger(qtyN) || qtyN <= 0) {
                  toast.error("件数须为正整数")
                  return
                }
                const boxN = boxQty.trim() ? Number.parseInt(boxQty, 10) : null
                const r = await addDirectShipAction({
                  orderId: order.id,
                  shipDate,
                  qty: qtyN,
                  boxQty: boxN,
                  destType,
                  temuRef: temuRef.trim() || null,
                  note: note.trim() || null,
                })
                if (r.ok) {
                  toast.success("直发已登记")
                  onOpenChange(false)
                  onDone()
                } else toast.error(r.error)
              })
            }
          >
            {pending && <DashRing className="size-3.5" />}
            确认直发
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
