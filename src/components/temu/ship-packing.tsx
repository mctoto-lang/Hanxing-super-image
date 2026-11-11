"use client"

import * as React from "react"
import { toast } from "sonner"
import { Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { PickupTimePicker, parsePickupSlots } from "@/components/temu/pickup-time-picker"
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
import { TruncTip } from "@/components/temu/trunc-tip"

/**
 * 装箱发货（官方右侧抽屉样式，对齐卖家后台）：
 * - 打印门槛前移到列表入口（硬拦截）：未打印箱唛的单不允许装箱发货，
 *   须先「批量打印商品打包标签」（请求 dataKey 即按官方口径标记已打印）；
 * - 仅平台推荐物流（方式 2）：比价选公司 → 揽收方式/预约时段 → 确认发货；
 * - 预估重量/体积打开时静默回填（packing.match / predict.volume.get，可改），
 *   体积到位后自动比价（比价必填体积），根治「请填写发货总体积」报错。
 */

/** 「打印商品打包标签」（只请求不打开打印页）：请求 dataKey 即按官方口径标记该批已打印
 *  （包裹数与件数锁定）。行内/批量入口统一先过列表的两步确认弹窗（图2 继续打印 /
 *  图3 先发货后打印）再调本函数。 */
export async function requestShipBoxMark(store: string, sns: string[]): Promise<boolean> {
  if (sns.length === 0) return false
  const r = await getShipBoxMarkPrintUrlAction({ store, deliveryOrderSns: sns }).catch(() => null)
  if (!r || !r.ok) {
    toast.error(r && !r.ok ? r.error : "打印请求失败", { duration: 8000 })
    return false
  }
  toast.success(
    "打印请求已发送：该批发货单已按官方口径标记打印（包裹数与件数锁定）",
    { duration: 10_000 },
  )
  return true
}

/** 「打印商品打包标签」补打（开官方打印页直出）：待仓库收货场景——件数已锁定，
 *  直接开打印页；deliveryOrderSnList 传多单时官方一个 dataKey 页含全部箱唧
 *  （组级=同批次多单，行级=单单补打）。与首打的 requestShipBoxMark（仅请求锁定）区分。 */
export async function openShipBoxMarkPage(store: string, sns: string[]): Promise<void> {
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
    toast.success(
      sns.length > 1
        ? `已打开官方打印页（${sns.length} 单打包标签合并一页；链接 10 分钟内单次有效）`
        : "已打开官方打印页（链接 10 分钟内单次有效）",
      { duration: 8000 },
    )
  } catch (e) {
    w?.close()
    toast.error(e instanceof Error ? e.message : "打印页获取失败", { duration: 8000 })
  }
}

/** 「打印商品条码」：按发货单 SKU 维度提交（labelv2 按供应商主体隔离，货号会打出别家
 *  条码；SKU id 是主体内精确键，服务端自动路由同企业已授权店铺 token），与箱唛同款
 *  同步开窗模式，10min 单次有效；跨主体批次会返回多个打印页（按主体分组各一页） */
export async function openShipBarcodePrint(store: string, skuIds: Array<number | null | undefined>): Promise<void> {
  const ids = [...new Set(skuIds.filter((v): v is number => v != null && v > 0))]
  if (ids.length === 0) {
    toast.error("所选单据缺少 SKU 明细，无法打印商品条码")
    return
  }
  const w = window.open("", "_blank")
  try {
    const r = await getShipBarcodePrintUrlAction({ store, productSkuIds: ids })
    if (!r.ok) {
      w?.close()
      toast.error(r.error, { duration: 8000 })
      return
    }
    const [first, ...rest] = r.urls
    if (w) w.location.href = first
    else window.open(first, "_blank", "noopener")
    for (const u of rest) window.open(u, "_blank", "noopener")
    if (r.urls.length > 1) {
      toast.success(`已打开 ${r.urls.length} 个官方打印页（发货单跨供应商主体，按主体分组；链接 10 分钟内单次有效）`, { duration: 10_000 })
    }
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
      /** 快递公司名称：官方方式2必填（2000000 实证），取自 logisticsmatch 推荐条目 */
      expressCompanyName: string
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
                  expressCompanyName: "",
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
            <Input className="h-8 rounded-md text-xs" type="number" min={1} value={pkgNum} onChange={(e) => setPkg(e.target.value)} />
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
            <Input className="h-8 rounded-md text-xs" type="number" min={1} value={pkgNum} onChange={(e) => setPkg(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── 装箱发货（右侧抽屉，官方样式） ─── */

/** schema deliveryOrderSns 单次上限 50：装箱链路（预检/体积/比价/发货）按 ≤50 一组循环分批
 *  （装箱抽屉与自动预约发货弹窗共用） */
export function chunkSns(sns: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < sns.length; i += 50) out.push(sns.slice(i, i + 50))
  return out
}

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
  /** 预约取货时间（epoch 毫秒；null=不预约）——选择器内部状态，换公司 key 重置 */
  const [pickTimeMs, setPickTimeMs] = React.useState<number | null>(null)
  /** 库存联动（批次4）：单仓制固定主仓 + 工厂直发（跳过校验不扣库存） */
  const [factoryDirect, setFactoryDirect] = React.useState(false)

  const sns = React.useMemo(() => rows.map((r) => r.deliveryOrderSn), [rows])
  /** 每单包裹数：官方行字段在待装箱阶段常为 0，以打印箱唛拆分出的包裹号为准 */
  const pkgCountOf = (r: TemuShipOrderRow) =>
    r.packageSns.length > 0 ? r.packageSns.length : (r.deliverPackageNum ?? 1)
  const totalPackages = rows.reduce((acc, r) => acc + pkgCountOf(r), 0)
  const totalSkus = rows.reduce((acc, r) => acc + (r.deliverSkcNum ?? 0), 0)
  const receive = rows[0]?.receiveAddress ?? null
  const selAddr = mallAddrs.find((a) => a.id === (addressId ?? rows[0]?.deliveryAddressId))
  /** 所选公司可约时段（官方对象数组 → 槽位；选择器共用组件解析） */
  const slots = React.useMemo(() => parsePickupSlots(selOption?.channelScheduleTimeList), [selOption])

  const fetchLogistics = (vol: string, kg: number, addrId: number | null, pkgCount?: number) => {
    const first = rows[0]
    if (!first?.receiveAddress) {
      toast.error("发货单缺少收货地址信息，无法比价（可等同步后重试）", { duration: 8000 })
      return
    }
    startLoading(async () => {
      // schema deliveryOrderSns 单次上限 50：分批比价（报价取决于总量——重量/体积/箱数，
      // 各批结果一致，取首个成功批；单批失败 toast 该批错误并继续其余批）
      for (const batch of chunkSns(sns)) {
        const r = await getLogisticsMatchAction({
          store,
          deliveryOrderSns: batch,
          receiveAddressInfo: first.receiveAddress,
          deliveryAddressId: addrId ?? first.deliveryAddressId ?? 0,
          predictTotalPackageWeight: Math.max(1, kg) * 1000,
          subWarehouseId: first.subWarehouseId ?? 0,
          // effect 内的自动比价读到的 pkgNum 是旧渲染闭包（setPkgNum 尚未生效）→
          // 由调用方显式传本轮回填的包裹数；手动比价回落当前输入（空/非法按整批数）
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

  // 打开（或换了一批单）时重置并静默回填：重量 packing.match + 体积 predict.volume.get；
  // 两项到位后自动比价（比价必填体积）；官方未返回体积时由用户手填后点「重新比价」
  React.useEffect(() => {
    if (!open || rows.length === 0) return
    setWeightKg("")
    setVolume("")
    setMatchInfo(null)
    setLogistics(null)
    setSelOption(null)
    setPickTimeMs(null)
    setPkgNum(String(Math.max(1, totalPackages)))
    setAddressId(rows[0]?.deliveryAddressId ?? null)
    let cancelled = false
    const batches = chunkSns(rows.map((r) => r.deliveryOrderSn))
    setFactoryDirect(false)
    getMallAddressesAction(store).then((r) => {
      if (!cancelled && r.ok) setMallAddrs(r.rows)
    })
    // schema deliveryOrderSns 单次上限 50：预检/体积分批调用后合并（重量、体积求和，
    // 建议合并发货拼接；单批失败 toast 该批错误并继续其余批，成功批结果照常回填）
    Promise.all([
      (async (): Promise<TemuShipPackingMatchResult | null> => {
        let merged: TemuShipPackingMatchResult | null = null
        for (const b of batches) {
          const m = await packingMatchAction({ store, deliveryOrderSns: b }).catch(() => null)
          if (!m || !m.ok) {
            if (!cancelled) toast.error(m && !m.ok ? m.error : "装箱预检请求失败", { duration: 8000 })
            continue
          }
          if (!merged) {
            merged = { ...m }
            continue
          }
          merged.shouldAdd = [...merged.shouldAdd, ...m.shouldAdd]
          merged.deliveryOrderSnNotPrintBox = [
            ...merged.deliveryOrderSnNotPrintBox,
            ...m.deliveryOrderSnNotPrintBox,
          ]
          // 任一批官方未返回重量则整体视为未知（避免求和漏计导致预填低估）
          merged.skuSumWeight =
            merged.skuSumWeight == null || m.skuSumWeight == null
              ? null
              : merged.skuSumWeight + m.skuSumWeight
          merged.ableUsePlatformExpress =
            merged.ableUsePlatformExpress === false || m.ableUsePlatformExpress === false
              ? false
              : (merged.ableUsePlatformExpress ?? m.ableUsePlatformExpress)
        }
        return merged
      })(),
      (async (): Promise<string | null> => {
        let sum: number | null = null
        let missing = false
        for (const b of batches) {
          const v = await getShipPredictVolumeAction({ store, deliveryOrderSns: b }).catch(() => null)
          if (!v || !v.ok) {
            if (!cancelled) toast.error(v && !v.ok ? v.error : "体积预估请求失败", { duration: 8000 })
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
      if (m) {
        setMatchInfo(m)
        if (m.skuSumWeight != null) {
          kg = Math.max(1, Math.ceil(m.skuSumWeight / 1000))
          setWeightKg(String(kg))
        }
      }
      // 官方未返回体积（官方文档：部分场景为空）→ 按 0.01 m³ 兜底预填（可手改）并继续自动比价
      const volFinal = vol ?? "0.01"
      setVolume(volFinal)
      fetchLogistics(
        volFinal,
        kg,
        rows[0]?.deliveryAddressId ?? null,
        Math.max(1, totalPackages),
      )
      if (!vol) {
        toast.info("官方未返回体积预估，已按 0.01 m³ 兜底，可手动修改后「重新比价」", { duration: 8000 })
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, store])

  const submitPacking = () => {
    if (selOption?.expressCompanyId == null || !selOption?.expressCompanyName) {
      toast.error("请先比价并选择一个物流公司")
      return
    }
    doSend()
  }

  const doSend = () => {
    const opt = selOption
    if (!opt || opt.expressCompanyId == null || !opt.expressCompanyName) return
    const kg = Math.max(1, Math.round(Number(weightKg) || 1))
    startSending(async () => {
      // schema deliveryOrderSns 单次上限 50：分批装箱发货（每批一个官方发货批次；重量/体积/箱数
      // 为整批口径的预估）；单批失败 toast 该批错误并继续其余批
      let sent = 0
      const batchSns: string[] = []
      for (const batch of chunkSns(sns)) {
        const r = await sendPackingAction({
          store,
          deliveryOrderSns: batch,
          deliveryAddressId: addressId ?? rows[0]?.deliveryAddressId ?? 0,
          predictPackageVolume: volume.trim() || undefined,
          factoryDirect: factoryDirect || undefined,
          payload: {
            deliverMethod: 2,
            expressCompanyId: opt.expressCompanyId,
            expressCompanyName: opt.expressCompanyName,
            predictTotalPackageWeight: kg * 1000,
            expectPickUpGoodsTime: pickTimeMs ?? undefined,
            pickupMethod,
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
        `装箱发货成功${batchSns.length > 0 ? `，发货批次 ${batchSns.join("、")}` : ""}；运单标签可在「待仓库收货」列表打印，商品条码可在列表补打`,
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
          {/* 库存联动：工厂直发（硬阻断口径；单仓制固定主仓） */}
          <section className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">库存联动</span>
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={factoryDirect}
                  onCheckedChange={(v) => setFactoryDirect(v === true)}
                />
                工厂直发（跳过库存校验与扣减）
              </label>
            </div>
            <p className="text-muted-foreground">
              {factoryDirect
                ? "本批货物从工厂直发 TEMU：不校验库存、不扣减（生产单「工厂直发」登记数量）。"
                : "发货前按库存硬校验，不足将阻断；成功后自动扣减并记「发货扣减」流水。未建档货号不参与校验。"}
            </p>
          </section>

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
                  {/* 弹层默认锁触发器宽（w-(--anchor-width)），地址长会被截断——放宽，项内自显全文 */}
                  <SelectContent className="w-auto min-w-72 max-w-[26rem]">
                    {mallAddrs.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
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
                        // 换公司后可约日期/窗口变化——PickupTimePicker 以公司 id 为 key 自行重置
                      }}
                      className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                        selOption?.expressCompanyId === opt.expressCompanyId ? "border-primary bg-primary/5" : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="text-xs font-medium">
                        {opt.expressCompanyName ?? "—"}
                        {opt.hasUsedThisLogistics && <Badge className="ml-1.5 rounded-[4px] bg-blue-500/15 text-blue-700 dark:text-blue-400">用过</Badge>}
                        {opt.courierTimeType === 1 && <Badge className="ml-1.5 rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">次日达</Badge>}
                        {opt.courierTimeType === 2 && <Badge className="ml-1.5 rounded-[4px] bg-cyan-500/15 text-cyan-700 dark:text-cyan-400">隔日达</Badge>}
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
              <PickupTimePicker
                key={selOption?.expressCompanyId ?? "none"}
                slots={slots}
                disabled={!selOption}
                onChange={setPickTimeMs}
              />
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
                    <TruncTip
                      text={r.productName ?? "—"}
                      className="mt-0.5 max-w-full text-[11px] text-muted-foreground"
                    >
                      <span>
                        {r.subPurchaseOrderSn ?? "—"} · {r.productName ?? "—"}
                      </span>
                    </TruncTip>
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
            disabled={
              sending ||
              loading ||
              selOption?.expressCompanyId == null ||
              !selOption?.expressCompanyName
            }
            onClick={submitPacking}
          >
            {sending ? "提交中…" : "确认发货"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
