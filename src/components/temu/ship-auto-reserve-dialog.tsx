"use client"

import * as React from "react"
import { DashRing } from "@/components/ui/dash-ring"
import { toast } from "sonner"
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
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

import {
  getLogisticsConfigAction,
  getLogisticsMatchAction,
  getMallAddressesAction,
  getShipPredictVolumeAction,
  packingMatchAction,
  sendPackingAction,
  updateLogisticsConfigAction,
  type TemuLogisticsPrefItem,
  type TemuShipOrderRow,
  type TemuShipPackingMatchResult,
} from "@/server/actions/temu-ship"
import { PickupTimePicker, parsePickupSlots } from "@/components/temu/pickup-time-picker"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { formatDateTime } from "@/lib/datetime"
import { chunkSns } from "./ship-packing"

/**
 * 自动预约发货弹窗（待装箱发货勾选后一键预约）：PackingDialog 的自动版——
 * - 重量/体积/箱数/发货仓库自动回填（体积官方未返回按 0.01 m³ 兜底）；
 * - 物流公司按企业级「优先顺序 + 黑名单」（temu_logistics_config，迁移 0093）自动选：
 *   比价结果剔除黑名单 → 取优先顺序中第一个本次可用的公司；全不可用回落平台常用；
 *   比价出现名单外公司（未配置）提示可一键补入优先/黑名单，配置可在弹窗内编辑保存；
 * - 预约取货时间：天/时/分手选（默认按 18 点规则预选：<17 点→今日 18:00，≥17 点→次日 18:00）；
 * - 库存联动开关：开=发货前硬校验+成功后扣减（默认）；关=skipInventory（不校验不扣减，
 *   区别于工厂直发——不回写直发标记）。
 */

type MatchOption = Extract<Awaited<ReturnType<typeof getLogisticsMatchAction>>, { ok: true }>["list"][number]

export function AutoReserveDialog({
  store,
  rows,
  onClose,
  onDone,
}: {
  store: string
  /** 待装箱发货单（同一收货仓、已打印箱唧；面板已拦截） */
  rows: TemuShipOrderRow[]
  onClose: () => void
  /** 提交成功后回调（面板刷新列表） */
  onDone: () => void
}) {
  const [loading, startLoading] = React.useTransition()
  const [sending, startSending] = React.useTransition()
  const [confirming, setConfirming] = React.useState(false)
  const [weightKg, setWeightKg] = React.useState("")
  const [volume, setVolume] = React.useState("")
  const [mallAddrs, setMallAddrs] = React.useState<Array<{ id: number; label: string; isDefault: boolean; fullText: string }>>([])
  const [addressId, setAddressId] = React.useState<number | null>(null)
  const [pkgNum, setPkgNum] = React.useState("")
  const [logistics, setLogistics] = React.useState<Awaited<ReturnType<typeof getLogisticsMatchAction>> | null>(null)
  const [selOption, setSelOption] = React.useState<MatchOption | null>(null)
  const [pickTimeMs, setPickTimeMs] = React.useState<number | null>(null)
  /** 库存联动（开=校验+扣减；关=skipInventory） */
  const [invLinked, setInvLinked] = React.useState(true)
  /** 企业级物流偏好（编辑区本地态，保存写库） */
  const [priority, setPriority] = React.useState<TemuLogisticsPrefItem[]>([])
  const [blacklist, setBlacklist] = React.useState<TemuLogisticsPrefItem[]>([])
  /** 偏好配置是否已就绪（就绪前不自动选公司，避免按空名单执行的竞态） */
  const [configLoaded, setConfigLoaded] = React.useState(false)
  const [prefOpen, setPrefOpen] = React.useState(false)
  const [savingPref, startSavingPref] = React.useTransition()

  const sns = rows.map((r) => r.deliveryOrderSn)
  const pkgCountOf = (r: TemuShipOrderRow) =>
    r.packageSns.length > 0 ? r.packageSns.length : (r.deliverPackageNum ?? 1)
  const totalPackages = rows.reduce((acc, r) => acc + pkgCountOf(r), 0)
  const totalSkus = rows.reduce((acc, r) => acc + (r.deliverSkcNum ?? 0), 0)
  const selAddr = mallAddrs.find((a) => a.id === (addressId ?? rows[0]?.deliveryAddressId))
  const slots = React.useMemo(() => parsePickupSlots(selOption?.channelScheduleTimeList), [selOption])

  const fetchLogistics = (vol: string, kg: number, addrId: number | null, pkgCount?: number) => {
    const first = rows[0]
    if (!first?.receiveAddress) {
      toast.error("发货单缺少收货地址信息，无法比价（可等同步后重试）", { duration: 8000 })
      return
    }
    startLoading(async () => {
      for (const batch of chunkSns(sns)) {
        const r = await getLogisticsMatchAction({
          store,
          deliveryOrderSns: batch,
          receiveAddressInfo: first.receiveAddress,
          deliveryAddressId: addrId ?? first.deliveryAddressId ?? 0,
          predictTotalPackageWeight: Math.max(1, kg) * 1000,
          subWarehouseId: first.subWarehouseId ?? 0,
          totalPackageNum: pkgCount ?? Math.max(1, Math.round(Number(pkgNum)) || totalPackages),
          predictVolume: vol.trim() || undefined,
        })
        if (r.ok) {
          setLogistics(r)
          return
        }
        toast.error(r.error, { duration: 8000 })
      }
    })
  }

  /** 比价结果到达（或名单变化）后按「优先顺序+黑名单」自动选公司 */
  const autoSelect = React.useCallback(
    (list: MatchOption[], pref: TemuLogisticsPrefItem[], black: TemuLogisticsPrefItem[], mostUsed: { expressCompanyId?: number | null } | null | undefined) => {
      if (list.length === 0) return
      const blackIds = new Set(black.map((b) => b.expressCompanyId))
      const candidates = list.filter((o) => o.expressCompanyId != null && !blackIds.has(o.expressCompanyId))
      if (candidates.length === 0) {
        toast.warning("比价结果全部在黑名单中，请调整黑名单或重新比价", { duration: 8000 })
        return
      }
      const pick = pref.map((p) => candidates.find((o) => o.expressCompanyId === p.expressCompanyId)).find(Boolean)
      if (pick) {
        setSelOption(pick)
        return
      }
      const used = mostUsed?.expressCompanyId != null
        ? candidates.find((o) => o.expressCompanyId === mostUsed.expressCompanyId)
        : undefined
      if (used) {
        setSelOption(used)
        toast.info("优先名单内公司本次比价均不可用，已回落平台常用物流", { duration: 8000 })
        return
      }
      setSelOption(candidates[0]!)
      toast.info("优先名单与平台常用均不可用，已选比价列表首个公司", { duration: 8000 })
    },
    [],
  )

  // 比价结果到达 → 自动选（仅当用户尚未手选或换公司后重选）
  const autoSelectedRef = React.useRef(false)
  React.useEffect(() => {
    if (!logistics?.ok || !configLoaded || autoSelectedRef.current) return
    autoSelectedRef.current = true
    autoSelect(logistics.list, priority, blacklist, logistics.mostUsed)
  }, [logistics, configLoaded, priority, blacklist, autoSelect])

  // 打开时：偏好配置 + 重量/体积回填（体积空→0.01 兜底）→ 自动比价；箱数/发货仓库预填
  React.useEffect(() => {
    let cancelled = false
    setPkgNum(String(Math.max(1, totalPackages)))
    setAddressId(rows[0]?.deliveryAddressId ?? null)
    getLogisticsConfigAction()
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          setPriority(r.priority)
          setBlacklist(r.blacklist)
        } else {
          toast.error("物流偏好配置加载失败，本次自动选公司将忽略优先顺序与黑名单", { duration: 8000 })
        }
        setConfigLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        toast.error("物流偏好配置加载失败，本次自动选公司将忽略优先顺序与黑名单", { duration: 8000 })
        setConfigLoaded(true)
      })
    getMallAddressesAction(store).then((r) => {
      if (!cancelled && r.ok) setMallAddrs(r.rows)
    })
    const batches = chunkSns(sns)
    Promise.all([
      (async (): Promise<TemuShipPackingMatchResult | null> => {
        let merged: TemuShipPackingMatchResult | null = null
        for (const b of batches) {
          const m = await packingMatchAction({ store, deliveryOrderSns: b }).catch(() => null)
          if (!m || !m.ok) continue
          if (!merged) {
            merged = { ...m }
            continue
          }
          merged.shouldAdd = [...merged.shouldAdd, ...m.shouldAdd]
          merged.deliveryOrderSnNotPrintBox = [
            ...merged.deliveryOrderSnNotPrintBox,
            ...m.deliveryOrderSnNotPrintBox,
          ]
          merged.skuSumWeight =
            merged.skuSumWeight == null || m.skuSumWeight == null
              ? null
              : merged.skuSumWeight + m.skuSumWeight
        }
        return merged
      })(),
      (async (): Promise<string | null> => {
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
        return missing || sum == null ? null : String(sum)
      })(),
    ]).then(([m, vol]) => {
      if (cancelled) return
      let kg = 1
      if (m?.skuSumWeight != null) {
        kg = Math.max(1, Math.ceil(m.skuSumWeight / 1000))
        setWeightKg(String(kg))
      }
      // 官方未返回体积 → 0.01 m³ 兜底（可手改）后照常自动比价
      const volFinal = vol ?? "0.01"
      setVolume(volFinal)
      if (!vol) {
        toast.info("官方未返回体积预估，已按 0.01 m³ 兜底，可手动修改后「重新比价」", { duration: 8000 })
      }
      fetchLogistics(volFinal, kg, rows[0]?.deliveryAddressId ?? null, Math.max(1, totalPackages))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 未配置公司 = 比价结果中不在（优先 ∪ 黑名单）的公司 */
  const unknownCompanies = React.useMemo(() => {
    if (!logistics?.ok) return [] as TemuLogisticsPrefItem[]
    const known = new Set(
      [...priority, ...blacklist].map((p) => p.expressCompanyId),
    )
    return logistics.list
      .filter((o) => o.expressCompanyId != null && !known.has(o.expressCompanyId) && o.expressCompanyName)
      .map((o) => ({ expressCompanyId: o.expressCompanyId!, expressCompanyName: o.expressCompanyName! }))
  }, [logistics, priority, blacklist])

  const savePrefs = () => {
    startSavingPref(async () => {
      const r = await updateLogisticsConfigAction({ priority, blacklist })
      if (r.ok) {
        setPriority(r.priority)
        setBlacklist(r.blacklist)
        setPrefDirty(false)
        toast.success("物流偏好已保存（企业级，全部设备生效）")
      } else toast.error(r.error)
    })
  }

  const runSend = () => {
    const opt = selOption
    if (!opt || opt.expressCompanyId == null || !opt.expressCompanyName) return
    const kg = Math.max(1, Math.round(Number(weightKg) || 1))
    startSending(async () => {
      let sent = 0
      const batchSns: string[] = []
      for (const batch of chunkSns(sns)) {
        const r = await sendPackingAction({
          store,
          deliveryOrderSns: batch,
          deliveryAddressId: addressId ?? rows[0]?.deliveryAddressId ?? 0,
          predictPackageVolume: volume.trim() || undefined,
          skipInventory: !invLinked || undefined,
          payload: {
            deliverMethod: 2,
            expressCompanyId: opt.expressCompanyId,
            expressCompanyName: opt.expressCompanyName,
            predictTotalPackageWeight: kg * 1000,
            expectPickUpGoodsTime: pickTimeMs ?? undefined,
            pickupMethod: 0,
            predictId: opt.predictId ?? undefined,
            expressPackageNum: Math.max(1, Math.round(Number(pkgNum) || 1)),
          } as never,
        })
        if (!r.ok) {
          toast.error(r.error, { duration: 8000 })
          continue
        }
        sent++
        if (r.warning) toast.warning(r.warning, { duration: 10_000 })
        if (r.expressBatchSn) batchSns.push(r.expressBatchSn)
      }
      if (sent === 0) return
      toast.success(
        `自动预约发货成功${batchSns.length > 0 ? `，发货批次 ${batchSns.join("、")}` : ""}；运单标签可在「待仓库收货」列表打印`,
        { duration: 10_000 },
      )
      onDone()
      onClose()
    })
  }

  /** 偏好编辑区有未保存修改（保存成功后复位） */
  const [prefDirty, setPrefDirty] = React.useState(false)
  const markDirty = <T,>(fn: React.Dispatch<React.SetStateAction<T>>) =>
    (v: React.SetStateAction<T>) => {
      setPrefDirty(true)
      fn(v)
    }
  const setPriorityDirty = markDirty(setPriority)
  const setBlacklistDirty = markDirty(setBlacklist)

  return (
    <Dialog
      open
      onOpenChange={(v, details) => {
        if (!v && (sending || loading)) {
          details.cancel()
          toast.warning(sending ? "发货执行中，请等待完成" : "比价执行中，请稍候")
          return
        }
        if (!v) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>自动预约发货（{rows.length} 单）</DialogTitle>
          <DialogDescription>
            重量/体积/箱数自动回填；物流公司按企业级优先顺序自动选择（黑名单剔除）；预约取货时间默认今日/次日 18:00（可改）；库存联动可关。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-hide">
          {/* 库存联动开关 */}
          <section className="flex items-center justify-between rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 text-xs">
            <div>
              <p className="text-sm font-medium">库存联动</p>
              <p className="text-muted-foreground">
                {invLinked
                  ? "发货前按库存硬校验，不足将阻断；成功后自动扣减并记「发货扣减」流水。"
                  : "已关闭：不校验也不扣减本地库存（账实差异人工处理；不标记工厂直发）。"}
              </p>
            </div>
            <Switch checked={invLinked} onCheckedChange={setInvLinked} aria-label="库存联动开关" />
          </section>

          {/* 发货信息 */}
          <section className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">
                <span className="text-red-600">*</span> 预估总重量（千克）
              </Label>
              <Input
                className="h-8 rounded-md text-xs tabular-nums"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                placeholder="系统预估自动回填"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">预估总体积（m³）</Label>
              <Input
                className="h-8 rounded-md text-xs tabular-nums"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                placeholder="官方预估自动回填（空按 0.01 兜底）"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                <span className="text-red-600">*</span> 发货总箱/包数
              </Label>
              <Input
                className="h-8 rounded-md text-xs tabular-nums"
                type="number"
                inputMode="numeric"
                min={1}
                value={pkgNum}
                onChange={(e) => setPkgNum(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                预填 {totalPackages}（各单包裹数合计，可改）
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                <span className="text-red-600">*</span> 发货仓库
              </Label>
              <Select
                items={mallAddrs.map((a) => ({ value: String(a.id), label: a.label }))}
                value={String(addressId ?? rows[0]?.deliveryAddressId ?? "")}
                onValueChange={(v) => {
                  if (!v) return
                  setAddressId(Number(v))
                  setSelOption(null)
                  setLogistics(null)
                  autoSelectedRef.current = false
                }}
              >
                <SelectTrigger className="h-8 text-xs">
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
            </div>
          </section>

          {/* 物流公司（自动选 + 可手改 + 未配置提示） */}
          <section className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">
                <span className="mr-0.5 text-red-600">*</span> 物流公司（按优先顺序自动选择）
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={loading || rows.length === 0}
                onClick={() => {
                  autoSelectedRef.current = false
                  fetchLogistics(volume, Math.max(1, Math.round(Number(weightKg) || 1)), addressId)
                }}
              >
                {loading ? <DashRing className="size-3.5" /> : <RefreshCw className="size-3.5" />} 重新比价
              </Button>
            </div>

            {unknownCompanies.length > 0 && (
              <div className="space-y-1 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                <p>出现未配置的物流公司：{unknownCompanies.map((c) => c.expressCompanyName).join("、")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {unknownCompanies.map((c) => (
                    <span key={c.expressCompanyId} className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-1.5 text-[10px]"
                        onClick={() => setPriorityDirty((s) => [...s, c])}
                      >
                        <Plus className="size-3" /> {c.expressCompanyName} 加入优先
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-1.5 text-[10px]"
                        onClick={() => setBlacklistDirty((s) => [...s, c])}
                      >
                        <Ban className="size-3" /> 拉黑
                      </Button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {logistics?.ok && (
              <div className="space-y-1.5">
                {logistics.mostUsed && (
                  <p className="text-[11px] text-muted-foreground">
                    常用物流：{logistics.mostUsed.expressCompanyName ?? "—"}
                    {logistics.mostUsed.canSaveChargeAmount
                      ? `（选其他可省约 ${logistics.mostUsed.canSaveChargeAmount} 元）`
                      : ""}
                  </p>
                )}
                {logistics.list.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">无推荐结果（可调整重量/体积后重新比价）</p>
                )}
                {logistics.list.map((opt) => {
                  const inBlack = blacklist.some((b) => b.expressCompanyId === opt.expressCompanyId)
                  const rank = priority.findIndex((p) => p.expressCompanyId === opt.expressCompanyId)
                  return (
                    <button
                      key={opt.expressCompanyId}
                      type="button"
                      disabled={inBlack}
                      onClick={() => setSelOption(opt)}
                      className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                        selOption?.expressCompanyId === opt.expressCompanyId
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="text-xs font-medium">
                        {opt.expressCompanyName ?? "—"}
                        {rank >= 0 && (
                          <Badge className="ml-1.5 rounded-[4px] bg-primary/10 text-primary">优先 {rank + 1}</Badge>
                        )}
                        {inBlack && (
                          <Badge className="ml-1.5 rounded-[4px] bg-red-500/15 text-red-700 dark:text-red-400">黑名单</Badge>
                        )}
                        {opt.hasUsedThisLogistics && (
                          <Badge className="ml-1.5 rounded-[4px] bg-blue-500/15 text-blue-700 dark:text-blue-400">用过</Badge>
                        )}
                        {opt.courierTimeType === 1 && (
                          <Badge className="ml-1.5 rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">次日达</Badge>
                        )}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {opt.minSupplierChargeAmount != null || opt.maxSupplierChargeAmount != null
                          ? `预估承担 ${opt.minSupplierChargeAmount ?? "—"} ~ ${opt.maxSupplierChargeAmount ?? "—"} 元`
                          : "官方未返回报价"}
                        {opt.channelScheduleTimeList.length > 0 ? ` · ${opt.channelScheduleTimeList.length} 个可约时段` : ""}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {!logistics && !loading && (
              <p className="text-[11px] text-muted-foreground">体积回填后自动比价；也可调整后点「重新比价」</p>
            )}
          </section>

          {/* 优先顺序 / 黑名单（企业级，可折叠编辑） */}
          <section className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium"
              onClick={() => setPrefOpen((v) => !v)}
            >
              <span>
                物流偏好（优先 {priority.length} · 黑名单 {blacklist.length}）
                {prefDirty && <span className="ml-1 text-amber-600 dark:text-amber-400">有未保存修改</span>}
              </span>
              {prefOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
            {prefOpen && (
              <div className="space-y-3 border-t px-3 py-2.5 text-xs">
                <div className="space-y-1">
                  <p className="text-muted-foreground">优先顺序（自动选择按此顺序取第一个可用公司）</p>
                  {priority.length === 0 && <p className="text-[11px] text-muted-foreground">暂无——比价出现公司时可点「加入优先」</p>}
                  {priority.map((p, i) => (
                    <div key={p.expressCompanyId} className="flex items-center gap-1.5">
                      <span className="w-5 text-center text-muted-foreground tabular-nums">{i + 1}</span>
                      <span className="flex-1">{p.expressCompanyName}</span>
                      <Button variant="ghost" size="sm" className="size-6 p-0" disabled={i === 0}
                        onClick={() =>
                          setPriorityDirty((s) => {
                            const n = [...s]
                            ;[n[i - 1], n[i]] = [n[i]!, n[i - 1]!]
                            return n
                          })
                        }>
                        <ArrowUp className="size-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="size-6 p-0" disabled={i === priority.length - 1}
                        onClick={() =>
                          setPriorityDirty((s) => {
                            const n = [...s]
                            ;[n[i + 1], n[i]] = [n[i]!, n[i + 1]!]
                            return n
                          })
                        }>
                        <ArrowDown className="size-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" onClick={() => {
                        setPriorityDirty((s) => s.filter((x) => x.expressCompanyId !== p.expressCompanyId))
                        setBlacklistDirty((s) => [...s.filter((x) => x.expressCompanyId !== p.expressCompanyId), p])
                      }}>
                        拉黑
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]"
                        onClick={() => setPriorityDirty((s) => s.filter((x) => x.expressCompanyId !== p.expressCompanyId))}>
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">黑名单（比价结果中剔除，不自动选择）</p>
                  {blacklist.length === 0 && <p className="text-[11px] text-muted-foreground">暂无</p>}
                  {blacklist.map((p) => (
                    <div key={p.expressCompanyId} className="flex items-center gap-1.5">
                      <Ban className="size-3 text-red-600 dark:text-red-400" />
                      <span className="flex-1">{p.expressCompanyName}</span>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]"
                        onClick={() => {
                          setBlacklistDirty((s) => s.filter((x) => x.expressCompanyId !== p.expressCompanyId))
                          setPriorityDirty((s) => [...s.filter((x) => x.expressCompanyId !== p.expressCompanyId), p])
                        }}>
                        恢复优先
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]"
                        onClick={() => setBlacklistDirty((s) => s.filter((x) => x.expressCompanyId !== p.expressCompanyId))}>
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button size="sm" className="h-7 text-xs" disabled={savingPref} onClick={savePrefs}>
                    {savingPref ? <DashRing className="size-3.5" /> : null} 保存偏好（企业级）
                  </Button>
                </div>
              </div>
            )}
          </section>

          {/* 预约取货时间 */}
          <section className="space-y-1.5">
            <Label className="text-xs">预约取货时间（默认今日/次日 18:00）</Label>
            <PickupTimePicker
              key={selOption?.expressCompanyId ?? "none"}
              slots={slots}
              disabled={!selOption}
              autoEarliest
              onChange={setPickTimeMs}
            />
          </section>

          <p className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
            {rows.length} 单 · {totalSkus} 件 · 预填 {totalPackages} 包 · 收货仓 {rows[0]?.subWarehouseName ?? "—"}
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={loading || sending}>
            关闭
          </Button>
          <Button
            size="sm"
            disabled={
              sending ||
              loading ||
              selOption?.expressCompanyId == null ||
              !selOption?.expressCompanyName
            }
            onClick={() => setConfirming(true)}
          >
            {sending ? "提交中…" : <><Zap className="size-3.5" /> 自动预约发货</>}
          </Button>
        </DialogFooter>
      </DialogContent>

      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setConfirming(false)}
          title="确认自动预约发货"
          description={`将对 ${rows.length} 单执行装箱发货：物流 ${selOption?.expressCompanyName ?? "—"}、${Math.max(1, Math.round(Number(pkgNum) || 1))} 包、发货仓库 ${selAddr?.label ?? "—"}、预约取货 ${pickTimeMs ? formatDateTime(pickTimeMs) : "不预约"}、库存联动${invLinked ? "开（校验并扣减）" : "关"}。官方 packing.send 成功后即生成发货批次，不可撤销。`}
          confirmText="开始发货"
          pending={sending}
          onConfirm={() => {
            setConfirming(false)
            runSend()
          }}
        />
      )}
    </Dialog>
  )
}
