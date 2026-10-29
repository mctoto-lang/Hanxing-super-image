"use client"

import * as React from "react"
import { toast } from "sonner"
import { CalendarIcon, Loader2, RefreshCw } from "lucide-react"
import { zhCN } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getLogisticsMatchAction,
  getMallAddressesAction,
  getShipBarcodePrintUrlAction,
  getShipBoxMarkPrintUrlAction,
  getShipPredictVolumeAction,
  packingMatchAction,
  sendPackingAction,
  validateShipExpressNoAction,
  type TemuShipOrderRow,
  type TemuShipPackingMatchResult,
} from "@/server/actions/temu-ship"

/**
 * 装箱发货（官方右侧抽屉样式，对齐卖家后台）：
 * - 打印门槛前移到列表入口（硬拦截）：未打印箱唛的单不允许装箱发货，
 *   须先「批量打印商品打包标签」（请求 dataKey 即按官方口径标记已打印）；
 * - 仅平台推荐物流（方式 2）：比价选公司 → 揽收方式/预约时段 → 确认发货；
 * - 预估重量/体积打开时静默回填（packing.match / predict.volume.get，可改），
 *   体积到位后自动比价（比价必填体积），根治「请填写发货总体积」报错。
 */

/** 行内/补打「打印标签」：同步先开空白标签页再回填链接（await 之后再 window.open 会被弹窗拦截） */
export async function openShipBoxMarkPrint(store: string, sns: string[]): Promise<void> {
  if (sns.length === 0) return
  const w = window.open("", "_blank")
  try {
    const r = await getShipBoxMarkPrintUrlAction({ store, deliveryOrderSns: sns })
    if (!r.ok) {
      w?.close()
      toast.error(r.error, { duration: 8000 })
      return
    }
    if (w) w.location.href = r.url
    else window.open(r.url, "_blank", "noopener")
    toast.success("已打开官方打印页（链接 10 分钟内单次有效）；打印后包裹与件数锁定", { duration: 8000 })
  } catch (e) {
    w?.close()
    toast.error(e instanceof Error ? e.message : "打印页获取失败", { duration: 8000 })
  }
}

/** 批量「打印商品打包标签」（只请求不打开打印页）：请求 dataKey 即按官方口径标记该批已打印 */
export async function requestShipBoxMark(store: string, sns: string[]): Promise<boolean> {
  if (sns.length === 0) return false
  const r = await getShipBoxMarkPrintUrlAction({ store, deliveryOrderSns: sns }).catch(() => null)
  if (!r || !r.ok) {
    toast.error(r && !r.ok ? r.error : "打印请求失败", { duration: 8000 })
    return false
  }
  toast.success(
    "打印请求已发送：该批发货单已按官方口径标记打印（包裹数与件数锁定）；实际打印可稍后在列表点「打印标签」重取链接（10 分钟内单次有效）",
    { duration: 10_000 },
  )
  return true
}

/** 「打印商品条码」（labelv2 按 SKC 取码）：与箱唛同款同步开窗模式，10min 单次有效 */
export async function openShipBarcodePrint(store: string, productSkcIds: number[]): Promise<void> {
  const ids = [...new Set(productSkcIds.filter((v) => v > 0))]
  if (ids.length === 0) {
    toast.error("所选单据缺少 SKC，无法打印商品条码")
    return
  }
  const w = window.open("", "_blank")
  try {
    const r = await getShipBarcodePrintUrlAction({ store, productSkcIds: ids })
    if (!r.ok) {
      w?.close()
      toast.error(r.error, { duration: 8000 })
      return
    }
    if (w) w.location.href = r.url
    else window.open(r.url, "_blank", "noopener")
  } catch (e) {
    w?.close()
    toast.error(e instanceof Error ? e.message : "打印页获取失败", { duration: 8000 })
  }
}

/* ─── 三方式配送信息（「更换物流」弹窗用；装箱发货抽屉已固定方式 2） ─── */

export type DeliverPayload =
  | { deliverMethod: 1; driverName: string; plateNumber: string; expressPackageNum: number }
  | {
      deliverMethod: 2
      expressCompanyId: number | null
      predictTotalPackageWeight: number
      expectPickUpGoodsTime?: number
      pickupMethod?: number
      predictId?: number
      expressPackageNum: number
      selfDeliverSitePhone?: string
      selfDeliverSiteAddress?: string
      selfDeliverSiteUserCode?: string
      selfDeliverSiteCompanyCode?: string
    }
  | {
      deliverMethod: 3
      expressCompanyId: number | null
      expressCompanyName: string
      expressDeliverySn: string
      expressPackageNum: number
    }

export function DeliverMethodTabs({
  store,
  value,
  onChange,
  thirdParty,
  scheduleOptions,
  disablePlatform,
  weightKg: weightKgProp,
  onWeightKgChange,
}: {
  store: string
  value: DeliverPayload
  onChange: (v: DeliverPayload) => void
  /** 自行委托三方的可用物流名单（logistics.get） */
  thirdParty: Array<{ expressCompanyId: number; expressCompanyName: string }>
  /** 平台推荐方式的可预约揽收时段（value = 原值透传） */
  scheduleOptions?: Array<{ label: string; value: number }>
  /** 预检判定不可用平台推荐时置灰 */
  disablePlatform?: boolean
  /** 受控预估总重量（千克字符串）；不传则内部维护（改物流弹窗用法） */
  weightKg?: string
  onWeightKgChange?: (v: string) => void
}) {
  const [innerWeightKg, setInnerWeightKg] = React.useState(
    String(Math.max(1, Math.round((value.deliverMethod === 2 ? value.predictTotalPackageWeight : 1000) / 1000))),
  )
  const weightKg = weightKgProp ?? innerWeightKg
  const setWeight = (v: string) => {
    if (onWeightKgChange) onWeightKgChange(v)
    else setInnerWeightKg(v)
  }
  const [pkgNum, setPkgNum] = React.useState(String(value.expressPackageNum))
  const method = value.deliverMethod

  // 外部回填（装箱弹窗静默取 SKU 总重）到达时同步输入框；用户自己输入时收敛为同值不闪烁
  const propWeight = value.deliverMethod === 2 ? value.predictTotalPackageWeight : 1000
  const lastSyncedWeight = React.useRef(propWeight)
  React.useEffect(() => {
    if (value.deliverMethod === 2 && propWeight !== lastSyncedWeight.current) {
      lastSyncedWeight.current = propWeight
      const next = String(Math.max(1, Math.round(propWeight / 1000)))
      if (onWeightKgChange) onWeightKgChange(next)
      else setInnerWeightKg(next)
    }
  }, [value.deliverMethod, propWeight, onWeightKgChange])

  const setPkg = (n: string) => {
    setPkgNum(n)
    const num = Math.max(1, Math.round(Number(n) || 1))
    onChange({ ...value, expressPackageNum: num } as DeliverPayload)
  }

  const tabs: Array<{ m: 1 | 2 | 3; label: string }> = [
    { m: 1, label: "自送" },
    { m: 2, label: "平台推荐物流" },
    { m: 3, label: "自行委托三方" },
  ]

  return (
    <div className="space-y-3">
      <div className="inline-flex h-8 items-center rounded-lg bg-muted p-1 text-muted-foreground">
        {tabs.map((t) => (
          <button
            key={t.m}
            type="button"
            disabled={t.m === 2 && disablePlatform}
            onClick={() => {
              if (t.m === 1) onChange({ deliverMethod: 1, driverName: "", plateNumber: "", expressPackageNum: Math.max(1, Math.round(Number(pkgNum) || 1)) })
              if (t.m === 2)
                onChange({
                  deliverMethod: 2,
                  expressCompanyId: null,
                  predictTotalPackageWeight: Math.max(1, Math.round(Number(weightKg) || 1)) * 1000,
                  expressPackageNum: Math.max(1, Math.round(Number(pkgNum) || 1)),
                  pickupMethod: 0,
                })
              if (t.m === 3) onChange({ deliverMethod: 3, expressCompanyId: null, expressCompanyName: "", expressDeliverySn: "", expressPackageNum: Math.max(1, Math.round(Number(pkgNum) || 1)) })
            }}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-all disabled:opacity-40 ${
              method === t.m ? "bg-background text-foreground shadow-sm" : "hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {method === 1 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">司机姓名</Label>
            <Input
              className="h-8 text-xs"
              value={value.driverName}
              onChange={(e) => onChange({ ...value, driverName: e.target.value })}
              placeholder="张三"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">车牌号</Label>
            <Input
              className="h-8 text-xs"
              value={value.plateNumber}
              onChange={(e) => onChange({ ...value, plateNumber: e.target.value })}
              placeholder="粤A12345"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">发货总箱数</Label>
            <Input className="h-8 text-xs" type="number" min={1} value={pkgNum} onChange={(e) => setPkg(e.target.value)} />
          </div>
        </div>
      )}

      {method === 2 && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">预估总重量（千克，整数）</Label>
              <Input
                className="h-8 text-xs"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={weightKg}
                onChange={(e) => {
                  setWeight(e.target.value)
                  const kg = Math.max(1, Math.round(Number(e.target.value) || 1))
                  onChange({ ...value, predictTotalPackageWeight: kg * 1000 } as DeliverPayload)
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">揽收方式</Label>
              <Select
                items={[
                  { value: "0", label: "上门揽收" },
                  { value: "1", label: "送至网点" },
                ]}
                value={String(value.pickupMethod ?? 0)}
                onValueChange={(v) => {
                  if (!v) return
                  onChange({ ...value, pickupMethod: Number(v) } as DeliverPayload)
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">上门揽收</SelectItem>
                  <SelectItem value="1">送至网点</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(scheduleOptions?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">预约揽收时段</Label>
                <Select
                  items={(scheduleOptions ?? []).map((s) => ({ value: String(s.value), label: s.label }))}
                  value={value.expectPickUpGoodsTime != null ? String(value.expectPickUpGoodsTime) : ""}
                  onValueChange={(v) => {
                    if (!v) return
                    onChange({ ...value, expectPickUpGoodsTime: Number(v) } as DeliverPayload)
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="不预约" />
                  </SelectTrigger>
                  <SelectContent>
                    {(scheduleOptions ?? []).map((s) => (
                      <SelectItem key={s.value} value={String(s.value)}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {value.pickupMethod === 1 && (
            <div className="grid grid-cols-2 gap-3 rounded-md border border-dashed p-3">
              <div className="space-y-1">
                <Label className="text-xs">自送网点电话 *</Label>
                <Input className="h-8 text-xs" value={value.selfDeliverSitePhone ?? ""} onChange={(e) => onChange({ ...value, selfDeliverSitePhone: e.target.value } as DeliverPayload)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">自送网点地址 *</Label>
                <Input className="h-8 text-xs" value={value.selfDeliverSiteAddress ?? ""} onChange={(e) => onChange({ ...value, selfDeliverSiteAddress: e.target.value } as DeliverPayload)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">网点用户编码 *</Label>
                <Input className="h-8 text-xs" value={value.selfDeliverSiteUserCode ?? ""} onChange={(e) => onChange({ ...value, selfDeliverSiteUserCode: e.target.value } as DeliverPayload)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">网点公司编码 *</Label>
                <Input className="h-8 text-xs" value={value.selfDeliverSiteCompanyCode ?? ""} onChange={(e) => onChange({ ...value, selfDeliverSiteCompanyCode: e.target.value } as DeliverPayload)} />
              </div>
            </div>
          )}
        </div>
      )}

      {method === 3 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">物流公司</Label>
            <Select
              items={thirdParty.map((t) => ({ value: String(t.expressCompanyId), label: t.expressCompanyName }))}
              value={value.expressCompanyId != null ? String(value.expressCompanyId) : ""}
              onValueChange={(v) => {
                if (!v) return
                const c = thirdParty.find((t) => String(t.expressCompanyId) === v)
                onChange({ ...value, expressCompanyId: Number(v), expressCompanyName: c?.expressCompanyName ?? "" } as DeliverPayload)
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="选择物流" />
              </SelectTrigger>
              <SelectContent>
                {thirdParty.map((t) => (
                  <SelectItem key={t.expressCompanyId} value={String(t.expressCompanyId)}>
                    {t.expressCompanyName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">物流单号</Label>
            <div className="flex gap-1.5">
              <Input className="h-8 text-xs" value={value.expressDeliverySn} onChange={(e) => onChange({ ...value, expressDeliverySn: e.target.value } as DeliverPayload)} placeholder="快递单号" />
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={!value.expressCompanyId || !value.expressDeliverySn}
                onClick={async () => {
                  const r = await validateShipExpressNoAction({
                    store,
                    shippingId: value.expressCompanyId!,
                    expressNo: value.expressDeliverySn,
                  }).catch(() => null)
                  if (!r || !r.ok) {
                    toast.error(r?.ok === false ? r.error : "校验失败", { duration: 6000 })
                    return
                  }
                  if (r.valid) toast.success("单号校验通过")
                  else toast.error(`单号不匹配：${r.message ?? "官方未返回原因"}`, { duration: 8000 })
                }}
              >
                校验
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">发货总箱数</Label>
            <Input className="h-8 text-xs" type="number" min={1} value={pkgNum} onChange={(e) => setPkg(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── 装箱发货（右侧抽屉，官方样式） ─── */

/** 官方装箱发货抽屉：仅平台推荐物流（方式 2）；入口已硬拦截未打印箱唛的单，
 *  重量/体积打开时静默回填（可改），体积到达后自动比价，选公司→揽收/时段→确认发货。 */
export function PackingDialog({
  store,
  rows,
  open,
  onOpenChange,
  onDone,
}: {
  store: string
  /** 待装箱发货单（同一收货仓、已打印箱唛；面板已拦截） */
  rows: TemuShipOrderRow[]
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 提交成功后回调（面板刷新列表） */
  onDone: () => void
}) {
  const [loading, startLoading] = React.useTransition()
  const [sending, startSending] = React.useTransition()
  const [weightKg, setWeightKg] = React.useState("")
  const [volume, setVolume] = React.useState("")
  const [matchInfo, setMatchInfo] = React.useState<TemuShipPackingMatchResult | null>(null)
  const [mallAddrs, setMallAddrs] = React.useState<Array<{ id: number; label: string; isDefault: boolean; fullText: string }>>([])
  const [addressId, setAddressId] = React.useState<number | null>(null)
  const [pkgNum, setPkgNum] = React.useState("")
  const [logistics, setLogistics] = React.useState<Awaited<ReturnType<typeof getLogisticsMatchAction>> | null>(null)
  const [selOption, setSelOption] = React.useState<Extract<Awaited<ReturnType<typeof getLogisticsMatchAction>>, { ok: true }>["list"][number] | null>(null)
  const [pickupMethod] = React.useState(0) // 官方口径仅上门揽收（pickupMethod=0）
  /** 预约取货时间：日期用日历（仅物流返回的可约日期），时/分下拉约束在可约窗口内 */
  const [pickDate, setPickDate] = React.useState<Date | null>(null)
  const [pickHour, setPickHour] = React.useState("")
  const [pickMin, setPickMin] = React.useState("")
  const [calOpen, setCalOpen] = React.useState(false)

  const sns = React.useMemo(() => rows.map((r) => r.deliveryOrderSn), [rows])
  /** 每单包裹数：官方行字段在待装箱阶段常为 0，以打印箱唛拆分出的包裹号为准 */
  const pkgCountOf = (r: TemuShipOrderRow) =>
    r.packageSns.length > 0 ? r.packageSns.length : (r.deliverPackageNum ?? 1)
  const totalPackages = rows.reduce((acc, r) => acc + pkgCountOf(r), 0)
  const totalSkus = rows.reduce((acc, r) => acc + (r.deliverSkcNum ?? 0), 0)
  const receive = rows[0]?.receiveAddress ?? null
  const selAddr = mallAddrs.find((a) => a.id === (addressId ?? rows[0]?.deliveryAddressId))

  /** 所选公司可约时段（官方对象 {bjDate,bjStartTime,bjEndTime}）→ 可选日期与窗口 */
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  const cnDate = (d: Date) =>
    `${d.getMonth() + 1}月${d.getDate()}日 周${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}`
  const slots = React.useMemo(
    () =>
      selOption && Array.isArray(selOption.channelScheduleTimeList)
        ? selOption.channelScheduleTimeList.flatMap((t) => {
            if (t && typeof t === "object" && typeof (t as { bjDate?: unknown }).bjDate === "string") {
              const s = t as { bjDate: string; bjStartTime?: unknown; bjEndTime?: unknown }
              const start = typeof s.bjStartTime === "string" ? s.bjStartTime : "00:00"
              const end = typeof s.bjEndTime === "string" ? s.bjEndTime : "23:59"
              const d = new Date(`${s.bjDate}T00:00`)
              if (!Number.isNaN(d.getTime())) return [{ date: d, bjDate: s.bjDate, start, end }]
            }
            return []
          })
        : [],
    [selOption],
  )
  const slotDates = React.useMemo(() => new Set(slots.map((s) => s.bjDate)), [slots])
  const pickSlot = pickDate ? slots.find((s) => s.bjDate === ymd(pickDate)) : null
  /** 小时约束在所选日期的可约窗口内（无窗口信息则全天） */
  const hourOptions = React.useMemo(() => {
    const all = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))
    if (!pickSlot) return all
    const from = Number(pickSlot.start.slice(0, 2))
    const to = Number(pickSlot.end.slice(0, 2))
    return all.filter((h) => Number(h) >= from && Number(h) <= to)
  }, [pickSlot])
  const minuteOptions = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"))
  const pickTimeMs =
    pickDate && pickHour && pickMin
      ? new Date(
          `${ymd(pickDate)}T${pickHour}:${pickMin}`,
        ).getTime()
      : null

  const fetchLogistics = (vol: string, kg: number, addrId: number | null, pkgCount?: number) => {
    const first = rows[0]
    if (!first?.receiveAddress) {
      toast.error("发货单缺少收货地址信息，无法比价（可等同步后重试）", { duration: 8000 })
      return
    }
    startLoading(async () => {
      const r = await getLogisticsMatchAction({
        store,
        deliveryOrderSns: sns,
        receiveAddressInfo: first.receiveAddress,
        deliveryAddressId: addrId ?? first.deliveryAddressId ?? 0,
        predictTotalPackageWeight: Math.max(1, kg) * 1000,
        subWarehouseId: first.subWarehouseId ?? 0,
        // effect 内的自动比价读到的 pkgNum 是旧渲染闭包（setPkgNum 尚未生效）→
        // 由调用方显式传本轮回填的包裹数；手动比价回落当前输入（空/非法按整批数）
        totalPackageNum: pkgCount ?? Math.max(1, Math.round(Number(pkgNum)) || totalPackages),
        predictVolume: vol.trim() || undefined,
      })
      if (r.ok) setLogistics(r)
      else toast.error(r.error, { duration: 8000 })
    })
  }

  // 打开（或换了一批单）时重置并静默回填：重量 packing.match + 体积 predict.volume.get；
  // 两项到位后自动比价（比价必填体积）；官方未返回体积时由用户手填后点「重新比价」
  React.useEffect(() => {
    if (!open || rows.length === 0) return
    setWeightKg("")
    setVolume("")
    setMatchInfo(null)
    setLogistics(null)
    setSelOption(null)
    setPickDate(null)
    setPickHour("")
    setPickMin("")
    setCalOpen(false)
    setPkgNum(String(Math.max(1, totalPackages)))
    setAddressId(rows[0]?.deliveryAddressId ?? null)
    let cancelled = false
    const snsNow = rows.map((r) => r.deliveryOrderSn)
    getMallAddressesAction(store).then((r) => {
      if (!cancelled && r.ok) setMallAddrs(r.rows)
    })
    Promise.all([
      packingMatchAction({ store, deliveryOrderSns: snsNow }).catch(() => null),
      getShipPredictVolumeAction({ store, deliveryOrderSns: snsNow }).catch(() => null),
    ]).then(([m, v]) => {
      if (cancelled) return
      let kg = 1
      if (m && m.ok) {
        setMatchInfo(m)
        if (m.skuSumWeight != null) {
          kg = Math.max(1, Math.ceil(m.skuSumWeight / 1000))
          setWeightKg(String(kg))
        }
      }
      if (v && v.ok && v.predictVolume) {
        setVolume(v.predictVolume)
        fetchLogistics(
          v.predictVolume,
          kg,
          rows[0]?.deliveryAddressId ?? null,
          Math.max(1, totalPackages),
        )
      } else {
        toast.info("官方体积接口对部分单不返回预估值（官方文档：部分场景为空），可手填后点「重新比价」", { duration: 8000 })
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, store])

  const submitPacking = () => {
    const kg = Math.max(1, Math.round(Number(weightKg) || 1))
    if (selOption?.expressCompanyId == null) {
      toast.error("请先比价并选择一个物流公司")
      return
    }
    startSending(async () => {
      const r = await sendPackingAction({
        store,
        deliveryOrderSns: sns,
        deliveryAddressId: addressId ?? rows[0]?.deliveryAddressId ?? 0,
        predictPackageVolume: volume.trim() || undefined,
        payload: {
          deliverMethod: 2,
          expressCompanyId: selOption.expressCompanyId,
          predictTotalPackageWeight: kg * 1000,
          expectPickUpGoodsTime: pickTimeMs ?? undefined,
          pickupMethod,
          predictId: selOption.predictId ?? undefined,
          expressPackageNum: Math.max(1, Math.round(Number(pkgNum) || 1)),
        } as never,
      })
      if (!r.ok) {
        toast.error(r.error, { duration: 8000 })
        return
      }
      if (r.warning) toast.warning(r.warning, { duration: 10_000 })
      toast.success(
        `装箱发货成功${r.expressBatchSn ? `，发货批次 ${r.expressBatchSn}` : ""}；运单标签与商品条码可在列表补打`,
        { duration: 10_000 },
      )
      onDone()
      onOpenChange(false)
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 官方抽屉宽约 40% 视口；基础类 sm:max-w-sm 需带前缀覆盖 */}
      <SheetContent side="right" className="flex h-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">装箱发货</SheetTitle>
          <SheetDescription className="text-xs">
            官方 packing.send · 平台推荐物流：{sns.length} 单（同一收货仓、已打印打包标签），成功后生成发货批次并转入「待仓库收货」。
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 scrollbar-hide">
          {/* 收货信息（官方蓝竖条样式） */}
          <section className="space-y-1 border-l-2 border-sky-500 pl-3 text-xs">
            <p className="text-sm font-medium">收货信息</p>
            {receive ? (
              <>
                <p>
                  收货人：{receive.receiverName || "—"}
                  {receive.phone ? ` · ${receive.phone}` : ""}
                </p>
                <p className="text-muted-foreground">
                  收货地址：
                  {[receive.provinceName, receive.cityName, receive.districtName, receive.detailAddress]
                    .filter(Boolean)
                    .join("")}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">收货地址信息待同步</p>
            )}
          </section>

          {/* 发货信息表单 */}
          <section className="space-y-3">
            <p className="text-sm font-medium">发货信息</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">
                  <span className="text-red-600">*</span> 预估总重量（千克）
                </Label>
                <Input
                  className="h-8 text-xs tabular-nums"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={weightKg}
                  onChange={(e) => setWeightKg(e.target.value)}
                  placeholder="系统预估自动回填"
                />
                <p className="text-[11px] text-muted-foreground">系统预估可修正，须为整数千克</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">预估总体积（m³）</Label>
                <Input
                  className="h-8 text-xs tabular-nums"
                  value={volume}
                  onChange={(e) => setVolume(e.target.value)}
                  placeholder="官方预估自动回填"
                />
                <p className="text-[11px] text-muted-foreground">官方预估自动回填、可修正；比价与提交自动携带</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  <span className="text-red-600">*</span> 发货总箱/包数
                </Label>
                <Input
                  className="h-8 text-xs tabular-nums"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={pkgNum}
                  onChange={(e) => setPkgNum(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">填写交接给快递公司的预估箱数</p>
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
                    // 仓库变化影响比价口径，清空已选公司
                    setSelOption(null)
                    setLogistics(null)
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={mallAddrs.length === 0 ? "地址加载中…" : "选择发货仓库"} />
                  </SelectTrigger>
                  {/* 弹层默认锁触发器宽（w-(--anchor-width)），地址长会被截断——放宽 + 悬浮全文 */}
                  <SelectContent className="w-auto min-w-72 max-w-[26rem]">
                    {mallAddrs.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)} title={`${a.label}（${a.fullText}）`}>
                        {a.label}（{a.fullText}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{selAddr ? `发货地址：${selAddr.fullText}` : " "}</p>
              </div>
            </div>

            {matchInfo && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
                {matchInfo.skuSumWeight != null && <span>SKU 总重 {matchInfo.skuSumWeight} 克（已按整千克预填）</span>}
                {matchInfo.ableUsePlatformExpress === false && (
                  <span className="text-orange-600 dark:text-orange-400">官方预检：平台推荐物流不可用</span>
                )}
                {matchInfo.shouldAdd.length > 0 && (
                  <span className="text-sky-600 dark:text-sky-400">
                    官方建议同地址合并发货：{matchInfo.shouldAdd.map((s) => s.deliveryOrderSn).join("、")}
                  </span>
                )}
              </div>
            )}

            {/* 物流公司比价（体积到位后自动拉取） */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">
                  <span className="mr-0.5 text-red-600">*</span> 物流公司（平台推荐）
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => fetchLogistics(volume, Math.max(1, Math.round(Number(weightKg) || 1)), addressId)}
                  disabled={loading || rows.length === 0}
                >
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} 重新比价
                </Button>
              </div>
              {logistics?.ok && (
                <div className="space-y-1.5">
                  {logistics.mostUsed && (
                    <p className="text-[11px] text-muted-foreground">
                      常用物流：{logistics.mostUsed.expressCompanyName ?? "—"}
                      {logistics.mostUsed.canSaveChargeAmount ? `（选其他可省约 ${logistics.mostUsed.canSaveChargeAmount} 元）` : ""}
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">价格特权{logistics.usePricePrivileges ? "已启用" : "未启用"}</p>
                  {logistics.list.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">无推荐结果（可调整重量/体积后重新比价）</p>
                  )}
                  {logistics.list.map((opt) => (
                    <button
                      key={opt.expressCompanyId}
                      type="button"
                      onClick={() => {
                        setSelOption(opt)
                        // 换公司后可约日期/窗口变化，清掉已选时间
                        setPickDate(null)
                        setPickHour("")
                        setPickMin("")
                      }}
                      className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                        selOption?.expressCompanyId === opt.expressCompanyId ? "border-primary bg-primary/5" : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="text-xs font-medium">
                        {opt.expressCompanyName ?? "—"}
                        {opt.hasUsedThisLogistics && <Badge variant="secondary" className="ml-1.5 rounded-[4px]">用过</Badge>}
                        {opt.courierTimeType === 1 && <Badge className="ml-1.5 rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">次日达</Badge>}
                        {opt.courierTimeType === 2 && <Badge variant="secondary" className="ml-1.5 rounded-[4px]">隔日达</Badge>}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {opt.minSupplierChargeAmount != null || opt.maxSupplierChargeAmount != null
                          ? `预估承担 ${opt.minSupplierChargeAmount ?? "—"} ~ ${opt.maxSupplierChargeAmount ?? "—"} 元`
                          : "官方未返回报价"}
                        {opt.channelScheduleTimeList.length > 0 ? ` · ${opt.channelScheduleTimeList.length} 个可约时段` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!logistics && !loading && (
                <p className="text-[11px] text-muted-foreground">
                  {volume.trim() ? "点「重新比价」获取推荐物流" : "体积回填后自动比价；也可手填体积后点「重新比价」"}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">预约取货时间</Label>
              <Popover open={calOpen} onOpenChange={setCalOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-full justify-start text-xs font-normal"
                      disabled={!selOption}
                    />
                  }
                >
                  <CalendarIcon className="size-3.5" />
                  {pickDate ? cnDate(pickDate) : selOption ? "选择日期" : "先选物流公司"}
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    locale={zhCN}
                    mode="single"
                    selected={pickDate ?? undefined}
                    onSelect={(d) => {
                      setPickDate(d ?? null)
                      setPickHour("")
                      setPickMin("")
                      setCalOpen(false)
                    }}
                    disabled={(d) => !slotDates.has(ymd(d))}
                  />
                </PopoverContent>
              </Popover>
              <div className="grid grid-cols-2 gap-2">
                <Select
                  items={hourOptions.map((h) => ({ value: h, label: `${h} 时` }))}
                  value={pickHour}
                  onValueChange={(v) => {
                    if (v) setPickHour(v)
                  }}
                  disabled={!pickDate}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder="时" />
                  </SelectTrigger>
                  <SelectContent>
                    {hourOptions.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h} 时
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  items={minuteOptions.map((m) => ({ value: m, label: `${m} 分` }))}
                  value={pickMin}
                  onValueChange={(v) => {
                    if (v) setPickMin(v)
                  }}
                  disabled={!pickDate}
                >
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder="分" />
                  </SelectTrigger>
                  <SelectContent>
                    {minuteOptions.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m} 分
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
              号码保护：官方对收派双方启用虚拟号联系，隐私号码不影响揽收与派送。
            </p>
          </section>

          {/* 已选发货单（官方蓝色标题条） */}
          <section className="space-y-2">
            <div className="flex items-center justify-between rounded-md bg-sky-500/10 px-3 py-1.5">
              <p className="text-xs font-medium text-sky-700 dark:text-sky-400">已选发货单</p>
              <p className="text-[11px] text-muted-foreground">
                发货单总数 <span className="tabular-nums">{rows.length}</span> · 包裹{" "}
                <span className="tabular-nums">{totalPackages}</span> · 件数{" "}
                <span className="tabular-nums">{totalSkus}</span>
              </p>
            </div>
            <div className="divide-y rounded-md border">
              {rows.map((r, i) => (
                <div key={r.deliveryOrderSn} className="flex items-center gap-2.5 px-2.5 py-2">
                  <span className="w-4 text-center text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
                  {r.productImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.productImageUrl} alt="" className="size-9 shrink-0 rounded object-cover" loading="lazy" />
                  ) : (
                    <div className="size-9 shrink-0 rounded bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[11px]">{r.deliveryOrderSn}</p>
                    <p className="truncate text-[11px] text-muted-foreground" title={r.productName ?? undefined}>
                      {r.subPurchaseOrderSn ?? "—"} · {r.productName ?? "—"}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      SKC {r.productSkcId ?? "—"} · 货号 {r.skcExtCode ?? "—"}
                    </p>
                  </div>
                  <span className="text-xs tabular-nums">{r.deliverSkcNum ?? "—"} 件</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <SheetFooter className="gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={sending || loading || selOption?.expressCompanyId == null}
            onClick={submitPacking}
          >
            {sending ? "提交中…" : "确认发货"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
