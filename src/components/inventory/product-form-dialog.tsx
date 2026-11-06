"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2, Upload } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createProductAction, updateProductAction } from "@/server/actions/inventory"
import { uploadInventoryAsset } from "@/lib/upload/upload-image"
import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/upload/limits"

/**
 * 商品档案新建/编辑弹窗（纯手动建档；货号创建后禁改）。
 * 编辑走字段级 diff → 变更日志（action 内记）。
 */

export interface ProductFormValue {
  id?: string
  productCode?: string
  name: string
  imageUrl: string | null
  cartonQty: number | null
  leadTimeDays: number | null
  stockUpper: number | null
  moq: number | null
  /** 条码预贴标记（true=出厂已贴无需打印；false=未预贴，发货时一并打印） */
  barcodePrePasted: boolean
  productionState: "active" | "stopped"
  shipState: "auto" | "manual"
  note: string | null
}

const num = (v: string): number | null => {
  if (!v.trim()) return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : Number.NaN
}

export function ProductFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: ProductFormValue | null
  onSaved?: () => void
}) {
  const isEdit = Boolean(initial?.id)
  const [name, setName] = React.useState("")
  const [productCode, setProductCode] = React.useState("")
  const [imageUrl, setImageUrl] = React.useState<string | null>(null)
  const [cartonQty, setCartonQty] = React.useState("")
  const [leadTimeDays, setLeadTimeDays] = React.useState("")
  const [stockUpper, setStockUpper] = React.useState("")
  const [moq, setMoq] = React.useState("")
  const [barcodePrePasted, setBarcodePrePasted] = React.useState(false)
  const [productionState, setProductionState] = React.useState<"active" | "stopped">("active")
  const [shipState, setShipState] = React.useState<"auto" | "manual">("auto")
  const [note, setNote] = React.useState("")
  const [uploading, setUploading] = React.useState(false)
  const [pending, startSubmit] = React.useTransition()
  const fileRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setName(initial?.name ?? "")
    setProductCode(initial?.productCode ?? "")
    setImageUrl(initial?.imageUrl ?? null)
    setCartonQty(initial?.cartonQty != null ? String(initial.cartonQty) : "")
    setLeadTimeDays(initial?.leadTimeDays != null ? String(initial.leadTimeDays) : "")
    setStockUpper(initial?.stockUpper != null ? String(initial.stockUpper) : "")
    setMoq(initial?.moq != null ? String(initial.moq) : "")
    setBarcodePrePasted(initial?.barcodePrePasted ?? false)
    setProductionState(initial?.productionState ?? "active")
    setShipState(initial?.shipState ?? "auto")
    setNote(initial?.note ?? "")
  }, [open, initial])

  const pickFile = async (file: File) => {
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      toast.error("单张图片最大 20MB")
      return
    }
    setUploading(true)
    try {
      const url = await uploadInventoryAsset(file)
      setImageUrl(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "图片上传失败")
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const submit = () => {
    if (!isEdit && !productCode.trim()) {
      toast.error("请填写货号")
      return
    }
    if (!name.trim()) {
      toast.error("请填写款名")
      return
    }
    const parsed = {
      name: name.trim(),
      imageUrl,
      cartonQty: num(cartonQty),
      leadTimeDays: num(leadTimeDays),
      stockUpper: num(stockUpper),
      moq: num(moq),
      barcodePrePasted,
      productionState,
      shipState,
      note: note.trim() || null,
    }
    for (const [label, v] of [
      ["装箱数", parsed.cartonQty],
      ["生产周期", parsed.leadTimeDays],
      ["库存上限", parsed.stockUpper],
      ["最小生产量", parsed.moq],
    ] as const) {
      if (Number.isNaN(v as number)) {
        toast.error(`${label}须为正整数（留空表示不设）`)
        return
      }
    }
    startSubmit(async () => {
      const r = isEdit
        ? await updateProductAction(initial!.id!, parsed)
        : await createProductAction({ ...parsed, productCode: productCode.trim() })
      if (r.ok) {
        toast.success(isEdit ? "档案已更新" : "货号已建档")
        onOpenChange(false)
        onSaved?.()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑商品档案" : "新建货号档案"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "货号创建后不可修改（库存与 TEMU 发货的匹配键）；其余字段修改将记变更日志。"
              : "纯手动建档：货号为 TEMU 发货单 skcExtCode 匹配键，请与在售货号保持一致。"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="pf-code">货号 *</Label>
              <Input
                id="pf-code"
                value={productCode}
                onChange={(e) => setProductCode(e.target.value)}
                disabled={isEdit}
                placeholder="如 B162"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pf-name">款名 *</Label>
              <Input
                id="pf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 猫俱乐部扑克"
                className="h-9"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label>商品图</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void pickFile(f)
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                  {imageUrl ? "重新上传" : "上传图片"}
                </Button>
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl} alt="" className="size-9 rounded object-cover" />
                ) : null}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>发货状态</Label>
              <Select
                items={[
                  { value: "auto", label: "自动发货" },
                  { value: "manual", label: "手动发货" },
                ]}
                value={shipState}
                onValueChange={(v) => setShipState(v as "auto" | "manual")}
              >
                <SelectTrigger className="h-9! w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动发货</SelectItem>
                  <SelectItem value="manual">手动发货</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>生产状态</Label>
              <Select
                items={[
                  { value: "active", label: "持续生产" },
                  { value: "stopped", label: "停止生产" },
                ]}
                value={productionState}
                onValueChange={(v) => setProductionState(v as "active" | "stopped")}
              >
                <SelectTrigger className="h-9! w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">持续生产</SelectItem>
                  <SelectItem value="stopped">停止生产</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="pf-carton">装箱数</Label>
              <Input
                id="pf-carton"
                value={cartonQty}
                onChange={(e) => setCartonQty(e.target.value)}
                inputMode="numeric"
                placeholder="每箱件数（参考）"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pf-lead">生产周期(天)</Label>
              <Input
                id="pf-lead"
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(e.target.value)}
                inputMode="numeric"
                placeholder="交期天数"
                className="h-9"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="pf-upper">库存上限</Label>
              <Input
                id="pf-upper"
                value={stockUpper}
                onChange={(e) => setStockUpper(e.target.value)}
                inputMode="numeric"
                placeholder="留空不限"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pf-moq">最小生产量 MOQ</Label>
              <Input
                id="pf-moq"
                value={moq}
                onChange={(e) => setMoq(e.target.value)}
                inputMode="numeric"
                placeholder="留空不限"
                className="h-9"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>条码</Label>
            <Select
              items={[
                { value: "no", label: "需要打印条码" },
                { value: "yes", label: "无需打印条码（出厂已贴）" },
              ]}
              value={barcodePrePasted ? "yes" : "no"}
              onValueChange={(v) => setBarcodePrePasted(v === "yes")}
            >
              <SelectTrigger className="h-9! w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">需要打印条码</SelectItem>
                <SelectItem value="yes">无需打印条码（出厂已贴）</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              选「需要打印条码」的货号会在 TEMU 发货单列表标「需要打印条码」
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pf-note">备注</Label>
            <Textarea
              id="pf-note"
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
          <Button onClick={submit} disabled={pending || uploading}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {isEdit ? "保存修改" : "建档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
