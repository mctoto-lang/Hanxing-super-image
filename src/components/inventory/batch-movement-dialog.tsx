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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { batchMovementAction } from "@/server/actions/inventory-batch-export"
import { MANUAL_IN_KINDS, MANUAL_OUT_KINDS } from "./labels"
import {
  MovementModeSwitch,
  type MovementDialogMode,
} from "./movement-dialogs"
import type { InventoryOverviewRow } from "@/server/actions/inventory"

/**
 * 批量变动弹窗（入库/出库两段切换；单仓制无调拨）：
 * 多选货号同类型同原因，数量逐行填（单事务全成全败）
 */

export function BatchMovementDialog({
  open,
  products,
  onOpenChange,
  onDone,
}: {
  open: boolean
  products: InventoryOverviewRow[]
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const [mode, setMode] = React.useState<MovementDialogMode>("in")
  const [kind, setKind] = React.useState<string>(MANUAL_IN_KINDS[0])
  const [reason, setReason] = React.useState("")
  const [qtyMap, setQtyMap] = React.useState<Record<string, string>>({})
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (open) {
      setMode("in")
      setKind(MANUAL_IN_KINDS[0])
      setReason("")
      setQtyMap({})
    }
  }, [open])

  /** 弹窗内切换功能：类型回到该功能默认值 */
  const switchMode = (m: MovementDialogMode) => {
    if (m === mode) return
    setMode(m)
    setKind(m === "out" ? MANUAL_OUT_KINDS[0] : MANUAL_IN_KINDS[0])
  }

  const submit = () => {
    if (!reason.trim()) {
      toast.error("原因必填")
      return
    }
    const items: Array<{ productId: string; qty: number }> = []
    for (const p of products) {
      const v = qtyMap[p.id]?.trim()
      if (!v) continue
      const n = Number.parseInt(v, 10)
      if (!Number.isInteger(n) || n <= 0) {
        toast.error(`${p.productCode} 数量须为正整数`)
        return
      }
      items.push({ productId: p.id, qty: n })
    }
    if (items.length === 0) {
      toast.error("请至少为一个货号填写数量")
      return
    }
    startSubmit(async () => {
      const r = await batchMovementAction({
        mode,
        type: mode === "in" && kind === "退货入库" ? "return_in" : undefined,
        reason: `${kind}：${reason.trim()}`,
        items,
      })
      if (r.ok) {
        toast.success(`批量${mode === "out" ? "出库" : "入库"}完成（${r.count} 个货号）`)
        onOpenChange(false)
        onDone?.()
      } else toast.error(r.error)
    })
  }

  const verb = mode === "out" ? "出库" : "入库"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>批量{verb}（{products.length} 个货号）</DialogTitle>
          <DialogDescription>
            同类型同原因单事务提交，任一货号库存不足整批回滚；不填数量的行跳过。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <MovementModeSwitch value={mode} onChange={switchMode} />
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>类型 *</Label>
              <Select value={kind} onValueChange={(v) => v && setKind(v)}>
                <SelectTrigger className="h-9! w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(mode === "out" ? MANUAL_OUT_KINDS : MANUAL_IN_KINDS).map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bm-reason">原因 *</Label>
              <Input
                id="bm-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="如：亚马逊补货"
                className="h-9"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto scrollbar-hide">
            {products.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs">
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.imageUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">—</span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-normal">{p.productCode}</span>
                  <span className="ml-1 text-muted-foreground">{p.name}</span>
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">现有 {p.totalQty}</span>
                <Input
                  value={qtyMap[p.id] ?? ""}
                  onChange={(e) => setQtyMap((m) => ({ ...m, [p.id]: e.target.value }))}
                  inputMode="numeric"
                  placeholder="件数"
                  className="h-7 w-20 text-xs"
                />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            确认批量{verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
