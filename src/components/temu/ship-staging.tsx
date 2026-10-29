"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2, Package, Plus, RefreshCw, Trash2, X } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { TemuShipReceiveAddress } from "@/db/schema"
import {
  createShipOrderAction,
  getMallAddressesAction,
  getReceiveAddressesAction,
  getShipStagingAction,
  type TemuShipStagingRow,
} from "@/server/actions/temu-ship"
import { EmptyHint } from "@/components/temu/products-table"
import { formatDateTime as fmtMs } from "@/lib/datetime"
import { openShipBarcodePrint } from "./ship-packing"

/**
 * 发货台 + 创建发货单（对齐官方卖家后台两页）：
 * - 发货台 = 勾选页：三件套筛选、按钮行（创建发货单/批量打印商品条码）、
 *   官方统计条（已选/待发货/实际发货/剩余需发货）、块状列（备货单信息聚合列）；
 * - 勾选后点「创建发货单」进入独立创建视图（同 tab 第三界面）：
 *   规则提示条 + 汇总 + 按收货仓分组编辑（数量/每箱件数/分箱/卖家地址）→ 创建成功回发货单列表·待装箱发货。
 */

/* ─── 分箱编辑器（发货单列表·「调整备货信息」弹窗用，ship-panel 引用） ─── */

/** 每箱 = skuId → 数量；deliverNums = skuId → 发货数 */
export type ShipPackageDraft = Record<number, number>

export function PackageSplitTable({
  skuIds,
  skuLabels,
  packages,
  deliverNums,
  onPackageChange,
  onAddPackage,
  onRemovePackage,
}: {
  skuIds: number[]
  skuLabels: (id: number) => string
  packages: ShipPackageDraft[]
  deliverNums: Record<number, number>
  onPackageChange: (idx: number, skuId: number, num: number) => void
  onAddPackage: () => void
  onRemovePackage: (idx: number) => void
}) {
  const sumOf = (skuId: number) => packages.reduce((acc, p) => acc + (p[skuId] ?? 0), 0)
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 text-xs">箱号</TableHead>
            {skuIds.map((id) => (
              <TableHead key={id} className="text-xs">
                {skuLabels(id)}
              </TableHead>
            ))}
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {packages.map((pkg, idx) => (
            <TableRow key={idx}>
              <TableCell className="text-xs tabular-nums">#{idx + 1}</TableCell>
              {skuIds.map((id) => (
                <TableCell key={id}>
                  <Input
                    className="h-7 w-16 text-xs tabular-nums"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={pkg[id] ?? 0}
                    onChange={(e) =>
                      onPackageChange(idx, id, Math.max(0, Math.round(Number(e.target.value) || 0)))
                    }
                  />
                </TableCell>
              ))}
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  onClick={() => onRemovePackage(idx)}
                  disabled={packages.length <= 1}
                  aria-label="删除此箱"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="text-xs font-medium">合计/发货</TableCell>
            {skuIds.map((id) => {
              const ok = sumOf(id) === (deliverNums[id] ?? 0)
              return (
                <TableCell key={id} className={`text-xs tabular-nums ${ok ? "" : "text-red-600"}`}>
                  {sumOf(id)} / {deliverNums[id] ?? 0}
                </TableCell>
              )
            })}
            <TableCell></TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <div className="flex items-center justify-between px-2 py-1.5">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAddPackage} disabled={packages.length >= 10}>
          <Plus className="size-3.5" /> 添加包裹
        </Button>
        <span className="text-[11px] text-muted-foreground">各 SKU 分箱合计须等于发货数</span>
      </div>
    </div>
  )
}

/* ─── 发货台 + 创建发货单主体 ─── */

/** 发货台「实际发货数」单元格（官方交互）：数值 + 蓝色「修改」；
 *  未修改时灰字「未修改实际发货数」；修改浮层按 SKU 自由输入，
 *  仅在点「确认」时校验（≥1 且 ≤可发上限），不通过则提示且不关闭 */
function DeliverNumCell({
  row,
  numSum,
  modified,
  onConfirm,
}: {
  row: TemuShipStagingRow
  numSum: number
  modified: boolean
  onConfirm: (nums: Record<number, number>) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Record<number, string>>({})
  const [err, setErr] = React.useState<string | null>(null)

  const confirm = () => {
    // 仅确认时校验：每个 SKU 须为 ≥1 且 ≤最大可发数的整数（空值/越界均拦截，不关闭）
    const nums: Record<number, number> = {}
    for (const s of row.skus) {
      const n = Math.round(Number(draft[s.productSkuId] ?? ""))
      const max = s.skuDeliveryQuantityMaxLimit ?? 9999
      if (!Number.isFinite(n) || n < 1 || n > max) {
        setErr(`实际发货数须 ≥1 且不超过最大可发数（${max}）`)
        return
      }
      nums[s.productSkuId] = n
    }
    setErr(null)
    onConfirm(nums)
    setOpen(false)
  }

  return (
    <div
      className={`flex flex-nowrap items-center gap-1.5 whitespace-nowrap${modified ? " justify-end" : ""}`}
    >
      <Popover
        open={open}
        onOpenChange={(v) => {
          // 打开时以默认发货数为草稿（min(上限,备货数)）；输入不钳制，确认时统一校验
          if (v) {
            const d: Record<number, string> = {}
            for (const s of row.skus) {
              d[s.productSkuId] = String(Math.min(s.skuDeliveryQuantityMaxLimit ?? 9999, s.productSkuPurchaseQuantity ?? 1))
            }
            setDraft(d)
            setErr(null)
          }
          setOpen(v)
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium tabular-nums">{numSum}</span>
          <PopoverTrigger
            render={<Button variant="ghost" size="sm" className="h-6 px-1 text-xs text-primary hover:underline" />}
          >
            修改
          </PopoverTrigger>
        </div>
        <PopoverContent className="w-64 p-3">
          <p className="text-xs font-medium">实际发货数（件）</p>
          <div className="mt-2 space-y-2">
            {row.skus.map((s) => {
              const multi = row.skus.length > 1
              return (
                <div key={s.productSkuId} className="space-y-0.5">
                  <div className="flex flex-nowrap items-center gap-1.5">
                    {multi && s.imgUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.imgUrl} alt="" className="size-7 shrink-0 rounded object-cover" loading="lazy" />
                    ) : null}
                    <Input
                      className="h-7 min-w-0 flex-1 text-xs tabular-nums"
                      type="number"
                      inputMode="numeric"
                      value={draft[s.productSkuId] ?? ""}
                      onChange={(e) => {
                        setErr(null)
                        setDraft((d) => ({ ...d, [s.productSkuId]: e.target.value }))
                      }}
                      aria-label={`SKU ${s.productSkuId} 实际发货数`}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">最大不超过 {s.skuDeliveryQuantityMaxLimit ?? "—"}</p>
                </div>
              )
            })}
          </div>
          {err && <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{err}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={confirm}>
              确认
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {!modified && (
        <Badge className="rounded-[4px] bg-blue-500/15 px-1 text-[10px] text-blue-700 dark:text-blue-400">未修改实际发货数</Badge>
      )}
    </div>
  )
}

/* ─── 调整包裹抽屉（官方右侧抽屉：摘要卡 + SKU 行 + 批量添加均分） ─── */
function AdjustPackagesSheet({
  open,
  onOpenChange,
  st,
  order,
  storeName,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  st?: TemuShipStagingRow
  order: {
    sn: string
    deliverNums: Record<number, number>
    packages: ShipPackageDraft[]
  }
  storeName?: string | null
  onConfirm: (deliverNums: Record<number, number>, packages: ShipPackageDraft[]) => void
}) {
  const [nums, setNums] = React.useState<Record<number, number>>({})
  const [pkgs, setPkgs] = React.useState<ShipPackageDraft[]>([])
  /** 「批量添加」浮层（每 SKU 一个）：送货数 + 每包件数 → 自动算包裹数并均分 */
  const [bulk, setBulk] = React.useState<{ skuId: number; total: string; per: string } | null>(null)

  // 打开时以当前单据拷贝为草稿；期间父级状态不变，仅需跟随 open 初始化
  React.useEffect(() => {
    if (open) {
      setNums({ ...order.deliverNums })
      setPkgs(order.packages.map((p) => ({ ...p })))
      setBulk(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const skuIds = Object.keys(nums).map(Number)
  const maxOf = (id: number) => st?.skus.find((s) => s.productSkuId === id)?.skuDeliveryQuantityMaxLimit
  const sumOf = (id: number) => pkgs.reduce((acc, p) => acc + (p[id] ?? 0), 0)
  const totalNums = skuIds.reduce((acc, id) => acc + (nums[id] ?? 0), 0)
  const allOk = skuIds.every((id) => sumOf(id) === (nums[id] ?? 0))

  const setNum = (id: number, raw: number) => {
    const max = maxOf(id) ?? 9999
    setNums((m) => ({ ...m, [id]: Math.max(1, Math.min(max, Math.round(raw || 1))) }))
  }
  const setPkgNum = (idx: number, id: number, raw: number) =>
    setPkgs((ps) => ps.map((p, k) => (k === idx ? { ...p, [id]: Math.max(0, Math.round(raw || 0)) } : p)))
  const addPackage = () =>
    setPkgs((ps) => (ps.length >= 10 ? ps : [...ps, Object.fromEntries(skuIds.map((id) => [id, 0]))]))
  const removePackage = (idx: number) => setPkgs((ps) => (ps.length <= 1 ? ps : ps.filter((_, k) => k !== idx)))

  const bulkTotal = Math.round(Number(bulk?.total))
  const bulkPer = Math.round(Number(bulk?.per))
  const bulkCount =
    bulk && Number.isFinite(bulkTotal) && bulkTotal >= 1 && Number.isFinite(bulkPer) && bulkPer >= 1
      ? Math.ceil(bulkTotal / bulkPer)
      : null

  /** 批量添加：重设该 SKU 实际发货数并均分到 ⌈送货数/每包件数⌉ 个包裹（前 rem 包多 1 件） */
  const applyBulk = (skuId: number) => {
    if (!bulk) return
    if (!Number.isFinite(bulkTotal) || bulkTotal < 1 || !Number.isFinite(bulkPer) || bulkPer < 1) {
      toast.error("请输入有效的送货数与每包件数")
      return
    }
    const max = maxOf(skuId) ?? 9999
    if (bulkTotal > max) {
      toast.error(`送货数 ${bulkTotal} 超过该 SKU 可发上限 ${max}`)
      return
    }
    const boxCount = bulkCount ?? 1
    if (boxCount > 10) {
      toast.error(`按每包 ${bulkPer} 件需 ${boxCount} 个包裹，超过官方 10 个包裹上限`)
      return
    }
    // 缩减包裹时，被删尾包中若还有其他 SKU 的货量则拒绝（避免破坏其分箱合计）
    if (boxCount < pkgs.length) {
      const orphan = pkgs
        .slice(boxCount)
        .reduce(
          (acc, p) =>
            acc + Object.entries(p).filter(([id]) => Number(id) !== skuId).reduce((a, [, v]) => a + v, 0),
          0,
        )
      if (orphan > 0) {
        toast.error(`后 ${pkgs.length - boxCount} 个包裹中有其他 SKU 共 ${orphan} 件货量，请先清空再缩小包裹数`)
        return
      }
    }
    const base = Math.floor(bulkTotal / boxCount)
    const rem = bulkTotal % boxCount
    setNums((m) => ({ ...m, [skuId]: bulkTotal }))
    setPkgs((ps) => {
      let next = ps.map((p) => ({ ...p }))
      while (next.length < boxCount) next.push({})
      next = next.slice(0, boxCount)
      return next.map((p, i) => ({ ...p, [skuId]: base + (i < rem ? 1 : 0) }))
    })
    setBulk(null)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 data-[side=right]:sm:w-1/2 data-[side=right]:sm:max-w-none">
        <SheetHeader className="border-b pb-3">
          <SheetTitle>调整包裹信息</SheetTitle>
        </SheetHeader>

        {/* 滚动区：摘要卡 + SKU 包裹设置表 */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 scrollbar-hide">
          {/* 摘要卡（官方图2：单号/SKC/货号/店铺/创建时间 + 标签 + 右侧大号统计） */}
          <div className="flex items-center gap-2.5 rounded-md bg-muted/40 p-2.5">
            {st?.productSkcPicture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={st.productSkcPicture} alt="" className="size-12 shrink-0 rounded object-cover" loading="lazy" />
            ) : (
              <div className="size-12 shrink-0 rounded bg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-medium" title={st?.productName ?? undefined}>{order.sn}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">SKC {st?.productSkcId ?? "—"}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">货号 {st?.skcExtCode ?? "—"}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">店铺名称 {storeName ?? <EmptyHint />}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">创建时间 {fmtMs(st?.purchaseTime ?? null)}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1">
                {st?.urgencyType === 1 && <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">急采</Badge>}
                {st?.purchaseStockType === 1 && <Badge className="rounded-[4px] bg-muted px-1 text-[10px] text-muted-foreground">JIT</Badge>}
                {st?.isCustomProduct && <Badge className="rounded-[4px] bg-violet-500/15 px-1 text-[10px] text-violet-700 dark:text-violet-400">定制</Badge>}
              </p>
            </div>
            <div className="shrink-0 space-y-1.5 text-right">
              <p className="text-[11px] text-muted-foreground">
                包裹总数 <span className="ml-1 text-sm font-semibold tabular-nums text-foreground">{pkgs.length}</span>
              </p>
              <p className="text-[11px] text-muted-foreground">
                实际发货总件数 <span className="ml-1 text-sm font-semibold tabular-nums text-foreground">{totalNums}</span>
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table className="text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32 text-xs">SKU ID</TableHead>
                  <TableHead className="w-36 text-xs">实际发货数（件）</TableHead>
                  <TableHead className="text-xs">包裹设置</TableHead>
                  <TableHead className="w-36 text-xs">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skuIds.map((id) => {
                  const ok = sumOf(id) === (nums[id] ?? 0)
                  return (
                    <TableRow key={id}>
                      <TableCell className="font-mono">{id}</TableCell>
                      <TableCell>
                        <div className="flex flex-nowrap items-center gap-1 whitespace-nowrap">
                          <Input
                            className="h-7 w-20 text-xs tabular-nums"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={nums[id] ?? 0}
                            onChange={(e) => setNum(id, Number(e.target.value))}
                          />
                          <span className="text-[11px] text-muted-foreground">/ {maxOf(id) ?? "—"}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {pkgs.map((pkg, i) => (
                            <span
                              key={i}
                              className="inline-flex flex-nowrap items-center gap-1 whitespace-nowrap rounded-md border bg-muted/30 py-0.5 pl-1.5 pr-0.5"
                            >
                              <span className="text-[11px] text-muted-foreground">包裹{i + 1} 数量</span>
                              <Input
                                className="h-6 w-14 border-0 bg-transparent px-1 text-xs tabular-nums focus-visible:ring-1"
                                type="number"
                                inputMode="numeric"
                                min={0}
                                value={pkg[id] ?? 0}
                                onChange={(e) => setPkgNum(i, id, Number(e.target.value))}
                                aria-label={`SKU ${id} 包裹${i + 1} 数量`}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                                onClick={() => removePackage(i)}
                                disabled={pkgs.length <= 1}
                                aria-label={`删除包裹${i + 1}`}
                              >
                                <Trash2 className="size-3" />
                              </Button>
                            </span>
                          ))}
                        </div>
                        {!ok && (
                          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                            分箱合计 {sumOf(id)} ≠ 发货数 {nums[id] ?? 0}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-nowrap items-center gap-0.5 whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1 text-xs text-primary hover:underline"
                            onClick={addPackage}
                            disabled={pkgs.length >= 10}
                          >
                            添加包裹
                          </Button>
                          <Popover
                            open={bulk?.skuId === id}
                            onOpenChange={(v) =>
                              setBulk(v ? { skuId: id, total: String(nums[id] ?? 0), per: "" } : null)
                            }
                          >
                            <PopoverTrigger
                              render={
                                <Button variant="ghost" size="sm" className="h-6 px-1 text-xs text-primary hover:underline" />
                              }
                            >
                              批量添加
                            </PopoverTrigger>
                            <PopoverContent className="w-60 p-3" align="end">
                              <p className="text-xs font-medium">批量添加</p>
                              <div className="mt-2 space-y-2">
                                <div className="space-y-1">
                                  <Label className="text-[11px]">*送货数</Label>
                                  <Input
                                    className="h-7 text-xs tabular-nums"
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    value={bulk?.total ?? ""}
                                    onChange={(e) =>
                                      setBulk((b) => (b ? { ...b, total: e.target.value } : b))
                                    }
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-[11px]">*每包件数</Label>
                                  <Input
                                    className="h-7 text-xs tabular-nums"
                                    type="number"
                                    inputMode="numeric"
                                    min={1}
                                    value={bulk?.per ?? ""}
                                    onChange={(e) => setBulk((b) => (b ? { ...b, per: e.target.value } : b))}
                                  />
                                </div>
                                <p className="text-[11px] text-muted-foreground">
                                  包裹数量：
                                  <span className="font-medium tabular-nums text-foreground">
                                    {bulkCount != null ? bulkCount : "—"}
                                  </span>
                                  （自动计算，各包裹均分）
                                </p>
                              </div>
                              <div className="mt-3 flex justify-end gap-2">
                                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setBulk(null)}>
                                  取消
                                </Button>
                                <Button size="sm" className="h-7 text-xs" onClick={() => applyBulk(id)}>
                                  确认添加
                                </Button>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        <SheetFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t">
          <p className={`text-[11px] ${allOk ? "text-muted-foreground" : "text-red-600 dark:text-red-400"}`}>
            {allOk ? "各包裹货量合计 = 实际发货数" : "存在 SKU 分箱合计 ≠ 实际发货数，请先调整"}
          </p>
          <div className="ml-auto flex flex-nowrap gap-2">
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!allOk}
              onClick={() => {
                onConfirm(nums, pkgs)
                onOpenChange(false)
              }}
            >
              确认
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

type GroupDraft = {
  subWarehouseId: number
  receiveAddress: TemuShipReceiveAddress
  sns: string[]
  deliveryAddressId: number | null
  orders: Array<{
    sn: string
    deliverNums: Record<number, number>
    packages: ShipPackageDraft[]
  }>
}

type MallAddr = { id: number; label: string; isDefault: boolean; fullText: string }

export function ShipStaging({
  store,
  storeName,
  viewSwitch,
  onCreated,
}: {
  store: string
  /** 当前 tab 店铺名（官方「发货店铺」列为只读展示） */
  storeName?: string | null
  /** 面板传入的视图切换控件（发货台/发货单列表），与本页刷新按钮同排同高 */
  viewSwitch: React.ReactNode
  /** 全部分组创建成功后回调（面板切到发货单列表·待装箱发货） */
  onCreated: () => void
}) {
  const [loading, startLoading] = React.useTransition()
  const [error, setError] = React.useState<string | null>(null)
  /** list = 发货台勾选页；create = 创建发货单独立视图（官方两页拆分） */
  const [mode, setMode] = React.useState<"list" | "create">("list")

  const [stagingRows, setStagingRows] = React.useState<TemuShipStagingRow[]>([])
  const [stagingSel, setStagingSel] = React.useState<Set<string>>(new Set())
  const [filters, setFilters] = React.useState({ sn: "", skc: "", ext: "" })
  /** 发货台行内调整的实际发货数（sn → skuId → 数量）；未调整的单走默认 min(上限,备货数) */
  const [adjust, setAdjust] = React.useState<Record<string, Record<number, number>>>({})

  const [groups, setGroups] = React.useState<GroupDraft[]>([])
  const [mallAddrs, setMallAddrs] = React.useState<MallAddr[]>([])
  const [buildingGroups, setBuildingGroups] = React.useState(false)
  const [createResults, setCreateResults] = React.useState<Array<{ sn: string; ok: boolean; msg?: string }>>([])
  /** 创建视图中正在「调整包裹」的单（组/单下标） */
  const [adjusting, setAdjusting] = React.useState<{ gi: number; oi: number } | null>(null)

  const stagingBySn = React.useMemo(
    () => new Map(stagingRows.map((r) => [r.subPurchaseOrderSn, r])),
    [stagingRows],
  )

  /** 单据默认发货数 = 每 SKU min(可发上限, 备货数) */
  const defaultNumsOf = React.useCallback((r: TemuShipStagingRow): Record<number, number> => {
    const out: Record<number, number> = {}
    for (const s of r.skus) {
      out[s.productSkuId] = Math.min(s.skuDeliveryQuantityMaxLimit ?? 9999, s.productSkuPurchaseQuantity ?? 1)
    }
    return out
  }, [])

  /** 生效发货数（发货台调整优先），及是否仍为默认（等值即「未修改」） */
  const effectiveNumsOf = React.useCallback(
    (r: TemuShipStagingRow): Record<number, number> => adjust[r.subPurchaseOrderSn] ?? defaultNumsOf(r),
    [adjust, defaultNumsOf],
  )
  const isDefaultNums = React.useCallback(
    (r: TemuShipStagingRow) => {
      const cur = effectiveNumsOf(r)
      const def = defaultNumsOf(r)
      return Object.keys(def).every((k) => cur[Number(k)] === def[Number(k)])
    },
    [effectiveNumsOf, defaultNumsOf],
  )

  const loadStaging = React.useCallback(() => {
    startLoading(async () => {
      const r = await getShipStagingAction({
        store,
        subPurchaseOrderSn: filters.sn.trim() || undefined,
        skcId: filters.skc.trim() || undefined,
        skcExtCode: filters.ext.trim() || undefined,
      })
      if (r.ok) {
        setStagingRows(r.rows)
        setError(null)
      } else {
        setStagingRows([])
        setError(r.error)
      }
    })
  }, [store, filters])

  // 输入即搜索：筛选变化防抖 400ms 后重查（刷新按钮直调 loadStaging 不等防抖）
  React.useEffect(() => {
    const t = setTimeout(loadStaging, 400)
    return () => clearTimeout(t)
  }, [loadStaging])

  const setFilter = (k: "sn" | "skc" | "ext", v: string) =>
    setFilters((f) => ({ ...f, [k]: v.trim() }))

  /** 下拉 options 取自当前（已按关键字服务端筛选的）发货台行 */
  const snOptions = React.useMemo(() => {
    const seen = new Set<string>()
    const out: ComboboxOption[] = []
    for (const r of stagingRows) {
      if (seen.has(r.subPurchaseOrderSn)) continue
      seen.add(r.subPurchaseOrderSn)
      out.push({
        value: r.subPurchaseOrderSn,
        label: r.subPurchaseOrderSn,
        description: r.productName ?? null,
        badge: r.skcExtCode ?? null,
      })
    }
    return out
  }, [stagingRows])

  const skcOptions = React.useMemo(() => {
    const seen = new Set<string>()
    const out: ComboboxOption[] = []
    for (const r of stagingRows) {
      if (r.productSkcId == null) continue
      const v = String(r.productSkcId)
      if (seen.has(v)) continue
      seen.add(v)
      out.push({ value: v, label: v, description: r.skcExtCode ?? null })
    }
    return out
  }, [stagingRows])

  const extOptions = React.useMemo(() => {
    const seen = new Set<string>()
    const out: ComboboxOption[] = []
    for (const r of stagingRows) {
      if (!r.skcExtCode || seen.has(r.skcExtCode)) continue
      seen.add(r.skcExtCode)
      out.push({ value: r.skcExtCode, label: r.skcExtCode, description: r.productName ?? null })
    }
    return out
  }, [stagingRows])

  const toggleSel = (sn: string) =>
    setStagingSel((s) => {
      const n = new Set(s)
      if (n.has(sn)) n.delete(sn)
      else n.add(sn)
      return n
    })

  // 勾选变化后（防抖 500ms）按收货地址重建分组；保留已有单据的数量/分箱编辑与卖家地址
  React.useEffect(() => {
    const sns = [...stagingSel]
    if (sns.length === 0) {
      setGroups([])
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      setBuildingGroups(true)
      try {
        const r = await getReceiveAddressesAction({ store, subPurchaseOrderSns: sns })
        if (cancelled) return
        if (!r.ok) {
          toast.error(`收货地址分组获取失败：${r.error}`, { duration: 6000 })
          return
        }
        let addrRows = mallAddrs
        if (addrRows.length === 0) {
          const addr = await getMallAddressesAction(store)
          if (addr.ok) {
            addrRows = addr.rows
            setMallAddrs(addr.rows)
          }
        }
        if (cancelled) return
        const selSet = new Set(sns)
        setGroups((prev) => {
          const prevBySn = new Map(prev.flatMap((g) => g.orders.map((o) => [o.sn, o] as const)))
          const prevAddrByWh = new Map(prev.map((g) => [g.subWarehouseId, g.deliveryAddressId] as const))
          const def = addrRows.find((a) => a.isDefault) ?? addrRows[0]
          const drafts = r.groups
            .map((g) => {
              const orders = g.subPurchaseOrderSns
                .filter((sn) => selSet.has(sn) && stagingBySn.has(sn))
                .map((sn) => {
                  const prevOrder = prevBySn.get(sn)
                  const adj = adjust[sn]
                  // 发货台行内调整（list 视图 setAdjust）优先于旧草稿：prevBySn 命中
                  // 保留的是分组时点的数量，若与调整值不一致须按调整值重建，否则
                  // 调整永远进不了创建载荷（effect 依赖 adjust 的意图即随调整重建）；
                  // 已等于调整值时保留旧草稿（保住创建视图的分箱编辑）
                  if (adj && (!prevOrder || !sameDeliverNums(prevOrder.deliverNums, adj))) {
                    return defaultOrder(stagingBySn.get(sn)!, sn, adj)
                  }
                  return prevOrder ?? defaultOrder(stagingBySn.get(sn)!, sn)
                })
              return {
                subWarehouseId: g.subWarehouseId,
                receiveAddress: g.receiveAddress,
                sns: orders.map((o) => o.sn),
                deliveryAddressId: prevAddrByWh.get(g.subWarehouseId) ?? def?.id ?? null,
                orders,
              } satisfies GroupDraft
            })
            .filter((g) => g.orders.length > 0)
          const grouped = new Set(drafts.flatMap((g) => g.sns))
          const missing = sns.filter((sn) => !grouped.has(sn))
          if (missing.length > 0) {
            toast.warning(`${missing.length} 单未返回收货地址分组（可能已超时移出发货台），已跳过`, { duration: 8000 })
          }
          return drafts
        })
      } finally {
        if (!cancelled) setBuildingGroups(false)
      }
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagingSel, store, adjust])

  const updateGroup = (gi: number, fn: (g: GroupDraft) => GroupDraft) =>
    setGroups((gs) => gs.map((g, i) => (i === gi ? fn(g) : g)))

  const groupsValid = React.useMemo(
    () =>
      groups.length > 0 &&
      groups.every((g) => {
        if (!g.deliveryAddressId) return false
        return g.orders.every((o) => {
          const skuIds = Object.keys(o.deliverNums).map(Number)
          return skuIds.every((id) => o.packages.reduce((acc, p) => acc + (p[id] ?? 0), 0) === o.deliverNums[id])
        })
      }),
    [groups],
  )

  const totalOrders = groups.reduce((acc, g) => acc + g.orders.length, 0)
  /** 创建视图汇总（官方口径：备货单数/实际发货物件数/总包裹数） */
  const totalSkuNum = groups.reduce(
    (acc, g) => acc + g.orders.reduce((a, o) => a + Object.values(o.deliverNums).reduce((x, n) => x + n, 0), 0),
    0,
  )
  const totalPackages = groups.reduce(
    (acc, g) => acc + g.orders.reduce((a, o) => a + o.packages.length, 0),
    0,
  )

  /** 创建发货单：先实时核对发货台（fresh，超时单阻断），再逐组创建；
   *  全部成功回列表·待装箱发货；部分成功保留失败分组供修正重试。 */
  const createShipOrders = () => {
    startLoading(async () => {
      const allSns = groups.flatMap((g) => g.orders.map((o) => o.sn))
      const pre = await getShipStagingAction({ store, subPurchaseOrderSn: allSns.join(","), fresh: true })
      if (pre.ok) {
        const present = new Set(pre.rows.map((r) => r.subPurchaseOrderSn))
        const missing = allSns.filter((sn) => !present.has(sn))
        if (missing.length > 0) {
          setCreateResults([
            { sn: missing.join("、"), ok: false, msg: "已不在发货台（可能已超时被自动移除），请刷新后重选" },
          ])
          toast.error(`有 ${missing.length} 单已不在发货台（可能已超时被自动移除），请刷新重选`, { duration: 8000 })
          return
        }
      } else {
        toast.warning(`发货台核对失败（${pre.error}），已跳过核对直接创建`, { duration: 8000 })
      }
      const results: Array<{ sn: string; ok: boolean; msg?: string }> = []
      const createdSns = new Set<string>()
      const followUpWarnings: string[] = []
      for (const g of groups) {
        try {
          const r = await createShipOrderAction({
            store,
            groups: [
              {
                subWarehouseId: g.subWarehouseId,
                receiveAddressInfo: g.receiveAddress,
                deliveryAddressId: g.deliveryAddressId!,
                orders: g.orders.map((o) => ({
                  subPurchaseOrderSn: o.sn,
                  deliverOrderDetailInfos: Object.entries(o.deliverNums).map(([id, n]) => ({
                    productSkuId: Number(id),
                    deliverSkuNum: n,
                  })),
                  packageInfos: o.packages.map((p) => ({
                    packageDetailSaveInfos: Object.entries(p)
                      .filter(([, n]) => n > 0)
                      .map(([id, n]) => ({ productSkuId: Number(id), skuNum: n })),
                  })),
                })),
              },
            ],
          })
          if (r.ok) {
            results.push(...r.deliveryOrderSns.map((sn) => ({ sn, ok: true })))
            if (r.warning) followUpWarnings.push(r.warning)
            for (const o of g.orders) createdSns.add(o.sn)
          } else {
            results.push({ sn: g.orders.map((o) => o.sn).join("、"), ok: false, msg: r.error })
          }
        } catch (e) {
          results.push({ sn: g.orders.map((o) => o.sn).join("、"), ok: false, msg: e instanceof Error ? e.message : String(e) })
        }
      }
      setCreateResults(results)
      if (followUpWarnings.length > 0)
        toast.warning(followUpWarnings.join("；"), { duration: 10_000 })
      const okCount = results.filter((r) => r.ok).length
      if (okCount === 0) {
        toast.error(`所有分组创建失败：${results.find((r) => !r.ok)?.msg ?? ""}`, { duration: 10000 })
        return
      }
      // 成功的单移出勾选与分组（避免重试时重复创建）；刷新发货台
      setStagingSel((s) => new Set([...s].filter((sn) => !createdSns.has(sn))))
      setGroups((gs) =>
        gs.map((g) => ({ ...g, orders: g.orders.filter((o) => !createdSns.has(o.sn)) })).filter((g) => g.orders.length > 0),
      )
      loadStaging()
      if (okCount === results.length) {
        toast.success(`已创建 ${okCount} 张发货单，可在发货单列表·待装箱发货中装箱发货`)
        onCreated()
      } else {
        toast.warning(`部分成功：${okCount}/${results.length} 组，失败分组已保留`, { duration: 8000 })
      }
    })
  }

  /* ─── 创建发货单（独立视图，官方图2） ─── */
  if (mode === "create") {
    const adjustOrder =
      adjusting != null ? groups[adjusting.gi]?.orders[adjusting.oi] : undefined
    return (
      <>
      {/* h-full 高度链：规则条/汇总固定，分组卡片区为内部滚动区 */}
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader className="gap-3">
          {/* 官方蓝色规则提示条（浓缩版） */}
          <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs leading-6 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
            <p className="font-medium">创建发货单须知：</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>发货单按收货仓自动分组，同组共用一个卖家发货地址。</li>
              <li>每单最多 10 个包裹，各 SKU 分箱合计须等于实际发货数。</li>
              <li>实际发货数不能超过剩余需发货数（剩余 = 待发货数 − 已发货数）。</li>
              <li>创建成功后须先打印商品打包标签，才可装箱发货。</li>
              <li>超时未发货的备货单会被平台自动移出发货台。</li>
              <li>装箱发货支持在线物流下单 / 自送 / 第三方物流三种方式。</li>
            </ol>
          </div>
          <p className="text-xs text-muted-foreground">
            备货单数：<span className="tabular-nums">{totalOrders}</span> · 实际发货件数：
            <span className="tabular-nums">{totalSkuNum}</span> · 总包裹数：
            <span className="tabular-nums">{totalPackages}</span>
          </p>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-hide">
          {stagingSel.size === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              未选择备货单；请返回发货台勾选后进入。
            </p>
          ) : (
            <>
              {createResults.some((r) => !r.ok) && (
                <div className="rounded-md border border-red-500/30 p-3 text-xs">
                  <p className="font-medium text-red-600 dark:text-red-400">创建失败分组：</p>
                  {createResults
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <p key={r.sn} className="text-red-600 dark:text-red-400">
                        {r.sn}：{r.msg}
                      </p>
                    ))}
                </div>
              )}

              {buildingGroups && groups.length === 0 && (
                <p className="text-xs text-muted-foreground">正在按收货地址生成分组…</p>
              )}

              {groups.map((g, gi) => (
                <div key={g.subWarehouseId} className="space-y-3 rounded-md border p-3">
                  {/* 列头+卡片行同宽对齐：整体不换行，窄屏横向滚动 */}
                  <div className="overflow-x-auto scrollbar-hide">
                  <div className="min-w-max space-y-2.5">
                  {/* 列头工具栏（官方图1 八列；整行不换行，窄屏横向滚动） */}
                  <div className="flex flex-nowrap items-center gap-3 rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
                    <span className="min-w-52 flex-1 whitespace-nowrap">备货单信息</span>
                    <span className="w-24 whitespace-nowrap">发货店铺</span>
                    <span className="w-32 whitespace-nowrap">发货仓库</span>
                    <span className="w-24 whitespace-nowrap text-right">备货单总件数（件）</span>
                    <span className="w-24 whitespace-nowrap text-right">实际发货数（件）</span>
                    <span className="w-24 whitespace-nowrap text-right">剩余待发货数（件）</span>
                    <span className="w-20 whitespace-nowrap text-right">包裹数（个）</span>
                    <span className="w-24 whitespace-nowrap text-right">操作</span>
                  </div>

                  {g.orders.map((o, oi) => {
                    const st = stagingBySn.get(o.sn)
                    const skuIds = Object.keys(o.deliverNums).map(Number)
                    const remain =
                      st?.purchaseQuantity != null
                        ? Math.max(0, st.purchaseQuantity - (st.actualDeliveredNum ?? 0))
                        : null
                    const numSum = Object.values(o.deliverNums).reduce((a, b) => a + b, 0)
                    /** 发货数仍全为默认（未调整或调回相等）→ 明细表实际发货数后挂「未修改」勋章 */
                    const unmodified =
                      !!st && Object.entries(defaultNumsOf(st)).every(([id, n]) => o.deliverNums[Number(id)] === n)
                    return (
                      <div key={o.sn} className="space-y-2.5">
                        <div className="flex flex-nowrap items-center gap-3 rounded-md bg-background py-2.5 pl-3 shadow-xs">
                          {/* 备货单信息（图 + 单号 + 货号 + SKC/标签 + 创建时间，官方图1 卡片口径） */}
                          <div className="flex min-w-52 flex-1 items-center gap-2.5">
                            {st?.productSkcPicture ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={st.productSkcPicture} alt="" className="size-12 shrink-0 rounded object-cover" loading="lazy" />
                            ) : (
                              <div className="size-12 shrink-0 rounded bg-muted" />
                            )}
                            <div className="min-w-0">
                              <p className="font-mono text-xs" title={st?.productName ?? undefined}>{o.sn}</p>
                              <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={st?.productName ?? undefined}>
                                货号 {st?.skcExtCode ?? <EmptyHint />}
                              </p>
                              <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                                <span>SKC {st?.productSkcId ?? "—"}</span>
                                {st?.urgencyType === 1 && <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">急采</Badge>}
                                {st?.purchaseStockType === 1 && <Badge variant="secondary" className="rounded-[4px] px-1 text-[10px]">JIT</Badge>}
                                {st?.isCustomProduct && <Badge variant="outline" className="rounded-[4px] px-1 text-[10px]">定制</Badge>}
                              </p>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                创建时间 {fmtMs(st?.purchaseTime ?? null)}
                              </p>
                            </div>
                          </div>
                          {/* 发货店铺（单店铺 tab，只读展示） */}
                          <div className="w-24 min-w-0">
                            <p className="truncate text-xs" title={storeName ?? undefined}>
                              {storeName ?? <EmptyHint />}
                            </p>
                          </div>
                          {/* 发货仓库（组级地址下拉，任一卡片改动全组生效） */}
                          <div className="w-32">
                            <Select
                              items={mallAddrs.map((a) => ({ value: String(a.id), label: a.label }))}
                              value={g.deliveryAddressId != null ? String(g.deliveryAddressId) : ""}
                              onValueChange={(v) => {
                                if (v) updateGroup(gi, (x) => ({ ...x, deliveryAddressId: Number(v) }))
                              }}
                            >
                              <SelectTrigger
                                className="h-8 w-full text-xs"
                                title={mallAddrs.find((a) => a.id === g.deliveryAddressId)?.fullText}
                                aria-label={`备货单 ${o.sn} 发货仓库`}
                              >
                                <SelectValue placeholder={mallAddrs.length === 0 ? "无地址（去卖家中心创建）" : "选择发货仓库"} />
                              </SelectTrigger>
                              <SelectContent className="w-auto min-w-72 max-w-[26rem]">
                                {mallAddrs.map((a) => (
                                  <SelectItem key={a.id} value={String(a.id)} title={`${a.label}（${a.fullText}）`}>
                                    {a.label}（{a.fullText}）
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {/* 数量统计（纯展示，编辑走调整包裹抽屉） */}
                          <div className="w-24 text-right text-xs tabular-nums">
                            {st?.purchaseQuantity ?? <EmptyHint />}
                          </div>
                          <div className="w-24 text-right text-xs font-medium tabular-nums">{numSum}</div>
                          <div className="w-24 text-right text-xs tabular-nums">{remain ?? <EmptyHint />}</div>
                          <div className="w-20 text-right text-xs tabular-nums">{o.packages.length}</div>
                          {/* 操作区：调整包裹/移除（一列竖排整体居中） */}
                          <div className="flex w-24 flex-col items-center justify-center gap-1.5 py-1.5 pr-3">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-full text-xs text-primary"
                              onClick={() => setAdjusting({ gi, oi })}
                            >
                              <Package className="size-3.5" /> 调整包裹
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-full text-xs text-primary"
                              onClick={() => toggleSel(o.sn)}
                              disabled={totalOrders <= 1}
                              aria-label={`移除备货单 ${o.sn}`}
                            >
                              <X className="size-3.5" /> 移除
                            </Button>
                          </div>
                        </div>
                        {/* 官方行式明细表（只读展示，编辑统一走「调整包裹」抽屉；无属性集列） */}
                        <div className="overflow-x-auto rounded-md border">
                          <div className="border-b px-2.5 py-1.5">
                            <p className="text-xs font-medium">SKU 明细</p>
                          </div>
                          {/* 列竖线用显式类（rowSpan 合并后 :not(:first-child) 会漏画「包裹2」行的左侧线） */}
                          <Table className="text-xs [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-32 text-xs">SKU ID</TableHead>
                                <TableHead className="w-40 text-xs">实际发货数（件）</TableHead>
                                <TableHead className="w-24 text-xs">包裹号</TableHead>
                                <TableHead className="w-28 text-xs">商品数（件）</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {skuIds.flatMap((id) =>
                                o.packages.map((p, pi) => {
                                  const sku = st?.skus.find((s) => s.productSkuId === id)
                                  const max = sku?.skuDeliveryQuantityMaxLimit ?? undefined
                                  const first = pi === 0
                                  return (
                                    <TableRow key={`${id}-${pi}`}>
                                      {first && (
                                        <TableCell rowSpan={o.packages.length} className="font-mono">
                                          {id}
                                        </TableCell>
                                      )}
                                      {first && (
                                        <TableCell
                                          rowSpan={o.packages.length}
                                          className={`border-l border-border${unmodified ? "" : " text-right"}`}
                                        >
                                          <span className="font-medium tabular-nums text-primary" title={max != null ? `可发上限 ${max}` : undefined}>
                                            {o.deliverNums[id] ?? 0}
                                          </span>
                                          <span className="ml-1 text-[11px] text-muted-foreground">/ {max ?? <EmptyHint />}</span>
                                          {unmodified && (
                                            <Badge className="ml-1 rounded-[4px] bg-blue-500/15 px-1 text-[10px] text-blue-700 dark:text-blue-400">
                                              未修改实际发货数
                                            </Badge>
                                          )}
                                        </TableCell>
                                      )}
                                      <TableCell className="border-l border-border">包裹{pi + 1}</TableCell>
                                      <TableCell className="border-l border-border tabular-nums">{p[id] ?? 0}</TableCell>
                                    </TableRow>
                                  )
                                }),
                              )}
                              {skuIds.some(
                                (id) => o.packages.reduce((acc, p) => acc + (p[id] ?? 0), 0) !== (o.deliverNums[id] ?? 0),
                              ) && (
                                <TableRow>
                                  <TableCell colSpan={4} className="py-1.5 text-[11px] text-red-600 dark:text-red-400">
                                    存在 SKU 分箱合计 ≠ 实际发货数；请点「调整包裹」调整
                                  </TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )
                  })}
                  </div>
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  {groups.length > 1 && mallAddrs.length > 0 && (
                    <span className="mr-3">
                      批量设置发货仓库：
                      <Select
                        items={mallAddrs.map((a) => ({ value: String(a.id), label: a.label }))}
                        value=""
                        onValueChange={(v) => {
                          if (v) setGroups((gs) => gs.map((g) => ({ ...g, deliveryAddressId: Number(v) })))
                        }}
                      >
                        <SelectTrigger className="ml-1 inline-flex h-7 w-44 text-xs" aria-label="批量设置卖家发货地址">
                          <SelectValue placeholder="选择卖家发货地址" />
                        </SelectTrigger>
                        <SelectContent className="w-auto min-w-72 max-w-[26rem]">
                          {mallAddrs.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)} title={`${a.label}（${a.fullText}）`}>
                              {a.label}（{a.fullText}）
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </span>
                  )}
                  {groupsValid
                    ? `共 ${groups.length} 组 / ${totalOrders} 单，将逐组创建发货单`
                    : "每组需选择发货仓库，且各 SKU 分箱合计 = 发货数"}
                </p>
                <div className="flex flex-nowrap items-center gap-2">
                  <Button size="sm" className="h-8 text-xs" disabled={!groupsValid || loading} onClick={createShipOrders}>
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : null} 确认创建
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setMode("list")}>
                    取消
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {adjustOrder && adjusting != null && (
        <AdjustPackagesSheet
          open
          onOpenChange={(v) => !v && setAdjusting(null)}
          st={stagingBySn.get(adjustOrder.sn)}
          order={adjustOrder}
          storeName={storeName}
          onConfirm={(nums, pkgs) =>
            updateGroup(adjusting.gi, (x) => ({
              ...x,
              orders: x.orders.map((oo, j) => (j === adjusting.oi ? { ...oo, deliverNums: nums, packages: pkgs } : oo)),
            }))
          }
        />
      )}
      </>
    )
  }

  /* ─── 发货台（勾选页，官方图1） ─── */
  const selRows = stagingRows.filter((r) => stagingSel.has(r.subPurchaseOrderSn))
  /** 统计条口径：实际发货数取行内修改后的生效值；剩余需发货数 = 待发货数 − 实际发货数 */
  const stats = {
    orders: selRows.length,
    toDeliver: selRows.reduce((acc, r) => acc + (r.purchaseQuantity ?? 0), 0),
    delivered: selRows.reduce(
      (acc, r) => acc + Object.values(effectiveNumsOf(r)).reduce((a, b) => a + b, 0),
      0,
    ),
    remain: selRows.reduce((acc, r) => {
      const sum = Object.values(effectiveNumsOf(r)).reduce((a, b) => a + b, 0)
      return acc + Math.max(0, (r.purchaseQuantity ?? 0) - sum)
    }, 0),
  }
  const allSelected = stagingRows.length > 0 && stagingRows.every((r) => stagingSel.has(r.subPurchaseOrderSn))

  return (
    // h-full 高度链：筛选/按钮行/统计条固定，备货单表格为内部滚动区
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Combobox
            value={filters.sn || null}
            onChange={(v) => setFilter("sn", v)}
            onSearchChange={(v) => setFilter("sn", v)}
            options={snOptions}
            placeholder="备货单号"
            searchPlaceholder="输入备货单号搜索…"
            className="h-8 w-48 text-xs"
          />
          <Combobox
            value={filters.skc || null}
            onChange={(v) => setFilter("skc", v)}
            onSearchChange={(v) => setFilter("skc", v)}
            options={skcOptions}
            placeholder="SKC"
            searchPlaceholder="输入 SKC 搜索…"
            className="h-8 w-36 text-xs"
          />
          <Combobox
            value={filters.ext || null}
            onChange={(v) => setFilter("ext", v)}
            onSearchChange={(v) => setFilter("ext", v)}
            options={extOptions}
            placeholder="货号"
            searchPlaceholder="输入货号搜索…"
            className="h-8 w-40 text-xs"
          />
          <div className="ml-auto flex items-center gap-2">
            {viewSwitch}
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={loadStaging} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} 刷新
            </Button>
          </div>
        </div>
        {/* 官方按钮行 + 统计条 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={stagingSel.size === 0}
            onClick={() => setMode("create")}
          >
            创建发货单
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={stagingSel.size === 0}
            onClick={() => void openShipBarcodePrint(store, selRows.map((r) => r.productSkcId ?? 0))}
          >
            批量打印商品条码
          </Button>
          <p className="ml-auto text-xs text-muted-foreground">
            已选中备货单数量：<span className="tabular-nums">{stats.orders}</span> · 待发货数量：
            <span className="tabular-nums">{stats.toDeliver}</span> · 实际发货数：
            <span className="tabular-nums">{stats.delivered}</span> · 剩余需发货数：
            <span className="tabular-nums">{stats.remain}</span>
          </p>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-hide">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="overflow-x-auto rounded-md border">
          <Table className="text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={() =>
                      setStagingSel(() =>
                        allSelected ? new Set() : new Set(stagingRows.map((r) => r.subPurchaseOrderSn)),
                      )
                    }
                    aria-label="全选本页"
                  />
                </TableHead>
                <TableHead className="min-w-60">备货单信息</TableHead>
                <TableHead className="w-24">货号</TableHead>
                <TableHead className="w-32">收货仓库</TableHead>
                <TableHead className="w-24 text-right">待发货数（件）</TableHead>
                <TableHead className="w-44 text-right">实际发货数（件）</TableHead>
                <TableHead className="w-28 text-right">剩余需发货数（件）</TableHead>
                <TableHead className="w-44">创建时间</TableHead>
                <TableHead className="w-28">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stagingRows.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                    发货台为空；在「备货」页列表对已接单的备货单点「创建」加入发货台。
                  </TableCell>
                </TableRow>
              ) : (
                stagingRows.map((r) => {
                  const nums = effectiveNumsOf(r)
                  const numSum = Object.values(nums).reduce((a, b) => a + b, 0)
                  // 剩余需发货数 = 待发货数 − 实际发货数（随行内修改联动）
                  const remain = Math.max(0, (r.purchaseQuantity ?? 0) - numSum)
                  return (
                    <TableRow key={r.subPurchaseOrderSn}>
                      <TableCell>
                        <Checkbox
                          checked={stagingSel.has(r.subPurchaseOrderSn)}
                          onCheckedChange={() => toggleSel(r.subPurchaseOrderSn)}
                          aria-label={`选择 ${r.subPurchaseOrderSn}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          {r.productSkcPicture ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.productSkcPicture} alt="" className="size-10 shrink-0 rounded object-cover" loading="lazy" />
                          ) : (
                            <div className="size-10 shrink-0 rounded bg-muted" />
                          )}
                          <div className="min-w-0">
                            <p className="font-mono text-xs font-medium" title={r.productName ?? undefined}>{r.subPurchaseOrderSn}</p>
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              货号 {r.skcExtCode ?? <EmptyHint />}
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                              <span>SKC {r.productSkcId ?? <EmptyHint />}</span>
                              {r.urgencyType === 1 && <Badge className="rounded-[4px] bg-red-500/15 px-1 text-[10px] text-red-700 dark:text-red-400">急采</Badge>}
                              {r.purchaseStockType === 1 && <Badge className="rounded-[4px] bg-muted px-1 text-[10px] text-muted-foreground">JIT</Badge>}
                              {r.isCustomProduct && <Badge className="rounded-[4px] bg-violet-500/15 px-1 text-[10px] text-violet-700 dark:text-violet-400">定制</Badge>}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.skcExtCode ?? <EmptyHint />}</TableCell>
                      <TableCell className="max-w-32">
                        <span className="block truncate text-xs" title={r.receiveAddressText ?? r.subWarehouseName ?? undefined}>
                          {r.subWarehouseName ?? <EmptyHint />}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{r.purchaseQuantity ?? <EmptyHint />}</TableCell>
                      <TableCell>
                        <DeliverNumCell
                          row={r}
                          numSum={numSum}
                          modified={!isDefaultNums(r)}
                          onConfirm={(next) => setAdjust((m) => ({ ...m, [r.subPurchaseOrderSn]: next }))}
                        />
                      </TableCell>
                      <TableCell
                        className="text-right text-xs tabular-nums"
                        title={r.expectLatestDeliverTime ? `最晚发货 ${fmtMs(r.expectLatestDeliverTime)}` : undefined}
                      >
                        {remain}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {r.purchaseTime != null ? fmtMs(r.purchaseTime) : <EmptyHint />}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1 text-xs text-primary hover:underline"
                          onClick={() => void openShipBarcodePrint(store, [r.productSkcId ?? 0])}
                          disabled={!r.productSkcId}
                        >
                          打印商品条码
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

/** 两张发货数映射是否逐 SKU 等值（判断旧草稿是否已反映行内调整值） */
function sameDeliverNums(a: Record<number, number>, b: Record<number, number>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => a[Number(k)] === b[Number(k)])
}

/** 新单默认发货数 = min(SKU 上限, 备货数)（发货台行内调整过则用调整值），单箱装满 */
function defaultOrder(st: TemuShipStagingRow, sn: string, overrides?: Record<number, number>) {
  const deliverNums: Record<number, number> = {}
  for (const s of st.skus) {
    deliverNums[s.productSkuId] =
      overrides?.[s.productSkuId] ??
      Math.min(s.skuDeliveryQuantityMaxLimit ?? 9999, s.productSkuPurchaseQuantity ?? 1)
  }
  return { sn, deliverNums, packages: [{ ...deliverNums }] }
}
