"use client"

import * as React from "react"
import { toast } from "sonner"
import { Package, TriangleAlert, Zap } from "lucide-react"
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
import { EmptyHint } from "@/components/temu/empty-hint"
import { TruncTip } from "@/components/temu/trunc-tip"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { cn } from "@/lib/utils"
import { chunkSns } from "./ship-packing"
import {
  defaultDeliverNum,
  expandGroupOutcome,
  isOfficiallyUndeliverable,
} from "./ship-auto-create-default"
import { packageTotals, parsePerPackage, splitPackages } from "./ship-package-split"
import { GROUP_TD, GROUP_TH, WarehouseGroupCard } from "./ship-warehouse-group"

/**
 * 自动创建发货弹窗（发货台勾选后「自动创建发货」）：创建视图的全自动版——
 * - 发货仓库：全部收货仓分组共用所选的一个卖家发货仓库；
 * - 发货数：每 SKU 默认发货台行内调整值 ?? 官方可发上限（缺上限回落备货数；可改，钳制 1–上限，
 *   上限 ≤0 不钳——该单整单阻断）；
 * - 拆包裹：按货号「每包件数」（默认读库存档案装箱数 cartonQty，未建档=整单一包）
 *   定长拆箱（splitPackages）——前包满装、尾包裹余数，单包裹数 >10（官方上限）红字阻断该单；
 * - 官方可发上限 ≤0（官方判定不可发）的单同样整单阻断：deliverSkuNum schema min(1)，
 *   0 件只会换来无字段的「参数错误」，故不入创建、行内红字提示；
 * - 明细按收货仓分组展示（组头单数/件数/包数，组内表格：缩略图/款名/货号、每 SKU 发货数、
 *   每包件数、拆包预览、结果）；
 * - 确认执行：fresh 发货台预检（超时单阻断）→ 逐组 createShipOrderAction（bg.shiporderv3.create）。
 */

/** 收货仓分组（官方 receiveaddressv2；含收货地址——创建载荷必填） */
interface CreateGroup {
  subWarehouseId: number
  /** 收货仓名（发货台行 subWarehouseName；缺失回落「收货仓{id}」） */
  name: string
  receiveAddress: TemuShipReceiveAddress
  sns: string[]
}

const sumValues = (m: Record<number, number> | undefined) =>
  Object.values(m ?? {}).reduce((a, n) => a + n, 0)

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
  const [groups, setGroups] = React.useState<CreateGroup[]>([])
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
            { receiveAddress: TemuShipReceiveAddress; sns: string[] }
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
                  receiveAddress: g.receiveAddress,
                  sns: [...g.subPurchaseOrderSns],
                })
              }
            }
          }
          return {
            ok: true as const,
            groups: [...byWh].map(([subWarehouseId, g]) => ({
              subWarehouseId,
              receiveAddress: g.receiveAddress,
              sns: g.sns,
            })),
          }
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
      const nameBySn = new Map(rows.map((r) => [r.subPurchaseOrderSn, r.subWarehouseName]))
      const gs: CreateGroup[] = addr.groups
        .map((g) => {
          const named = g.sns.find((sn) => nameBySn.get(sn))
          return {
            subWarehouseId: g.subWarehouseId,
            name: (named ? nameBySn.get(named) : null) ?? `收货仓${g.subWarehouseId}`,
            receiveAddress: g.receiveAddress,
            sns: g.sns.filter((sn) => selSet.has(sn)),
          }
        })
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
      const packages = splitPackages(
        deliverNums,
        row.skcExtCode ? parsePerPackage(perByCode[row.skcExtCode]) : null,
      )
      return { packages, count: packages?.length ?? 0 }
    },
    [bySn, nums, perByCode],
  )

  const groupSns = React.useMemo(() => groups.flatMap((g) => g.sns), [groups])
  /** 官方可发上限 ≤0 的单（整单阻断，不创建：schema min(1)，0 件只会换来「参数错误」） */
  const skuBlockedOf = React.useCallback(
    (sn: string) => {
      const row = bySn.get(sn)
      return row ? row.skus.some(isOfficiallyUndeliverable) : false
    },
    [bySn],
  )
  const validSns = React.useMemo(
    () => groupSns.filter((sn) => planOf(sn).packages != null && !skuBlockedOf(sn)),
    [groupSns, planOf, skuBlockedOf],
  )
  const invalidSns = React.useMemo(
    () => groupSns.filter((sn) => planOf(sn).packages == null || skuBlockedOf(sn)),
    [groupSns, planOf, skuBlockedOf],
  )
  /** 未返回收货地址分组的单（创建时跳过） */
  const ungroupedRows = React.useMemo(
    () => rows.filter((r) => !groupSns.includes(r.subPurchaseOrderSn)),
    [rows, groupSns],
  )
  const totalSkus = validSns.reduce((acc, sn) => acc + sumValues(nums[sn]), 0)
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
            results.push(...expandGroupOutcome(r.deliveryOrderSns, true))
            if (r.warning) warnings.push(r.warning)
          } else {
            // 失败同样逐单展开：保证「部分成功 x/y」分母与成功侧同为张数口径
            results.push(...expandGroupOutcome(sns, false, r.error))
          }
        } catch (e) {
          results.push(
            ...expandGroupOutcome(sns, false, e instanceof Error ? e.message : String(e)),
          )
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
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>自动创建发货（{rows.length} 单）</DialogTitle>
          <DialogDescription>
            发货数默认取官方可发上限（可改）；每包件数默认读库存档案「装箱数」（可改，空=整单一包），定长装箱拆包裹（尾包裹余数）；按收货仓分组创建、全部组共用所选发货仓库。
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

          {/* 单据明细：按收货仓分组 → 组内表格（缩略图/款名/货号、每 SKU 发货数、每包件数、拆包预览、结果） */}
          <div className="space-y-2">
            {loading && groups.length === 0 && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <DashRing className="size-3.5" /> 配置加载中…
              </p>
            )}
            {!loading && groups.length === 0 && rows.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                未获取到收货地址分组，本次不会创建任何发货单
              </p>
            )}
            {groups.map((g) => {
              const member = new Set(g.sns)
              const gRows = rows.filter((r) => member.has(r.subPurchaseOrderSn))
              const gSkus = g.sns.reduce((acc, sn) => acc + sumValues(nums[sn]), 0)
              const gPkgs = g.sns.reduce((acc, sn) => acc + (planOf(sn).count || 0), 0)
              return (
                <WarehouseGroupCard
                  key={g.subWarehouseId}
                  name={g.name}
                  meta={`${g.sns.length} 单 · ${gSkus} 件 · ${gPkgs} 包`}
                >
                  <div className="overflow-x-auto border-t">
                    <table className="w-full text-xs">
                      <thead>
                        <tr>
                          <th className={GROUP_TH}>商品</th>
                          <th className={GROUP_TH}>SKU 发货数</th>
                          <th className={GROUP_TH}>每包件数</th>
                          <th className={GROUP_TH}>拆包预览</th>
                          <th className={cn(GROUP_TH, "text-right")}>结果</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {gRows.map((r) => {
                          const plan = planOf(r.subPurchaseOrderSn)
                          const undeliverable = r.skus.some(isOfficiallyUndeliverable)
                          const blocked = plan.packages == null || undeliverable
                          return (
                            <tr
                              key={r.subPurchaseOrderSn}
                              className={blocked ? "bg-red-500/5" : undefined}
                            >
                              <td className={GROUP_TD}>
                                <div className="flex items-center gap-2.5">
                                  {r.productSkcPicture ? (
                                    <ZoomableImage
                                      src={r.productSkcPicture}
                                      alt={r.productName ?? ""}
                                      className="size-10 shrink-0 rounded object-cover"
                                    />
                                  ) : (
                                    <div className="size-10 shrink-0 rounded bg-muted" />
                                  )}
                                  <div className="min-w-0">
                                    <TruncTip
                                      text={r.productName}
                                      className="max-w-52"
                                    />
                                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                      {r.skcExtCode ? (
                                        <Badge className="rounded-[4px] bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                                          {r.skcExtCode}
                                        </Badge>
                                      ) : (
                                        <EmptyHint />
                                      )}
                                      <span className="font-mono">{r.subPurchaseOrderSn}</span>
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className={GROUP_TD}>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                  {r.skus.map((s) => (
                                    <label
                                      key={s.productSkuId}
                                      className="flex items-center gap-1 text-[11px] text-muted-foreground"
                                    >
                                      <span className="font-mono">SKU {s.productSkuId}</span>
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
                                                // 上限 ≤0（官方不可发）不钳：整单已阻断不创建，钳 0 会让输入恒 0
                                                isOfficiallyUndeliverable(s)
                                                  ? 9999
                                                  : (s.skuDeliveryQuantityMaxLimit ?? 9999),
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
                              </td>
                              <td className={GROUP_TD}>
                                {r.skcExtCode ? (
                                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                    <Input
                                      className="h-6 w-16 rounded-md text-xs tabular-nums"
                                      type="number"
                                      inputMode="numeric"
                                      min={1}
                                      value={perByCode[r.skcExtCode] ?? ""}
                                      placeholder="整单"
                                      onChange={(e) =>
                                        setPerByCode((s) => ({ ...s, [r.skcExtCode!]: e.target.value }))
                                      }
                                      onBlur={(e) => {
                                        // 失焦回写整数（与 parsePerPackage 的 floor 计算一致）；空串/非法保持原样
                                        const n = parsePerPackage(e.target.value)
                                        if (n != null) {
                                          setPerByCode((s) => ({ ...s, [r.skcExtCode!]: String(n) }))
                                        }
                                      }}
                                    />
                                    <span className="whitespace-nowrap">件/包</span>
                                  </label>
                                ) : (
                                  <span className="text-[11px] text-muted-foreground">未取到货号，按整单一包</span>
                                )}
                              </td>
                              <td className={GROUP_TD}>
                                {blocked ? (
                                  <span className="text-red-600 dark:text-red-400">
                                    {undeliverable ? "官方可发上限为 0" : "拆分超 10 包"}
                                  </span>
                                ) : (
                                  <div className="flex flex-wrap items-center gap-1">
                                    {packageTotals(plan.packages).map((n, i) => (
                                      <span
                                        key={i}
                                        className="rounded-[4px] border bg-muted/40 px-1.5 py-0.5 font-mono tabular-nums"
                                      >
                                        {n}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td className={cn(GROUP_TD, "text-right whitespace-nowrap")}>
                                {blocked ? (
                                  <span className="text-red-600 dark:text-red-400">
                                    {undeliverable
                                      ? "已阻断：官方可发上限为 0（不可发）"
                                      : "已阻断：请增大每包件数或减少发货数"}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 tabular-nums">
                                    <Package className="size-3" />
                                    {plan.count} 包 · {sumValues(nums[r.subPurchaseOrderSn])} 件
                                  </span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </WarehouseGroupCard>
              )
            })}
            {ungroupedRows.length > 0 && (
              <div className="rounded-md border border-dashed px-3 py-2 text-xs">
                <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="size-3.5" />
                  未分组 · {ungroupedRows.length} 单（未返回收货地址分组，可能已超时移出发货台，创建时跳过）
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {ungroupedRows.map((r) => (
                    <span
                      key={r.subPurchaseOrderSn}
                      className="rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {r.skcExtCode ?? r.subPurchaseOrderSn}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 汇总 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <span>
              有效 {validSns.length} 单（{groups.length} 个收货仓分组）
            </span>
            <span className="tabular-nums">发货 {totalSkus} 件</span>
            <span className="tabular-nums">共 {totalPkgs} 包</span>
            {invalidSns.length > 0 && (
              <span className="text-red-600 dark:text-red-400">
                {invalidSns.length} 单已阻断（拆分超 10 包或官方可发上限为 0，不会创建）
              </span>
            )}
          </div>
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
