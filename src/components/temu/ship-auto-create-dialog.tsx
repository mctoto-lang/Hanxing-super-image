"use client"

import * as React from "react"
import { toast } from "sonner"
import { Package, Zap } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TemuShipReceiveAddress } from "@/db/schema"
import {
  createShipOrderAction,
  getMallAddressesAction,
  getReceiveAddressesAction,
  getShipInventoryRefAction,
  getShipStagingAction,
  type TemuShipStagingRow,
} from "@/server/actions/temu-ship"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { chunkSns } from "./ship-packing"
import { defaultDeliverNum } from "./ship-auto-create-default"

/**
 * 自动创建发货弹窗（发货台勾选后「自动创建发货」）：创建视图的全自动版——
 * - 发货仓库：全部收货仓分组共用所选的一个卖家发货仓库；
 * - 发货数：每 SKU 默认发货台行内调整值 ?? 官方可发上限（缺上限回落备货数；可改，钳制 1–上限）；
 * - 拆包裹：按货号「每包件数」（默认读库存档案装箱数 cartonQty，未建档=整单一包）
 *   定长拆箱——前包满装、尾包裹余数（每 SKU 合计=发货数；多 SKU 第 i 箱合并为第 i 包），
 *   单包裹数 >10（官方上限）红字阻断该单并提示增大每包件数；
 * - 确认执行：fresh 发货台预检（超时单阻断）→ 逐组 createShipOrderAction（bg.shiporderv3.create）。
 */

/** 定长拆箱：每包件数 per → 前包满装、尾包裹余数；per 非法/<=0 视为整单一包；>10 包返回 null */
function splitPackages(
  deliverNums: Record<number, number>,
  per: number | null,
): Array<Record<number, number>> | null {
  if (per == null || per < 1) return [{ ...deliverNums }]
  let boxCount = 1
  for (const n of Object.values(deliverNums)) {
    const need = Math.ceil(n / per)
    if (need > boxCount) boxCount = need
  }
  if (boxCount > 10) return null
  const packages: Array<Record<number, number>> = []
  for (let i = 0; i < boxCount; i++) packages.push({})
  for (const [idStr, n] of Object.entries(deliverNums)) {
    const id = Number(idStr)
    let left = n
    let i = 0
    while (left > 0) {
      const put = Math.min(per, left)
      packages[i]![id] = put
      left -= put
      i++
    }
  }
  return packages
}

export function AutoCreateShipDialog({
  store,
  rows,
  initialNums,
  onClose,
  onCreated,
}: {
  store: string
  /** 发货台勾选行（快照传入，弹窗内不再随列表刷新变化） */
  rows: TemuShipStagingRow[]
  /** 发货台行内调整快照，sn → skuId → 数量（优先于默认可发上限） */
  initialNums?: Record<string, Record<number, number>>
  onClose: () => void
  /** 任一单创建成功后回调（父层刷新发货台） */
  onCreated: () => void
}) {
  const [loading, startLoading] = React.useTransition()
  const [creating, startCreating] = React.useTransition()
  const [confirming, setConfirming] = React.useState(false)
  /** 收货仓分组（官方 receiveaddressv2；含收货地址——创建载荷必填） */
  const [groups, setGroups] = React.useState<
    Array<{ subWarehouseId: number; receiveAddress: TemuShipReceiveAddress; sns: string[] }>
  >([])
  const [mallAddrs, setMallAddrs] = React.useState<
    Array<{ id: number; label: string; isDefault: boolean; fullText: string }>
  >([])
  /** 全部组共用的发货仓库 */
  const [addressId, setAddressId] = React.useState<number | null>(null)
  /** 每 SKU 发货数（sn → skuId → 数量），默认发货台调整值 ?? 可发上限（缺上限回落备货数） */
  const [nums, setNums] = React.useState<Record<string, Record<number, number>>>({})
  /** 每货号每包件数（原始货号串 → 输入值；空串=整单一包） */
  const [perByCode, setPerByCode] = React.useState<Record<string, string>>({})

  // 初始：收货仓分组 + 档案装箱数（库存参考扩展字段）+ 发货仓库下拉
  React.useEffect(() => {
    let cancelled = false
    startLoading(async () => {
      const sns = rows.map((r) => r.subPurchaseOrderSn)
      // 收货地址分组：schema subPurchaseOrderSns 单次上限 50，按 50/批分片请求后按收货仓合并（跨批同仓合为一组）
      const [addr, invRef] = await Promise.all([
        (async () => {
          const byWh = new Map<
            number,
            { subWarehouseId: number; receiveAddress: TemuShipReceiveAddress; sns: string[] }
          >()
          for (const batch of chunkSns(sns)) {
            const r = await getReceiveAddressesAction({ store, subPurchaseOrderSns: batch })
            if (!r.ok) return r
            for (const g of r.groups) {
              const hit = byWh.get(g.subWarehouseId)
              if (hit) {
                hit.sns.push(...g.subPurchaseOrderSns)
              } else {
                byWh.set(g.subWarehouseId, {
                  subWarehouseId: g.subWarehouseId,
                  receiveAddress: g.receiveAddress,
                  sns: [...g.subPurchaseOrderSns],
                })
              }
            }
          }
          return { ok: true as const, groups: [...byWh.values()] }
        })(),
        getShipInventoryRefAction({
          store,
          codes: rows.map((r) => r.skcExtCode).filter((c): c is string => !!c),
        }),
      ])
      if (cancelled) return
      if (!addr.ok) {
        toast.error(`收货地址分组获取失败：${addr.error}`, { duration: 8000 })
        return
      }
      const selSet = new Set(sns)
      const gs = addr.groups
        .map((g) => ({
          subWarehouseId: g.subWarehouseId,
          receiveAddress: g.receiveAddress,
          sns: g.sns.filter((sn) => selSet.has(sn)),
        }))
        .filter((g) => g.sns.length > 0)
      setGroups(gs)
      const grouped = new Set(gs.flatMap((g) => g.sns))
      const missing = sns.filter((sn) => !grouped.has(sn))
      if (missing.length > 0) {
        toast.warning(`${missing.length} 单未返回收货地址分组（可能已超时移出发货台），创建时将跳过`, { duration: 8000 })
      }
      // 发货数默认值（发货台行内调整优先，否则官方可发上限；缺上限回落备货数）+ 每包件数默认（档案装箱数）
      const nextNums: Record<string, Record<number, number>> = {}
      const nextPer: Record<string, string> = {}
      for (const r of rows) {
        const bySku: Record<number, number> = {}
        for (const s of r.skus) {
          bySku[s.productSkuId] = defaultDeliverNum(
            s,
            initialNums?.[r.subPurchaseOrderSn]?.[s.productSkuId],
          )
        }
        nextNums[r.subPurchaseOrderSn] = bySku
        if (r.skcExtCode) {
          const carton = invRef.ok ? (invRef.rows[r.skcExtCode]?.cartonQty ?? null) : null
          nextPer[r.skcExtCode] = carton != null && carton > 0 ? String(carton) : ""
        }
      }
      setNums(nextNums)
      setPerByCode(nextPer)
      const m = await getMallAddressesAction(store)
      if (cancelled) return
      if (m.ok) {
        setMallAddrs(m.rows)
        setAddressId((m.rows.find((a) => a.isDefault) ?? m.rows[0])?.id ?? null)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const bySn = React.useMemo(() => new Map(rows.map((r) => [r.subPurchaseOrderSn, r])), [rows])
  /** 每单拆包裹结果（null=超 10 包阻断）与包裹数 */
  const planOf = React.useCallback(
    (sn: string) => {
      const row = bySn.get(sn)
      const deliverNums = nums[sn]
      if (!row || !deliverNums) return { packages: null as Array<Record<number, number>> | null, count: 0 }
      const perRaw = row.skcExtCode ? (perByCode[row.skcExtCode] ?? "") : ""
      const per = Number(perRaw)
      const packages = splitPackages(
        deliverNums,
        perRaw.trim() !== "" && Number.isFinite(per) && per >= 1 ? Math.floor(per) : null,
      )
      return { packages, count: packages?.length ?? 0 }
    },
    [bySn, nums, perByCode],
  )

  const groupSns = React.useMemo(() => groups.flatMap((g) => g.sns), [groups])
  const validSns = React.useMemo(() => groupSns.filter((sn) => planOf(sn).packages != null), [groupSns, planOf])
  const invalidSns = React.useMemo(() => groupSns.filter((sn) => planOf(sn).packages == null), [groupSns, planOf])
  const totalSkus = validSns.reduce(
    (acc, sn) => acc + Object.values(nums[sn] ?? {}).reduce((a, n) => a + n, 0),
    0,
  )
  const totalPkgs = validSns.reduce((acc, sn) => acc + (planOf(sn).count || 0), 0)
  const selAddr = mallAddrs.find((a) => a.id === addressId)

  /** 执行创建：fresh 预检超时单 → 逐组 createShipOrderAction */
  const runCreate = () => {
    startCreating(async () => {
      const allSns = [...validSns]
      const pre = await getShipStagingAction({
        store,
        subPurchaseOrderSn: allSns.join(","),
        fresh: true,
      })
      if (pre.ok) {
        const present = new Set(pre.rows.map((r) => r.subPurchaseOrderSn))
        const missing = allSns.filter((sn) => !present.has(sn))
        if (missing.length > 0) {
          toast.error(
            `${missing.length} 单已不在发货台（可能已超时被自动移出），请关闭弹窗刷新后重选`,
            { duration: 8000 },
          )
          return
        }
      } else {
        toast.warning(`发货台核对失败（${pre.error}），已跳过核对直接创建`, { duration: 8000 })
      }
      const validSet = new Set(validSns)
      const results: Array<{ sn: string; ok: boolean; msg?: string }> = []
      const warnings: string[] = []
      for (const g of groups) {
        const sns = g.sns.filter((sn) => validSet.has(sn))
        if (sns.length === 0 || addressId == null) continue
        try {
          const r = await createShipOrderAction({
            store,
            groups: [
              {
                subWarehouseId: g.subWarehouseId,
                receiveAddressInfo: g.receiveAddress,
                deliveryAddressId: addressId,
                orders: sns.map((sn) => {
                  const deliverNums = nums[sn] ?? {}
                  return {
                    subPurchaseOrderSn: sn,
                    deliverOrderDetailInfos: Object.entries(deliverNums).map(([id, n]) => ({
                      productSkuId: Number(id),
                      deliverSkuNum: n,
                    })),
                    packageInfos: (planOf(sn).packages ?? []).map((p) => ({
                      packageDetailSaveInfos: Object.entries(p)
                        .filter(([, n]) => n > 0)
                        .map(([id, n]) => ({ productSkuId: Number(id), skuNum: n })),
                    })),
                  }
                }),
              },
            ],
          })
          if (r.ok) {
            results.push(...r.deliveryOrderSns.map((sn) => ({ sn, ok: true as const })))
            if (r.warning) warnings.push(r.warning)
          } else {
            results.push({ sn: sns.join("、"), ok: false, msg: r.error })
          }
        } catch (e) {
          results.push({
            sn: sns.join("、"),
            ok: false,
            msg: e instanceof Error ? e.message : String(e),
          })
        }
      }
      if (warnings.length > 0) toast.warning(warnings.join("；"), { duration: 10_000 })
      const okCount = results.filter((r) => r.ok).length
      if (okCount === 0) {
        toast.error(`全部创建失败：${results.find((r) => !r.ok)?.msg ?? "未知原因"}`, { duration: 10_000 })
        return
      }
      toast.success(
        okCount === results.length
          ? `已自动创建 ${okCount} 张发货单，请在发货单列表·待装箱发货装箱发货`
          : `部分成功：${okCount}/${results.length} 张发货单，失败：${results.find((r) => !r.ok)?.msg ?? ""}`,
        { duration: 10_000 },
      )
      onCreated()
      onClose()
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(v, details) => {
        if (!v && (creating || loading)) {
          details.cancel()
          toast.warning(creating ? "创建执行中，请等待完成" : "配置加载中，请稍候")
          return
        }
        if (!v) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>自动创建发货（{rows.length} 单）</DialogTitle>
          <DialogDescription>
            发货数默认取官方可发上限（可改）；每包件数默认读库存档案「装箱数」（可改，空=整单一包），定长装箱拆包裹（尾包裹余数）；跨收货仓自动分组、全部组共用所选发货仓库。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-hide">
          {/* 发货仓库（全部组共用） */}
          <div className="space-y-1">
            <Label className="text-xs">
              <span className="text-red-600">*</span> 发货仓库（本批全部收货仓分组共用）
            </Label>
            <Select
              items={mallAddrs.map((a) => ({ value: String(a.id), label: a.label }))}
              value={String(addressId ?? "")}
              onValueChange={(v) => v && setAddressId(Number(v))}
            >
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue placeholder={mallAddrs.length === 0 ? "地址加载中…" : "选择发货仓库"} />
              </SelectTrigger>
              <SelectContent className="w-auto min-w-72 max-w-[26rem]">
                {mallAddrs.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.label}（{a.fullText}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {selAddr ? `发货地址：${selAddr.fullText}` : " "}
            </p>
          </div>

          {/* 单据明细：每单发货数（per SKU）+ 每包件数 + 拆包裹预览 */}
          <div className="space-y-2">
            <p className="text-sm font-medium">单据明细</p>
            {loading && groups.length === 0 && (
              <p className="text-xs text-muted-foreground">配置加载中…</p>
            )}
            <div className="divide-y rounded-md border">
              {rows.map((r) => {
                const plan = planOf(r.subPurchaseOrderSn)
                const perRaw = r.skcExtCode ? (perByCode[r.skcExtCode] ?? "") : ""
                return (
                  <div key={r.subPurchaseOrderSn} className="space-y-1.5 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px]">{r.subPurchaseOrderSn}</span>
                      {r.skcExtCode && (
                        <Badge className="rounded-[4px] bg-muted px-1 text-[10px] text-muted-foreground">
                          {r.skcExtCode}
                        </Badge>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {plan.packages == null ? (
                          <span className="text-red-600 dark:text-red-400">
                            拆分超 10 包——请增大每包件数或减少发货数
                          </span>
                        ) : (
                          <>
                            <Package className="mr-0.5 inline size-3" />
                            {plan.count} 包 ·{" "}
                            {Object.values(nums[r.subPurchaseOrderSn] ?? {}).reduce((a, n) => a + n, 0)} 件
                          </>
                        )}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {r.skcExtCode && (
                        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          每包件数
                          <Input
                            className="h-6 w-16 rounded-md text-xs tabular-nums"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={perRaw}
                            placeholder="整单"
                            onChange={(e) =>
                              setPerByCode((s) => ({ ...s, [r.skcExtCode!]: e.target.value }))
                            }
                            onBlur={(e) => {
                              // 失焦回写整数（与 planOf 的 floor 计算一致）；空串/非法保持原样
                              const raw = e.target.value
                              if (raw.trim() === "") return
                              const n = Math.floor(Number(raw))
                              if (Number.isFinite(n) && n >= 1) {
                                setPerByCode((s) => ({ ...s, [r.skcExtCode!]: String(n) }))
                              }
                            }}
                          />
                        </label>
                      )}
                      {r.skus.map((s) => (
                        <label
                          key={s.productSkuId}
                          className="flex items-center gap-1 text-[11px] text-muted-foreground"
                        >
                          SKU {s.productSkuId}
                          <Input
                            className="h-6 w-16 rounded-md text-xs tabular-nums"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={nums[r.subPurchaseOrderSn]?.[s.productSkuId] ?? ""}
                            onChange={(e) => {
                              const v = Number(e.target.value)
                              setNums((prev) => ({
                                ...prev,
                                [r.subPurchaseOrderSn]: {
                                  ...(prev[r.subPurchaseOrderSn] ?? {}),
                                  [s.productSkuId]: Math.min(
                                    s.skuDeliveryQuantityMaxLimit ?? 9999,
                                    Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1,
                                  ),
                                },
                              }))
                            }}
                          />
                          件
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 汇总 */}
          <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
            有效 {validSns.length} 单（{groups.length} 个收货仓分组）· 发货 {totalSkus} 件 · 共 {totalPkgs} 包
            {invalidSns.length > 0 && (
              <span className="text-red-600 dark:text-red-400">
                ；{invalidSns.length} 单拆分超 10 包已阻断（不会创建）
              </span>
            )}
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={loading || creating}>
            关闭
          </Button>
          <Button
            size="sm"
            disabled={loading || creating || validSns.length === 0 || addressId == null}
            onClick={() => setConfirming(true)}
          >
            {creating ? <DashRing className="size-3.5" /> : <Zap className="size-3.5" />}
            自动创建（{validSns.length}）
          </Button>
        </DialogFooter>
      </DialogContent>

      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setConfirming(false)}
          title="确认自动创建发货单"
          description={`将按收货仓分 ${groups.length} 组创建 ${validSns.length} 张发货单（发货 ${totalSkus} 件 / ${totalPkgs} 包，发货仓库共用 ${selAddr?.label ?? "—"}）。创建后自动进入「待装箱发货」。`}
          confirmText="开始创建"
          pending={creating}
          onConfirm={() => {
            setConfirming(false)
            runCreate()
          }}
        />
      )}
    </Dialog>
  )
}
