"use client"

import * as React from "react"
import { Ban, Plus, RefreshCw, TriangleAlert } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyHint } from "@/components/temu/empty-hint"
import { TruncTip } from "@/components/temu/trunc-tip"
import { ZoomableImage } from "@/components/ui/zoomable-image"
import { PickupTimePicker, parsePickupSlots } from "@/components/temu/pickup-time-picker"
import { cn } from "@/lib/utils"
import {
  getLogisticsMatchAction,
  getShipPredictVolumeAction,
  packingMatchAction,
  type TemuLogisticsPrefItem,
  type TemuShipLogisticsOption,
  type TemuShipOrderRow,
  type TemuShipPackageInfo,
} from "@/server/actions/temu-ship"
import { chunkSns } from "./ship-packing"
import { pickPriorityLogisticsOption } from "./ship-logistics-select"
import {
  effectivePackageCount,
  planPackageTotals,
  type StockProjection,
  type WarehouseGroup,
} from "./ship-auto-ship-plan"
import { GROUP_TD, GROUP_TH, WarehouseGroupCard } from "./ship-warehouse-group"
import {
  RowStatusIcon,
  type GroupRuntime,
  type InvRef,
  type Phase,
  type RowState,
} from "./ship-auto-ship-shared"

type MatchResult = Extract<Awaited<ReturnType<typeof getLogisticsMatchAction>>, { ok: true }>

/**
 * 自动发货的收货仓分组卡片：组头为该组的发货参数（重量/体积自动回填可改、物流公司、
 * 预约取货时间、重新比价），组内表格逐单展示包裹（已打印=真实包裹号与每包件数，
 * 未打印=按库存档案装箱数推算的「预计」拆包）、装箱数、发货件数、库存 → 扣减后。
 * 物流严格口径：比价结果剔除黑名单后必须命中「优先顺序」内公司，否则阻断并提供
 * 「加入优先」（选司即时重选）→ 保存偏好，或手动指定。
 */
function AutoShipGroupCard({
  store,
  group,
  matchToken,
  addressId,
  configLoaded,
  priority,
  blacklist,
  prefDirty,
  prefFailed,
  invLinked,
  invRef,
  stock,
  pkgInfo,
  lockedSns,
  rowStatus,
  active,
  phase,
  onRuntime,
  onAddPriority,
  onSavePrefs,
}: {
  store: string
  group: WarehouseGroup<TemuShipOrderRow>
  /** 发货仓库就绪标识（地址 id#变化计数）；空串=尚未就绪不比价。变化即整组重新比价 */
  matchToken: string
  addressId: number | null
  configLoaded: boolean
  priority: TemuLogisticsPrefItem[]
  blacklist: TemuLogisticsPrefItem[]
  prefDirty: boolean
  /** 偏好配置加载失败：名单不可信，「加入优先/保存偏好」禁用防整体覆盖企业配置 */
  prefFailed: boolean
  invLinked: boolean
  invRef: InvRef | null
  stock: ReadonlyMap<string, StockProjection | null>
  pkgInfo: Record<string, TemuShipPackageInfo[]>
  /** 执行中打印请求成功的单号（件数已锁定）：界面即时按「已打印」展示，不再显示「待打印」 */
  lockedSns: ReadonlySet<string>
  rowStatus: Record<string, RowState>
  /** 执行中的当前组 */
  active: boolean
  phase: Phase
  onRuntime: (key: string, patch: Partial<GroupRuntime>) => void
  onAddPriority: (item: TemuLogisticsPrefItem) => void
  onSavePrefs: () => void
}) {
  const { key, rows } = group
  const first = rows[0]
  const editable = phase === "confirm"
  const [match, setMatch] = React.useState<MatchResult | null>(null)
  const [option, setOption] = React.useState<TemuShipLogisticsOption | null>(null)
  /** 严格口径阻断原因（null=已选到公司） */
  const [blocked, setBlocked] = React.useState<"empty" | "all-blacklisted" | "no-priority" | null>(null)
  /** 用户手动指定后，名单变化不再覆盖其选择 */
  const manualRef = React.useRef(false)
  /** 比价请求序号：切换发货仓库等场景并发两次比价时，旧请求的结果/回填一律丢弃 */
  const matchSeqRef = React.useRef(0)
  const [matching, setMatching] = React.useState(false)
  const [weightKg, setWeightKg] = React.useState("")
  const [volume, setVolume] = React.useState("")
  const [volFallback, setVolFallback] = React.useState(false)

  const totalSkus = rows.reduce((acc, r) => acc + (r.deliverSkcNum ?? 0), 0)
  /** 货号 → 档案装箱数（推算/统一包裹数口径共用） */
  const cartonOf = (r: TemuShipOrderRow) =>
    r.skcExtCode ? (invRef?.[r.skcExtCode]?.cartonQty ?? null) : null
  /** 组头展示的包裹数：真实（官方包裹查询 >0）→ 官方/本地包裹数 → 未打印按装箱数推算 → 兜底 1 */
  const displayPkgs = rows.reduce(
    (acc, r) => acc + effectivePackageCount(r, pkgInfo[r.deliveryOrderSn]?.length ?? null, cartonOf(r)),
    0,
  )
  const slots = React.useMemo(() => parsePickupSlots(option?.channelScheduleTimeList), [option])

  /** 重量（packing.match）/ 体积（predict.volume.get）回填：按 50 单/批求和；
   *  重量取整千克且 ≥1；体积官方未返回按 0.01 兜底 */
  const loadWeightVolume = async (): Promise<{ kg: number; vol: string; fallback: boolean }> => {
    const batches = chunkSns(rows.map((r) => r.deliveryOrderSn))
    const [sumWeight, sumVolume] = await Promise.all([
      (async () => {
        let sum: number | null = null
        for (const b of batches) {
          const r = await packingMatchAction({ store, deliveryOrderSns: b }).catch(() => null)
          if (!r || !r.ok) continue
          sum = r.skuSumWeight == null ? null : (sum ?? 0) + r.skuSumWeight
        }
        return sum
      })(),
      (async () => {
        let sum: number | null = null
        let missing = false
        for (const b of batches) {
          const v = await getShipPredictVolumeAction({ store, deliveryOrderSns: b }).catch(() => null)
          if (!v || !v.ok) {
            missing = true
            continue
          }
          const n = v.predictVolume != null ? Number(v.predictVolume) : NaN
          if (Number.isFinite(n)) sum = (sum ?? 0) + n
          else missing = true
        }
        return missing ? null : sum
      })(),
    ])
    return {
      kg: sumWeight != null ? Math.max(1, Math.ceil(sumWeight / 1000)) : 1,
      vol: sumVolume != null ? String(sumVolume) : "0.01",
      fallback: sumVolume == null,
    }
  }

  /** 比价（logisticsmatch 官方六必填）；>50 单的组只按首批比价，发货参数整组共用。
   *  序号守卫：比价进行中发货仓库变化会并发起新一轮比价，旧请求（旧地址闭包）的
   *  回填/结果/报错一律丢弃，matching 由最新一次请求收口 */
  const runMatch = React.useCallback(
    async (kgIn?: number, volIn?: string) => {
      if (!first?.receiveAddress) {
        onRuntime(key, { loading: false, error: null, option: null, pickTimeMs: null })
        return
      }
      const seq = ++matchSeqRef.current
      setMatch(null)
      setOption(null)
      setBlocked(null)
      setMatching(true)
      manualRef.current = false
      // 公司清空 → 预约时间一并清空（取货时间选择器按公司 key 重建后回传新默认值）
      onRuntime(key, { loading: true, error: null, option: null, pickTimeMs: null })
      try {
        let kg = kgIn
        let vol = volIn
        if (kg == null || vol == null) {
          const w = await loadWeightVolume()
          if (seq !== matchSeqRef.current) return
          kg = w.kg
          vol = w.vol
          setWeightKg(String(kg))
          setVolume(vol)
          setVolFallback(w.fallback)
          onRuntime(key, { weightKg: String(kg), volume: vol, volumeFallback: w.fallback })
        }
        const m = await getLogisticsMatchAction({
          store,
          deliveryOrderSns: chunkSns(rows.map((r) => r.deliveryOrderSn))[0]!,
          receiveAddressInfo: first.receiveAddress,
          deliveryAddressId: addressId ?? first.deliveryAddressId ?? 0,
          predictTotalPackageWeight: Math.max(1, kg) * 1000,
          subWarehouseId: first.subWarehouseId ?? 0,
          totalPackageNum: rows.reduce(
            (acc, r) => acc + effectivePackageCount(r, pkgInfo[r.deliveryOrderSn]?.length ?? null, cartonOf(r)),
            0,
          ),
          predictVolume: vol.trim() || undefined,
        })
        if (seq !== matchSeqRef.current) return
        if (m.ok) {
          // loading 保持到自动选司完成（须等物流偏好就绪），由下方 effect 收口
          setMatch(m)
        } else {
          onRuntime(key, { loading: false, error: m.error })
        }
      } catch (e) {
        if (seq !== matchSeqRef.current) return
        onRuntime(key, { loading: false, error: e instanceof Error ? e.message : "比价失败" })
      } finally {
        if (seq === matchSeqRef.current) setMatching(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, key, first, addressId],
  )

  // 发货仓库就绪 / 变化 → 重量体积回填 + 比价
  React.useEffect(() => {
    if (!matchToken) return
    void runMatch()
  }, [matchToken, runMatch])

  // 比价结果到达（或名单变化）→ 严格口径自动选司：剔除黑名单后必须命中优先名单
  React.useEffect(() => {
    if (!match || !configLoaded) return
    if (manualRef.current) {
      // 手动指定后名单变化不再覆盖其选择——除非所选公司已被拉黑：
      // 复位手动标记走自动重选（或进入阻断），不再用黑名单公司发货
      const manualBanned =
        option != null && blacklist.some((b) => b.expressCompanyId === option.expressCompanyId)
      if (!manualBanned) {
        onRuntime(key, { loading: false })
        return
      }
      manualRef.current = false
    }
    const r = pickPriorityLogisticsOption(match.list, priority, blacklist)
    setOption(r.option)
    setBlocked(r.option ? null : r.reason)
    const patch: Partial<GroupRuntime> = { loading: false, option: r.option, error: null }
    if (!r.option) patch.pickTimeMs = null
    onRuntime(key, patch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, configLoaded, priority, blacklist])

  const pickManual = (id: string) => {
    const opt = match?.list.find((o) => String(o.expressCompanyId) === id) ?? null
    manualRef.current = true
    setOption(opt)
    setBlocked((b) => (opt ? null : b))
    const patch: Partial<GroupRuntime> = { option: opt }
    if (!opt) patch.pickTimeMs = null
    onRuntime(key, patch)
  }

  /** 比价结果中不在（优先 ∪ 黑名单）的公司：阻断时一键加入优先 */
  const unknownCompanies = React.useMemo(() => {
    if (!match) return [] as TemuLogisticsPrefItem[]
    const known = new Set([...priority, ...blacklist].map((p) => p.expressCompanyId))
    return match.list
      .filter((o) => o.expressCompanyId != null && !known.has(o.expressCompanyId) && o.expressCompanyName)
      .map((o) => ({ expressCompanyId: o.expressCompanyId!, expressCompanyName: o.expressCompanyName! }))
  }, [match, priority, blacklist])

  const missingAddress = !first?.receiveAddress
  const rank = option ? priority.findIndex((p) => p.expressCompanyId === option.expressCompanyId) : -1

  return (
    <WarehouseGroupCard
      name={group.name}
      alert={editable && (missingAddress || blocked !== null)}
      badge={
        active && phase === "running" ? (
          <Badge className="rounded-[4px] bg-sky-500/15 text-sky-700 dark:text-sky-400">处理中</Badge>
        ) : null
      }
      meta={`${rows.length} 单 · ${totalSkus} 件 · ${displayPkgs} 包`}
      header={
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="space-y-1">
              <Label className="text-[11px]">
                <span className="text-red-600">*</span> 重量（千克）
              </Label>
              <Input
                className="h-8 w-24 rounded-md text-xs tabular-nums"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                disabled={!editable || matching}
                value={weightKg}
                onChange={(e) => {
                  setWeightKg(e.target.value)
                  onRuntime(key, { weightKg: e.target.value })
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">体积（m³）</Label>
              <Input
                className="h-8 w-24 rounded-md text-xs tabular-nums"
                disabled={!editable || matching}
                value={volume}
                onChange={(e) => {
                  setVolume(e.target.value)
                  onRuntime(key, { volume: e.target.value })
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">
                <span className="text-red-600">*</span> 物流公司
              </Label>
              <Select
                items={(match?.list ?? []).map((o) => ({
                  value: String(o.expressCompanyId),
                  label: o.expressCompanyName ?? "—",
                }))}
                value={option ? String(option.expressCompanyId) : null}
                onValueChange={(v) => {
                  if (v) pickManual(v)
                }}
                disabled={!editable}
              >
                <SelectTrigger className="h-8 w-52 text-xs" aria-label="物流公司">
                  <SelectValue placeholder={match ? "手动指定物流公司" : "比价后可选"} />
                </SelectTrigger>
                <SelectContent>
                  {(match?.list ?? []).map((o) => {
                    const inBlack = blacklist.some((b) => b.expressCompanyId === o.expressCompanyId)
                    return (
                      <SelectItem
                        key={o.expressCompanyId}
                        value={String(o.expressCompanyId)}
                        disabled={inBlack}
                      >
                        {o.expressCompanyName ?? "—"}
                        {inBlack ? "（黑名单）" : ""}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="w-56 space-y-1">
              <Label className="text-[11px]">预约取货时间（默认今日/次日 18:00）</Label>
              <PickupTimePicker
                key={option?.expressCompanyId ?? "none"}
                slots={slots}
                disabled={!editable || !option}
                autoEarliest
                onChange={(ms) => onRuntime(key, { pickTimeMs: ms })}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={!editable || matching || addressId == null || missingAddress}
              onClick={() =>
                void runMatch(Math.max(1, Math.round(Number(weightKg) || 1)), volume)
              }
            >
              {matching ? <DashRing className="size-3.5" /> : <RefreshCw className="size-3.5" />} 重新比价
            </Button>
          </div>

          {matching && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <DashRing className="size-3.5" /> 重量/体积回填与比价中…
            </p>
          )}
          {missingAddress && (
            <p className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
              <TriangleAlert className="size-3.5" />
              发货单缺少收货地址信息，无法比价发货（可等同步后重试）
            </p>
          )}
          {!missingAddress && blocked === "no-priority" && (
            <div className="space-y-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              <p className="flex items-center gap-1.5">
                <TriangleAlert className="size-3.5" />
                比价结果中没有「优先顺序」内的公司，已阻断自动发货——请把公司加入优先顺序后保存，或在上方手动指定。
              </p>
              {unknownCompanies.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>未配置：</span>
                  {unknownCompanies.map((c) => (
                    <Button
                      key={c.expressCompanyId}
                      variant="outline"
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      disabled={!editable || prefFailed}
                      onClick={() => onAddPriority(c)}
                    >
                      <Plus className="size-3" /> {c.expressCompanyName} 加入优先
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={!editable || !prefDirty || prefFailed}
                    onClick={onSavePrefs}
                  >
                    保存偏好
                  </Button>
                </div>
              )}
            </div>
          )}
          {!missingAddress && blocked === "all-blacklisted" && (
            <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <Ban className="size-3.5" />
              比价结果全部在黑名单中，已阻断——请调整黑名单（下拉内黑名单公司不可选）
            </p>
          )}
          {!missingAddress && blocked === "empty" && (
            <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3.5" />
              本次比价无推荐物流结果（可调整重量/体积后重新比价）
            </p>
          )}
          {!missingAddress && !blocked && option && (
            <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <span>将使用</span>
              <span className="text-foreground">{option.expressCompanyName ?? "—"}</span>
              {rank >= 0 ? (
                <Badge className="rounded-[4px] bg-primary/10 text-primary">优先 {rank + 1}</Badge>
              ) : (
                <Badge className="rounded-[4px] bg-muted text-muted-foreground">手动指定</Badge>
              )}
              {option.courierTimeType === 1 && (
                <Badge className="rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  次日达
                </Badge>
              )}
              {(option.minSupplierChargeAmount != null || option.maxSupplierChargeAmount != null) && (
                <span>
                  · 预估承担 {option.minSupplierChargeAmount ?? "—"} ~ {option.maxSupplierChargeAmount ?? "—"} 元
                </span>
              )}
              {volFallback && <span>· 官方未返回体积，按 0.01 兜底</span>}
            </p>
          )}
        </div>
      }
    >
      <div className="overflow-x-auto border-t">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className={cn(GROUP_TH, "w-8")}>
                <span className="sr-only">状态</span>
              </th>
              <th className={GROUP_TH}>商品</th>
              <th className={GROUP_TH}>包裹</th>
              <th className={GROUP_TH}>装箱数</th>
              <th className={cn(GROUP_TH, "text-right")}>发货件数</th>
              <th className={GROUP_TH}>库存 → 扣减后</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const printed = r.isPrintBoxMark === true || lockedSns.has(r.deliveryOrderSn)
              const info = pkgInfo[r.deliveryOrderSn]
              const carton = cartonOf(r)
              const plan = printed ? null : planPackageTotals(r, carton)
              // undefined=库存参考未就绪；null=未建档（不参与库存联动）
              const st = invRef ? (stock.get(r.deliveryOrderSn) ?? null) : undefined
              const rs = rowStatus[r.deliveryOrderSn]
              const pkgTotal = effectivePackageCount(r, info?.length ?? null, carton)
              return (
                <tr
                  key={r.deliveryOrderSn}
                  className={cn(
                    rs?.status === "failed" && "bg-red-500/5",
                    active &&
                      (rs?.status === "printing" ||
                        rs?.status === "shipping" ||
                        rs?.status === "pending") &&
                      "bg-sky-500/5",
                  )}
                >
                  <td className={cn(GROUP_TD, "pr-0")}>
                    {phase !== "confirm" && <RowStatusIcon state={rs} />}
                  </td>
                  <td className={GROUP_TD}>
                    <div className="flex items-center gap-2.5">
                      {r.productImageUrl ? (
                        <ZoomableImage
                          src={r.productImageUrl}
                          alt={r.productName ?? ""}
                          className="size-10 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="size-10 shrink-0 rounded bg-muted" />
                      )}
                      <div className="min-w-0">
                        <TruncTip text={r.productName} className="max-w-44" />
                        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          {r.skcExtCode ? (
                            <Badge className="rounded-[4px] bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                              {r.skcExtCode}
                            </Badge>
                          ) : (
                            <EmptyHint />
                          )}
                          <span className="font-mono">{r.subPurchaseOrderSn ?? r.deliveryOrderSn}</span>
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className={GROUP_TD}>
                    {printed ? (
                      <div className="space-y-0.5">
                        <p className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {pkgTotal} 个包裹 · 已打印
                        </p>
                        {info && info.length > 0
                          ? info.map((p) => (
                              <p key={p.packageSn} className="whitespace-nowrap font-mono text-[11px]">
                                {p.packageSn} ·{" "}
                                {p.skcNum ?? p.packageDetails.reduce((a, d) => a + (d.skuNum ?? 0), 0)} 件
                              </p>
                            ))
                          : r.packageSns.map((sn) => (
                              <p key={sn} className="whitespace-nowrap font-mono text-[11px]">
                                {sn}
                              </p>
                            ))}
                      </div>
                    ) : plan ? (
                      <div className="space-y-1">
                        <p className="whitespace-nowrap text-[11px] text-muted-foreground">
                          预计 {plan.length} 包 · 待打印
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {plan.map((n, i) => (
                            <span
                              key={i}
                              className="rounded-[4px] border border-dashed px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground"
                            >
                              {n}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">
                        预计超 10 包（以官方打印锁定为准）
                      </span>
                    )}
                  </td>
                  <td className={cn(GROUP_TD, "whitespace-nowrap text-muted-foreground")}>
                    {carton != null && carton > 0 ? `${carton} 件/包` : "未建档（整单一包）"}
                  </td>
                  <td className={cn(GROUP_TD, "text-right tabular-nums")}>
                    {r.deliverSkcNum ?? <EmptyHint />}
                  </td>
                  <td className={cn(GROUP_TD, "whitespace-nowrap tabular-nums")}>
                    {st === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : st ? (
                      <span className={cn(st.short && invLinked && "text-red-600 dark:text-red-400")}>
                        {st.before} → {st.after}
                        {st.short && invLinked && <span className="ml-1">不足</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">未建档 · 不联动</span>
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
}

export { AutoShipGroupCard }
