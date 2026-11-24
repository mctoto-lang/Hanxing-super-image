"use client"

import * as React from "react"
import { toast } from "sonner"
import { TriangleAlert, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
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
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  getLogisticsConfigAction,
  getMallAddressesAction,
  getShipInventoryRefAction,
  getShipPackagesAction,
  sendPackingAction,
  type TemuLogisticsPrefItem,
  type TemuShipOrderRow,
  type TemuShipPackageInfo,
} from "@/server/actions/temu-ship"
import { requestShipBoxMarkQuiet } from "./ship-packing"
import {
  chunk,
  effectivePackageCount,
  groupRowsByWarehouse,
  mapLimit,
  projectStock,
} from "./ship-auto-ship-plan"
import { LogisticsPrefEditor } from "./ship-logistics-pref-editor"
import { AutoShipGroupCard } from "./ship-auto-ship-group-card"
import {
  DEFAULT_RUNTIME,
  type GroupRuntime,
  type InvRef,
  type Phase,
  type RowState,
} from "./ship-auto-ship-shared"

/**
 * 自动发货向导（待装箱发货勾选后「自动预约发货」）——自动预约发货的重做版：
 * 阶段 A 预览确认：全部发货单按收货仓分组聚合（同仓合并成一次发货），每单展示
 *   缩略图/货号/包裹（已打印=真实包裹号与每包件数，未打印=按库存档案装箱数推算的
 *   「预计」拆包）/装箱数/发货件数/库存 → 扣减后；发货仓库只选一次；每组的重量、体积
 *   （官方回填，体积未返回按 0.01 兜底）、物流公司（企业级优先顺序 + 黑名单严格口径：
 *   剔除黑名单后必须命中优先名单，否则阻断提示去配置或手选）、预约取货时间（18 点规则）
 *   均在启动前展示并可调整；库存联动开关默认开，任一单库存不足整批阻断。
 * 阶段 B 执行：以收货仓组为单元逐组合并发货（>50 单按官方上限分批），带进度条与逐行状态，
 *   可中止（当前组跑完再停）。每组：未打印单先请求打印商品打包标签（件数锁定、不可调整）
 *   → 拉真实包裹号 → packing.send。某组全部失败即停止后续分组，避免连续报错。
 * 阶段 C 完成：成功/失败汇总，失败原因悬停可见；有变更即回调父层清勾选并实时刷新。
 */

interface MallAddr {
  id: number
  label: string
  isDefault: boolean
  fullText: string
}

export function AutoShipDialog({
  store,
  rows,
  onClose,
  onDone,
}: {
  store: string
  /** 待装箱发货单（可跨收货仓：按收货仓分组逐组合并发货） */
  rows: TemuShipOrderRow[]
  onClose: () => void
  /** 有发货单被打印锁定或发货成功后回调（父层清勾选并实时刷新列表） */
  onDone: () => void
}) {
  const [phase, setPhase] = React.useState<Phase>("confirm")
  const [confirming, setConfirming] = React.useState(false)
  /** 库存联动（开=发货前硬校验+成功后扣减，默认；关=skipInventory 不校验不扣减） */
  const [invLinked, setInvLinked] = React.useState(true)
  const [mallAddrs, setMallAddrs] = React.useState<MallAddr[]>([])
  /** 全部收货仓分组共用的发货仓库 */
  const [addressId, setAddressId] = React.useState<number | null>(null)
  const [addrReady, setAddrReady] = React.useState(false)
  /** 发货地址接口失败的报错文案（addrReady=true 时阻断项展示，不再静默停在「地址加载中」） */
  const [addrError, setAddrError] = React.useState<string | null>(null)
  /** 发货仓库变化计数：变化即各组重新比价 */
  const [matchVersion, setMatchVersion] = React.useState(0)
  const [priority, setPriority] = React.useState<TemuLogisticsPrefItem[]>([])
  const [blacklist, setBlacklist] = React.useState<TemuLogisticsPrefItem[]>([])
  const [prefDirty, setPrefDirty] = React.useState(false)
  /** 偏好配置是否已就绪（就绪前不自动选公司，避免按空名单执行） */
  const [configLoaded, setConfigLoaded] = React.useState(false)
  /** 偏好配置加载失败：名单为空不可信，禁用「加入优先/保存偏好」防整体覆盖企业配置 */
  const [prefFailed, setPrefFailed] = React.useState(false)
  const [invRef, setInvRef] = React.useState<InvRef | null>(null)
  const [invState, setInvState] = React.useState<"loading" | "ready" | "failed">("loading")
  /** 已打印单的包裹明细（官方 package.get：真实包裹号 + 每包件数） */
  const [pkgInfo, setPkgInfo] = React.useState<Record<string, TemuShipPackageInfo[]>>({})
  /** 执行中打印请求成功（件数已锁定）的单号 */
  const [lockedSns, setLockedSns] = React.useState<ReadonlySet<string>>(() => new Set())
  const [runtime, setRuntime] = React.useState<Record<string, GroupRuntime>>({})
  const [rowStatus, setRowStatus] = React.useState<Record<string, RowState>>({})
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const [doneGroups, setDoneGroups] = React.useState(0)
  const [aborting, setAborting] = React.useState(false)
  /** 某组全部失败触发的「停止后续分组」（完成态提示与中止区分原因） */
  const [stoppedEarly, setStoppedEarly] = React.useState(false)
  const abortRef = React.useRef(false)
  const saveRef = React.useRef<(() => void) | null>(null)

  /** 路由跳转卸载组件（侧边栏切页/前进后退）时停止执行：与「中止」同语义
   *  （当前组跑完即停），避免界面已不存在仍继续打印锁定与 packing.send */
  React.useEffect(() => {
    return () => {
      abortRef.current = true
    }
  }, [])

  const groups = React.useMemo(() => groupRowsByWarehouse(rows), [rows])
  /** 显示顺序（组序 → 组内行序）：扣减后库存按此顺序累计 */
  const displayRows = React.useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const stock = React.useMemo(() => projectStock(displayRows, invRef ?? {}), [displayRows, invRef])
  const selAddr = mallAddrs.find((a) => a.id === addressId)
  /** 发货仓库就绪标识：未就绪不比价；地址变化（版本号递增）各组重新比价 */
  const matchToken = addrReady && addressId != null ? `${addressId}#${matchVersion}` : ""

  const onRuntime = React.useCallback((key: string, patch: Partial<GroupRuntime>) => {
    setRuntime((prev) => ({ ...prev, [key]: { ...(prev[key] ?? DEFAULT_RUNTIME), ...patch } }))
  }, [])
  const registerSave = React.useCallback((save: (() => void) | null) => {
    saveRef.current = save
  }, [])
  const savePrefs = React.useCallback(() => saveRef.current?.(), [])

  /** 比价公司一键加入优先顺序（标脏，保存后各组自动重选） */
  const addPriority = React.useCallback((item: TemuLogisticsPrefItem) => {
    setPriority((prev) =>
      prev.some((p) => p.expressCompanyId === item.expressCompanyId) ? prev : [...prev, item],
    )
    setBlacklist((prev) => prev.filter((p) => p.expressCompanyId !== item.expressCompanyId))
    setPrefDirty(true)
  }, [])

  // 打开时并行加载：物流偏好 / 发货仓库 / 库存参考（装箱数 + 库存合计）/ 已打印单包裹明细
  React.useEffect(() => {
    let cancelled = false
    getLogisticsConfigAction()
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          setPriority(r.priority)
          setBlacklist(r.blacklist)
          setPrefFailed(false)
        } else {
          // 名单为空不可信：不引导「重新保存」（会用残缺名单整体覆盖企业配置）
          setPrefFailed(true)
          toast.error("物流偏好配置加载失败，请关闭弹窗后重新打开", { duration: 8000 })
        }
        setConfigLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setPrefFailed(true)
        toast.error("物流偏好配置加载失败，请关闭弹窗后重新打开", { duration: 8000 })
        setConfigLoaded(true)
      })
    getMallAddressesAction(store)
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          // 失败不再静默：置就绪并落错误文案，阻断项展示原因（否则永远停在「地址加载中」）
          setAddrError(r.error)
          setAddrReady(true)
          return
        }
        setMallAddrs(r.rows)
        // 发货仓库只选一次：默认取首单现有发货地址，否则默认地址 / 第一个
        setAddressId(
          rows[0]?.deliveryAddressId ?? r.rows.find((a) => a.isDefault)?.id ?? r.rows[0]?.id ?? null,
        )
        setAddrReady(true)
      })
      .catch(() => {
        if (cancelled) return
        setAddrReady(true)
      })
    getShipInventoryRefAction({
      store,
      codes: rows.map((r) => r.skcExtCode).filter((c): c is string => !!c),
    })
      .then((r) => {
        if (cancelled) return
        if (r.ok) {
          setInvRef(r.rows)
          setInvState("ready")
        } else {
          setInvState("failed")
        }
      })
      .catch(() => {
        if (!cancelled) setInvState("failed")
      })
    const printed = rows.filter((r) => r.isPrintBoxMark === true && r.packageSns.length > 0)
    void mapLimit(printed, 4, async (r) => {
      const p = await getShipPackagesAction({
        store,
        deliveryOrderSn: r.deliveryOrderSn,
      }).catch(() => null)
      if (p?.ok) setPkgInfo((prev) => ({ ...prev, [r.deliveryOrderSn]: p.rows }))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 阻断项（任一存在即不可启动） */
  const blockers = React.useMemo(() => {
    const out: string[] = []
    if (!configLoaded) out.push("物流偏好加载中")
    if (!addrReady || addressId == null) {
      out.push(
        addrError
          ? `发货地址加载失败：${addrError}`
          : addrReady && mallAddrs.length === 0
            ? "没有可选的发货仓库地址，请先在店铺设置中添加"
            : "未选择发货仓库",
      )
    }
    if (invLinked && invState === "loading") out.push("库存参考加载中")
    if (invLinked && invState === "ready") {
      const short = displayRows.filter((r) => stock.get(r.deliveryOrderSn)?.short)
      if (short.length > 0) {
        const detail = short
          .slice(0, 3)
          .map(
            (r) =>
              `${r.skcExtCode ?? r.deliveryOrderSn}（库存 ${stock.get(r.deliveryOrderSn)?.before}，发货 ${r.deliverSkcNum}）`,
          )
          .join("；")
        out.push(
          `${short.length} 单库存不足，整批已阻断——请先入库/盘点、关闭库存联动，或在列表取消勾选：${detail}${short.length > 3 ? "…" : ""}`,
        )
      }
    }
    for (const g of groups) {
      const rt = runtime[g.key] ?? DEFAULT_RUNTIME
      if (!g.rows[0]?.receiveAddress) out.push(`「${g.name}」缺收货地址，无法比价发货`)
      else if (rt.loading) out.push(`「${g.name}」重量/体积回填与比价中`)
      else if (rt.error) out.push(`「${g.name}」比价失败：${rt.error}`)
      else if (!rt.option) out.push(`「${g.name}」优先顺序内无可用物流公司`)
    }
    return out
  }, [
    configLoaded,
    addrReady,
    addrError,
    addressId,
    mallAddrs.length,
    invLinked,
    invState,
    displayRows,
    stock,
    runtime,
    groups,
  ])

  const okCount = displayRows.filter((r) => rowStatus[r.deliveryOrderSn]?.status === "done").length
  const failCount = displayRows.filter((r) => rowStatus[r.deliveryOrderSn]?.status === "failed").length
  const skippedCount = displayRows.filter((r) => rowStatus[r.deliveryOrderSn]?.status === "skipped").length
  const failedRows = displayRows.filter((r) => rowStatus[r.deliveryOrderSn]?.status === "failed")
  const unprintedCount = rows.filter((r) => r.isPrintBoxMark !== true).length

  const setRows = (sns: readonly string[], state: RowState) =>
    setRowStatus((prev) => {
      const n = { ...prev }
      for (const sn of sns) n[sn] = state
      return n
    })

  /** 执行：以收货仓组为单元逐组合并发货；某组全部失败即停止后续分组 */
  const run = async () => {
    setPhase("running")
    setAborting(false)
    setStoppedEarly(false)
    abortRef.current = false
    let okTotal = 0
    let failTotal = 0
    let skippedTotal = 0
    let touched = false
    let stopped = false
    const firstErrors: string[] = []
    /** 执行中拉到的真实包裹数（新打印的单官方锁定后才有；expressPackageNum 按批合计用）。
     *  官方查询返回空（索引延迟）不算数——回落推算值，口径同组头展示（effectivePackageCount） */
    const livePkgs: Record<string, number> = {}
    const cartonOf = (r: TemuShipOrderRow) =>
      r.skcExtCode ? (invRef?.[r.skcExtCode]?.cartonQty ?? null) : null
    const pkgCountOfRow = (r: TemuShipOrderRow) =>
      effectivePackageCount(
        r,
        livePkgs[r.deliveryOrderSn] ?? pkgInfo[r.deliveryOrderSn]?.length ?? null,
        cartonOf(r),
      )

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]!
      const snsOf = g.rows.map((r) => r.deliveryOrderSn)
      if (abortRef.current || stopped) {
        setRows(snsOf, {
          status: "skipped",
          error: stopped ? "某组全部失败，已停止后续分组" : "已按你的操作中止",
        })
        skippedTotal += snsOf.length
        continue
      }
      setActiveKey(g.key)
      const rt = runtime[g.key] ?? DEFAULT_RUNTIME
      const opt = rt.option
      if (addressId == null || !opt?.expressCompanyId || !opt.expressCompanyName) {
        setRows(snsOf, { status: "failed", error: "物流公司或发货仓库未确定" })
        failTotal += snsOf.length
        firstErrors.push(`「${g.name}」物流公司或发货仓库未确定`)
        stopped = true
        continue
      }

      // ① 未打印单先请求打印商品打包标签（件数锁定；50/批）；失败的单剔出本组发货
      const unprinted = g.rows.filter((r) => r.isPrintBoxMark !== true)
      const printable = new Set<string>()
      for (const part of chunk(unprinted, 50)) {
        const partSns = part.map((r) => r.deliveryOrderSn)
        setRows(partSns, { status: "printing" })
        const r = await requestShipBoxMarkQuiet(store, partSns)
        if (r.ok) {
          partSns.forEach((sn) => printable.add(sn))
          setLockedSns((prev) => new Set([...prev, ...partSns]))
          touched = true
        } else {
          setRows(partSns, { status: "failed", error: `打印请求失败：${r.error}` })
          failTotal += partSns.length
          firstErrors.push(`「${g.name}」打印请求失败：${r.error}`)
        }
      }
      // 新打印的单拉真实包裹号（进度区展示；拉取失败不阻断发货）
      const justPrinted = unprinted.filter((r) => printable.has(r.deliveryOrderSn))
      if (justPrinted.length > 0) {
        await mapLimit(justPrinted, 4, async (r) => {
          const p = await getShipPackagesAction({
            store,
            deliveryOrderSn: r.deliveryOrderSn,
          }).catch(() => null)
          if (p?.ok && p.rows.length > 0) {
            livePkgs[r.deliveryOrderSn] = p.rows.length
            setPkgInfo((prev) => ({ ...prev, [r.deliveryOrderSn]: p.rows }))
          }
        })
      }

      // ② 同仓合并装箱发货（packing.send；50/批，expressPackageNum 按批内包裹数合计）
      const sendable = g.rows.filter(
        (r) => r.isPrintBoxMark === true || printable.has(r.deliveryOrderSn),
      )
      let groupOk = 0
      let groupFail = 0
      for (const part of chunk(sendable, 50)) {
        const partSns = part.map((r) => r.deliveryOrderSn)
        setRows(partSns, { status: "shipping" })
        const r = await sendPackingAction({
          store,
          deliveryOrderSns: partSns,
          deliveryAddressId: addressId,
          predictPackageVolume: rt.volume.trim() || undefined,
          skipInventory: !invLinked || undefined,
          payload: {
            deliverMethod: 2,
            expressCompanyId: opt.expressCompanyId,
            expressCompanyName: opt.expressCompanyName,
            predictTotalPackageWeight: Math.max(1, Math.round(Number(rt.weightKg) || 1)) * 1000,
            expectPickUpGoodsTime: rt.pickTimeMs ?? undefined,
            pickupMethod: 0,
            predictId: opt.predictId ?? undefined,
            expressPackageNum: Math.max(1, part.reduce((a, row) => a + pkgCountOfRow(row), 0)),
          } as never,
        }).catch((e: unknown) =>
          e instanceof Error ? { ok: false as const, error: e.message } : { ok: false as const, error: "发货请求失败" },
        )
        if (r.ok) {
          groupOk += partSns.length
          setRows(partSns, { status: "done" })
          if (r.warning) toast.warning(r.warning, { duration: 10_000 })
        } else {
          groupFail += partSns.length
          setRows(partSns, { status: "failed", error: r.error })
          firstErrors.push(`「${g.name}」${r.error}`)
        }
      }
      okTotal += groupOk
      failTotal += groupFail
      // 本组无一成功（打印或发货全败，多半是系统性错误：token/限流/参数）→ 停止后续分组
      const groupFailAll = groupFail + (unprinted.length - printable.size)
      if (groupFailAll > 0 && groupOk === 0) stopped = true
      setDoneGroups(gi + 1)
    }

    setActiveKey(null)
    setStoppedEarly(stopped)
    setPhase("done")
    // 跳过的单（某组全部失败停止后续分组 / 用户中止）在收尾汇总里点名，防「已完成 N/N 组」被误读为全部处理完
    const skippedNote =
      skippedTotal > 0
        ? `，另有 ${skippedTotal} 单未处理（${stopped ? "某组全部失败已停止后续分组" : "已按你的操作中止"}）`
        : ""
    if (okTotal > 0) {
      toast.success(
        `自动发货完成：成功 ${okTotal} 单${failTotal > 0 ? `，失败 ${failTotal} 单（失败原因见下方明细）` : ""}${skippedNote}`,
        { duration: 10_000 },
      )
    } else if (failTotal > 0) {
      toast.error(`自动发货未成功任何单：${firstErrors[0] ?? "未知原因"}${skippedNote}`, {
        duration: 10_000,
      })
    }
    if (touched || okTotal > 0) onDone()
  }

  return (
    <Dialog
      open
      onOpenChange={(v, details) => {
        if (!v && phase === "running") {
          details.cancel()
          toast.warning("发货执行中，请等待完成或点「中止」", { duration: 6000 })
          return
        }
        if (!v) onClose()
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col overflow-y-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            自动预约发货（{rows.length} 单 · {groups.length} 个收货仓）
          </DialogTitle>
          <DialogDescription>
            按收货仓分组合并发货；未打印的单先请求打印商品打包标签（件数锁定）；物流按企业级优先顺序严格选择、黑名单剔除；重量/体积自动回填可改；发货仓库全部组共用。
          </DialogDescription>
        </DialogHeader>

        {phase !== "confirm" && (
          <div className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-3">
              <Progress
                value={groups.length > 0 ? Math.round((doneGroups / groups.length) * 100) : 0}
                aria-label="自动发货进度"
                className="min-w-24 flex-1"
              />
              <span className="shrink-0 text-muted-foreground tabular-nums">
                已完成 {doneGroups}/{groups.length} 组 · 成功 {okCount} / 失败 {failCount}
                {skippedCount > 0 ? ` / 未处理 ${skippedCount}` : ""} / 共 {rows.length} 单
              </span>
              {phase === "running" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={aborting}
                  onClick={() => {
                    abortRef.current = true
                    setAborting(true)
                    toast.info("将在当前收货仓组处理完后停止")
                  }}
                >
                  {aborting ? "停止中…" : "中止"}
                </Button>
              )}
            </div>
            {phase === "done" && aborting && (
              <p className="text-muted-foreground">已按你的操作中止，未处理的发货单保持待装箱状态。</p>
            )}
            {phase === "done" && !aborting && stoppedEarly && (
              <p className="text-muted-foreground">
                某组全部失败已自动停止后续分组，未处理的发货单保持待装箱状态（可处理后重新发起）。
              </p>
            )}
            {phase === "done" && failedRows.length > 0 && (
              <div className="max-h-40 space-y-0.5 overflow-y-auto scrollbar-hide">
                <p className="font-medium text-red-600 dark:text-red-400">失败明细（{failedRows.length} 单）</p>
                {failedRows.slice(0, 50).map((r) => (
                  <p key={r.deliveryOrderSn} className="break-all text-muted-foreground">
                    <span className="font-mono text-foreground">{r.deliveryOrderSn}</span>
                    {r.skcExtCode ? `（${r.skcExtCode}）` : ""}：{rowStatus[r.deliveryOrderSn]?.error ?? "发货失败"}
                  </p>
                ))}
                {failedRows.length > 50 && <p className="text-muted-foreground">……其余 {failedRows.length - 50} 单略</p>}
              </div>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-hide">
          {phase === "confirm" && (
            <section className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <div className="flex items-start justify-between gap-3 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5">
                <div className="min-w-0 text-xs">
                  <p className="text-sm font-medium">库存联动</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {invLinked
                      ? "发货前按库存硬校验，任一单不足整批阻断；成功后自动扣减并记「发货扣减」流水。"
                      : "已关闭：不校验也不扣减本地库存（账实差异人工处理；不标记工厂直发）。"}
                  </p>
                </div>
                <Switch checked={invLinked} onCheckedChange={setInvLinked} aria-label="库存联动开关" />
              </div>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">
                    <span className="text-red-600">*</span> 发货仓库（全部收货仓分组共用，只选一次）
                  </Label>
                  <Select
                    items={mallAddrs.map((a) => ({ value: String(a.id), label: a.label }))}
                    value={String(addressId ?? "")}
                    onValueChange={(v) => {
                      if (!v) return
                      setAddressId(Number(v))
                      setMatchVersion((n) => n + 1)
                    }}
                  >
                    <SelectTrigger className="h-8 w-full text-xs" aria-label="发货仓库">
                      <SelectValue placeholder={addrReady ? "选择发货仓库" : "地址加载中…"} />
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
                <LogisticsPrefEditor
                  priority={priority}
                  blacklist={blacklist}
                  dirty={prefDirty}
                  failed={prefFailed}
                  onChange={(n) => {
                    setPriority(n.priority)
                    setBlacklist(n.blacklist)
                  }}
                  onDirtyChange={setPrefDirty}
                  onSaved={(n) => {
                    setPriority(n.priority)
                    setBlacklist(n.blacklist)
                  }}
                  registerSave={registerSave}
                />
              </div>
            </section>
          )}

          {phase === "confirm" && blockers.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:text-amber-300">
              <p className="flex items-center gap-1.5 font-medium">
                <TriangleAlert className="size-3.5" />
                以下问题解决后才能开始自动发货（共 {blockers.length} 项）
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {invState === "failed" && (
            <p className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3.5" />
              库存参考加载失败：扣减后库存与装箱数暂无法预览（发货时服务端仍会按库存校验）。
            </p>
          )}

          {groups.map((g) => (
            <AutoShipGroupCard
              key={g.key}
              store={store}
              group={g}
              matchToken={matchToken}
              addressId={addressId}
              configLoaded={configLoaded}
              priority={priority}
              blacklist={blacklist}
              prefDirty={prefDirty}
              prefFailed={prefFailed}
              invLinked={invLinked}
              invRef={invRef}
              stock={stock}
              pkgInfo={pkgInfo}
              lockedSns={lockedSns}
              rowStatus={rowStatus}
              active={activeKey === g.key}
              phase={phase}
              onRuntime={onRuntime}
              onAddPriority={addPriority}
              onSavePrefs={savePrefs}
            />
          ))}
        </div>

        <DialogFooter className="gap-2">
          {phase === "confirm" && (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                关闭
              </Button>
              <Button size="sm" disabled={blockers.length > 0} onClick={() => setConfirming(true)}>
                <Zap className="size-3.5" /> 自动发货（{rows.length} 单）
              </Button>
            </>
          )}
          {phase === "done" && (
            <Button variant="outline" size="sm" onClick={onClose}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setConfirming(false)}
          title="确认自动发货"
          description={`将对 ${groups.length} 个收货仓分组逐组合并发货，共 ${rows.length} 单${
            unprintedCount > 0
              ? `（其中 ${unprintedCount} 单未打印，将先请求打印商品打包标签——件数锁定后不可调整）`
              : ""
          }；发货仓库 ${selAddr?.label ?? "—"}；库存联动${invLinked ? "开（校验并扣减）" : "关"}。官方 packing.send 成功后即生成发货批次，不可撤销。`}
          confirmText="开始发货"
          onConfirm={() => {
            setConfirming(false)
            void run()
          }}
        />
      )}
    </Dialog>
  )
}
