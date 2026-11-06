"use client"

import * as React from "react"
import { toast } from "sonner"
import { format } from "date-fns"
import { CalendarIcon, Loader2 } from "lucide-react"
import { zhCN } from "react-day-picker/locale"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox } from "@/components/ui/checkbox"
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createProductionOrderAction,
  updateProductionOrderAction,
  type ProductionOrderRow,
} from "@/server/actions/inventory-production"
import { ProductPicker, type PickedProduct } from "../product-picker"
import { todayStr, type Factory } from "./shared"

/** 建单/编辑生产单弹窗（编辑仅限进行中前三态） */

export function OrderFormDialog({
  open,
  onOpenChange,
  editing,
  factories,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: ProductionOrderRow | null
  factories: Factory[]
  onSaved: () => void
}) {
  const [product, setProduct] = React.useState<PickedProduct | null>(null)
  const [factoryId, setFactoryId] = React.useState("")
  const [quantity, setQuantity] = React.useState("")
  const [productionDate, setProductionDate] = React.useState(todayStr())
  const [dateOpen, setDateOpen] = React.useState(false)
  const [packaged, setPackaged] = React.useState(true)
  const [aux, setAux] = React.useState({ barcode: false, manual: false, bubble: false, warn: false })
  const [note, setNote] = React.useState("")
  const [pending, startSubmit] = React.useTransition()

  React.useEffect(() => {
    if (!open) return
    if (editing) {
      setProduct({
        id: editing.productId,
        productCode: editing.productCode,
        name: editing.productName,
        imageUrl: editing.imageUrl,
        totalQty: 0,
      })
      setFactoryId(editing.factoryId)
      setQuantity(String(editing.quantity))
      setProductionDate(editing.productionDate)
      setPackaged(editing.packaged)
      setAux(editing.aux)
      setNote(editing.note ?? "")
    } else {
      setProduct(null)
      setFactoryId("")
      setQuantity("")
      setProductionDate(todayStr())
      setPackaged(true)
      setAux({ barcode: false, manual: false, bubble: false, warn: false })
      setNote("")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = () => {
    if (!editing && !product) {
      toast.error("请选择货号")
      return
    }
    if (!factoryId) {
      toast.error("请选择工厂")
      return
    }
    const qty = Number.parseInt(quantity, 10)
    if (!Number.isInteger(qty) || qty <= 0) {
      toast.error("数量须为正整数")
      return
    }
    // 编辑时余量不可为负：数量下限 = Σ直发+Σ入库（与服务端守卫同文案）
    if (editing && editing.directQty + editing.shippedQty > 0) {
      const minQty = editing.directQty + editing.shippedQty
      if (qty < minQty) {
        toast.error(`数量不可低于已直发+已入库累计 ${minQty} 件`)
        return
      }
    }
    const payload = {
      productId: product!.id,
      factoryId,
      quantity: qty,
      productionDate,
      packaged,
      // 服务端 zod 键名为 auxBarcode/...（曾用短名 ...aux 被 strip，辅料恒 false）
      auxBarcode: aux.barcode,
      auxManual: aux.manual,
      auxBubble: aux.bubble,
      auxWarn: aux.warn,
      note: note.trim() || null,
    }
    startSubmit(async () => {
      const r = editing
        ? await updateProductionOrderAction(editing.id, payload)
        : await createProductionOrderAction(payload)
      if (r.ok) {
        toast.success(editing ? "生产单已更新" : "生产单已创建（待出材料）")
        onOpenChange(false)
        onSaved()
      } else toast.error(r.error)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑生产单" : "新建生产单"}</DialogTitle>
          <DialogDescription>
            预计交期 = 生产日期 + 商品档案生产周期（自动计算，超期标红）。
            编辑仅限进行中前三态。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>货号 *</Label>
            <ProductPicker
              value={product}
              onChange={(p) => {
                setProduct(p)
                // 新建时随档案联动辅料默认：条码为空（未预贴）→「条码」默认勾
                if (p && !editing) {
                  setAux((a) => ({ ...a, barcode: !p.barcodePrePasted }))
                }
              }}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label>工厂 *</Label>
              <Select
                value={factoryId}
                onValueChange={(v) => v && setFactoryId(v)}
                items={factories
                  .filter((f) => f.enabled)
                  .map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
              >
                <SelectTrigger className="h-9!">
                  <SelectValue placeholder="选择工厂" />
                </SelectTrigger>
                <SelectContent>
                  {factories
                    .filter((f) => f.enabled)
                    .map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.code} · {f.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="of-qty">数量 *</Label>
              <Input
                id="of-qty"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                inputMode="numeric"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="of-date">生产日期 *</Label>
              {/* shadcn 日历选日期（Popover + Calendar 单日期，中文日历） */}
              <Popover open={dateOpen} onOpenChange={setDateOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      id="of-date"
                      type="button"
                      variant="outline"
                      className="h-9 w-full min-w-0 justify-start gap-1.5 font-normal"
                    />
                  }
                >
                  <CalendarIcon className="size-4" />
                  {productionDate
                    ? format(new Date(`${productionDate}T00:00:00`), "yyyy/MM/dd")
                    : "选择日期"}
                </PopoverTrigger>
                {dateOpen && (
                  <PopoverContent align="start" className="w-auto">
                    <Calendar
                      mode="single"
                      selected={
                        productionDate ? new Date(`${productionDate}T00:00:00`) : undefined
                      }
                      onSelect={(d) => {
                        if (d) {
                          setProductionDate(format(d, "yyyy-MM-dd"))
                          setDateOpen(false)
                        }
                      }}
                      locale={zhCN}
                      autoFocus
                    />
                  </PopoverContent>
                )}
              </Popover>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={packaged} onCheckedChange={(v) => setPackaged(v === true)} />
            工厂交货已包装（批次属性，仅记录）
          </label>
          <div className="grid gap-1.5">
            <Label>辅料清单（随材料发工厂）</Label>
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
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="of-note">备注</Label>
            <Textarea
              id="of-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {editing ? "保存" : "建单"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
