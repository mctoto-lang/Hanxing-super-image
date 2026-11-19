"use client"

import * as React from "react"
import { DashRing } from "@/components/ui/dash-ring"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
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
import { adjustStockAction, manualMovementAction } from "@/server/actions/inventory"
import { MANUAL_IN_KINDS, MANUAL_OUT_KINDS } from "./labels"
import { ProductPicker, type PickedProduct } from "./product-picker"

/**
 * 手动出入库弹窗（单仓制：仓库固定主仓无需选择；弹窗内入库/出库/调整三段切换；
 * 箱+件双输入件数为准；原因必填；调整=输入目标库存按差值自动生成盘点流水）
 */

export type MovementDialogMode = "in" | "out" | "adjust"

export interface MovementDialogTarget {
  /** 预选功能（不传默认入库，弹窗内可随时切换） */
  mode?: MovementDialogMode
  /**
   * totalQty=主仓当前库存（调整段差值预览基准，与服务端固定主仓的写入口径一致；
   * 总览行操作传 r.mainQty）
   */
  product?: { id: string; productCode: string; name: string; totalQty?: number } | null
}

const DIALOG_META: Record<MovementDialogMode, { title: string; desc: string }> = {
  in: { title: "手动入库", desc: "类型：其他入库 / 退货入库" },
  out: {
    title: "手动出库",
    desc: "其他渠道出库（亚马逊等）/ 报损 / 样品领用 / 直发其他",
  },
  adjust: {
    title: "库存调整",
    desc: "输入当前仓库库存，按差值自动生成盘点入库/出库流水",
  },
}

const MODE_LABELS: Record<MovementDialogMode, string> = { in: "入库", out: "出库", adjust: "调整" }

/** 入库/出库（/调整）分段切换（单笔与批量变动弹窗共用；单仓制已无调拨；
 *  批量弹窗保持默认两段，单笔弹窗传三段） */
export function MovementModeSwitch({
  value,
  onChange,
  modes = ["in", "out"],
}: {
  value: MovementDialogMode
  onChange: (mode: MovementDialogMode) => void
  /** 分段集合：单笔弹窗传 ["in","out","adjust"]，批量弹窗默认两段 */
  modes?: MovementDialogMode[]
}) {
  return (
    <div className="inline-flex h-8 w-full items-center rounded-lg bg-muted p-0.5 text-xs">
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          className={cn(
            "flex-1 rounded-md px-2 py-1 transition-colors",
            value === m
              ? "bg-background font-normal shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(m)}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  )
}

/** ProductPicker 选中值；searchProductsAction 行附带 mainQty（主仓库存，调整段基准） */
type PickedProductRow = PickedProduct & { mainQty?: number }

export function MovementDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: MovementDialogTarget | null
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const [mode, setMode] = React.useState<MovementDialogMode>("in")
  const meta = DIALOG_META[mode]
  const [product, setProduct] = React.useState<PickedProductRow | null>(null)
  const [kind, setKind] = React.useState<string>("其他入库")
  const [qty, setQty] = React.useState("")
  const [boxQty, setBoxQty] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (!target) return
    const initMode = target.mode ?? "in"
    setMode(initMode)
    setProduct(
      target.product
        ? {
            id: target.product.id,
            productCode: target.product.productCode,
            name: target.product.name,
            imageUrl: null,
            totalQty: target.product.totalQty ?? 0,
          }
        : null,
    )
    setKind(initMode === "out" ? MANUAL_OUT_KINDS[0] : MANUAL_IN_KINDS[0])
    setQty("")
    setBoxQty("")
    setReason("")
  }, [target])

  /** 弹窗内切换功能：保留货号/件数/原因，类型回到该功能默认值（调整段无类型） */
  const switchMode = (m: MovementDialogMode) => {
    if (m === mode) return
    setMode(m)
    if (m !== "adjust") setKind(m === "out" ? MANUAL_OUT_KINDS[0] : MANUAL_IN_KINDS[0])
  }

  /** 调整段当前库存基准：选中行优先主仓量（与写入口径一致），缺省回落 totalQty */
  const currentQty = product ? (product.mainQty ?? product.totalQty) : 0

  /** 调整段差值预览（目标−当前；null=未选货号或未输入/非法目标值） */
  const adjustDiff = (() => {
    if (!product || qty.trim() === "") return null
    const t = Number.parseInt(qty, 10)
    if (!Number.isInteger(t) || t < 0) return null
    return t - currentQty
  })()

  const adjustHint = (() => {
    const current = currentQty
    if (!product || adjustDiff == null)
      return `当前库存 ${current} 件；输入目标值后按差值自动生成盘点入库/出库`
    if (adjustDiff === 0) return `当前库存 ${current} 件；与目标一致，无需调整`
    if (adjustDiff > 0) return `当前库存 ${current} 件；提交后盘点入库 +${adjustDiff} 件`
    return `当前库存 ${current} 件；提交后盘点出库 ${adjustDiff} 件`
  })()

  const submit = () => {
    if (!product) {
      toast.error("请选择货号")
      return
    }
    if (mode === "adjust") {
      const targetN = Number.parseInt(qty, 10)
      if (!Number.isInteger(targetN) || targetN < 0) {
        toast.error("目标库存须为非负整数")
        return
      }
      if (!reason.trim()) {
        toast.error("原因必填")
        return
      }
      startSubmit(async () => {
        const r = await adjustStockAction({
          productId: product.id,
          targetQty: targetN,
          reason: reason.trim(),
        })
        if (r.ok) {
          toast.success("调整完成，已生成盘点流水")
          onOpenChange(false)
          onDone?.()
        } else {
          toast.error(r.error)
        }
      })
      return
    }
    const qtyN = Number.parseInt(qty, 10)
    if (!Number.isInteger(qtyN) || qtyN <= 0) {
      toast.error("件数须为正整数")
      return
    }
    const boxN = boxQty.trim() ? Number.parseInt(boxQty, 10) : null
    if (boxN != null && (!Number.isInteger(boxN) || boxN <= 0)) {
      toast.error("箱数须为正整数（留空不记）")
      return
    }
    if (!reason.trim()) {
      toast.error("原因必填")
      return
    }

    startSubmit(async () => {
      const r = await manualMovementAction({
        productId: product.id,
        type:
          mode === "out"
            ? "manual_out"
            : kind === "退货入库"
              ? "return_in"
              : "manual_in",
        qty: qtyN,
        boxQty: boxN,
        reason: `${kind}：${reason.trim() || "—"}`,
      })
      if (r.ok) {
        toast.success(mode === "out" ? "出库完成" : "入库完成")
        onOpenChange(false)
        onDone?.()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{meta.title}</DialogTitle>
          <DialogDescription>{meta.desc}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <MovementModeSwitch value={mode} onChange={switchMode} modes={["in", "out", "adjust"]} />
          <div className="grid gap-1.5">
            <Label>货号 *</Label>
            <ProductPicker value={product} onChange={setProduct} />
          </div>
          {mode === "adjust" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="md-target">目标库存（件）*</Label>
              <Input
                id="md-target"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
                placeholder="输入当前实际库存"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">{adjustHint}</p>
            </div>
          ) : (
            <>
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
                  <Label htmlFor="md-qty">件数 *</Label>
                  <Input
                    id="md-qty"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    inputMode="numeric"
                    placeholder="以件数为准"
                    className="h-9"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="md-box">箱数</Label>
                <Input
                  id="md-box"
                  value={boxQty}
                  onChange={(e) => setBoxQty(e.target.value)}
                  inputMode="numeric"
                  placeholder="选填（尾数箱）"
                  className="h-9"
                />
              </div>
            </>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="md-reason">原因 *</Label>
            <Input
              id="md-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                mode === "adjust" ? "必填，如：月末盘点 校准库存" : "必填，如：亚马逊 FBA 补货 200 件"
              }
              className="h-9"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending && <DashRing className="size-3.5" />}
            确认{mode === "out" ? "出库" : mode === "adjust" ? "调整" : "入库"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
