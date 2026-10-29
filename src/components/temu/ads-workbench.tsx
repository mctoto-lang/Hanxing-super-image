"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Megaphone, Pause, Play, RefreshCw } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import type { TemuAdsRow } from "@/server/actions/temu"
import { temuImageSrc } from "@/lib/temu/image"
import { EmptyHint } from "@/components/temu/products-table"
import {
  getTemuAdPlansAction,
  listTemuAdProductsAction,
  createTemuAdsAction,
  modifyTemuAdAction,
  type TemuAdPlanRow,
  type TemuAdProductRow,
} from "@/server/actions/temu-workbench"

/**
 * 广告推广工作台（官方 bg.glo.searchrec.ad.* + temu_ad 注册表）。
 *
 * 「商品推广报表」= 双源合并单表：报表同步行（temu_ads_product_daily 窗口聚合，
 * 近 N 日口径）∪ 本页创建的注册表行（detail.query 实时状态/预算/目标ROAS）。
 * 同名列报表窗口值优先、实时值兜底（刚创建未同步的行）；状态/操作列仅注册表行有。
 *
 * 平台限制（2026-10-20 实测）：卖家后台手动创建的广告对官方接口不可见，
 * 仅通过本页（API）创建的广告数据可同步展示。写操作需广告推广页 tab 权限（action 内强制）。
 */

const yuan = (fen: number | null | undefined) =>
  fen == null ? "—" : `¥${(fen / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`

const num = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("zh-CN")

/** 报表行与注册表行按 productId 对齐后的合并行 */
interface MergedAdRow {
  productId: string
  mainImageUrl: string | null
  /** 主图转存 URL（报表行 temu_product 反查带出；展示优先） */
  mainImageCosUrl: string | null
  productName: string | null
  productSn: string | null
  plan: TemuAdPlanRow | null
  report: TemuAdsRow | null
}

export function TemuAdsWorkbench({
  store,
  reportRows,
  range,
  urlStore,
}: {
  /** 工作台操作店铺（未选店时页面默认第一个启用店） */
  store?: string
  /** 报表同步聚合行（服务端 getTemuAdsAction，近 N 日窗口口径） */
  reportRows: TemuAdsRow[]
  range: number
  /** URL 上的 store 参数（窗口下拉跳转保持一致；undefined=全部店铺） */
  urlStore?: string
}) {
  const router = useRouter()
  const [plans, setPlans] = React.useState<TemuAdPlanRow[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [creating, setCreating] = React.useState(false)
  const [modifying, setModifying] = React.useState<
    { row: TemuAdPlanRow; action: "pause" | "open" | "budget" | "roas" } | null
  >(null)
  /** 修改请求进行中（下传确认弹窗禁用确认按钮，防连点重复提交官方写操作） */
  const [modifyPending, setModifyPending] = React.useState(false)

  const load = React.useCallback(() => {
    if (!store) return
    startLoading(async () => {
      const r = await getTemuAdPlansAction({ store })
      if (r.ok) {
        setPlans(r.rows)
        setError(null)
      } else {
        setPlans([])
        setError(r.error)
      }
    })
  }, [store])

  React.useEffect(load, [load])

  // 双源并集：报表行 ∪ 注册表行，花费降序（无数据的注册表行沉底）
  const merged = React.useMemo(() => {
    const byId = new Map<string, MergedAdRow>()
    for (const r of reportRows) {
      byId.set(r.productId, {
        productId: r.productId,
        mainImageUrl: r.mainImageUrl,
        mainImageCosUrl: r.mainImageCosUrl,
        productName: r.productName,
        productSn: r.productSn,
        plan: null,
        report: r,
      })
    }
    for (const p of plans) {
      const cur = byId.get(p.productId)
      byId.set(p.productId, {
        productId: p.productId,
        mainImageUrl: cur?.mainImageUrl ?? p.mainImageUrl,
        // 注册表行（官方实时接口）无转存 URL，仅报表行（temu_product 反查）有
        mainImageCosUrl: cur?.mainImageCosUrl ?? null,
        productName: cur?.productName ?? p.productName,
        productSn: cur?.productSn ?? p.productSn,
        plan: p,
        report: cur?.report ?? null,
      })
    }
    return [...byId.values()].sort(
      (a, b) =>
        (b.report?.adSpend ?? b.plan?.spendFen ?? 0) -
        (a.report?.adSpend ?? a.plan?.spendFen ?? 0),
    )
  }, [reportRows, plans])

  // 刷新 = 服务端重取报表/大盘卡（router.refresh）+ 注册表实时重拉
  const refreshAll = () => {
    router.refresh()
    load()
  }

  // 窗口下拉跳转（近 7 日为缺省，不写 range 参数；与原 Link 切换口径一致）
  const rangeHref = (v: string) => {
    const p = new URLSearchParams()
    p.set("tab", "ads")
    if (v !== "7") p.set("range", v)
    if (urlStore) p.set("store", urlStore)
    return `/temu?${p.toString()}`
  }

  const onModify = async (
    row: TemuAdPlanRow,
    action: "pause" | "open" | "budget" | "roas",
    value?: { budget?: number; roas?: number },
  ) => {
    setModifyPending(true)
    try {
      const r = await modifyTemuAdAction({
        store,
        productId: row.productId,
        action,
        ...value,
      })
      if (r.ok) {
        toast.success(`商品 ${row.productName ?? row.productId} 广告已更新`)
        setModifying(null)
        load()
      } else {
        toast.error(r.error ?? "操作失败", { duration: 8000 })
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束（不走 {ok:false} 分支）：提示错误并
      // 复位 pending，确认弹窗按钮恢复可用可重试/取消，不静默失败
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 8000 })
    } finally {
      setModifyPending(false)
    }
  }

  if (!store) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">商品推广报表</CardTitle>
        </CardHeader>
      </Card>
    )
  }

  return (
    // base-ui Tooltip 必须有 Provider 才会显示（缺 Provider 悬浮静默不弹）
    <TooltipProvider>
      <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">商品推广报表（{merged.length}）</CardTitle>
        {/* 创建广告 / 窗口下拉 / 刷新 同一行 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-8 text-xs" onClick={() => setCreating(true)}>
            <Megaphone className="size-3.5" /> 创建广告
          </Button>
          <Select value={String(range)} onValueChange={(v) => v && router.push(rangeHref(v))}>
            {/* base-ui SelectValue 默认渲染原始 value（7/30），须传 children 显示中文 */}
            <SelectTrigger className="h-8 w-28 text-xs" aria-label="统计窗口切换">
              <SelectValue>近 {range} 日</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">近 7 日</SelectItem>
              <SelectItem value="30">近 30 日</SelectItem>
            </SelectContent>
          </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={refreshAll}
              disabled={loading}
              aria-label="刷新商品推广报表"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-auto scrollbar-hide">
          {error ? (
            <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : (
            // overflow-clip 只按圆角裁剪（非滚动容器，sticky 表头仍锚定页侧 CardContent）
            <div className="w-max min-w-full overflow-clip rounded-md border">
            <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>主图</TableHead>
                  <TableHead>商品</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">日预算</TableHead>
                  <TableHead className="text-right">目标 ROAS</TableHead>
                  <TableHead className="text-right">花费</TableHead>
                  <TableHead className="text-right">申报价销售额</TableHead>
                  <TableHead className="text-right">ROAS</TableHead>
                  <TableHead className="text-right">每笔成交花费</TableHead>
                  <TableHead className="text-right">件数</TableHead>
                  <TableHead className="text-right">曝光 / 点击</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {merged.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={12} className="h-20 text-center text-muted-foreground">
                      {loading ? "加载中…" : "暂无广告数据——通过「创建广告」经官方 API 创建后，投放数据将在此展示"}
                    </TableCell>
                  </TableRow>
                )}
                {merged.map((row) => (
                  <TableRow key={row.productId}>
                    <TableCell>
                      {row.mainImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={temuImageSrc(row.mainImageCosUrl, row.mainImageUrl)} alt="" className="size-10 rounded object-cover" loading="lazy" />
                      ) : (
                        <div className="size-10 rounded bg-muted" />
                      )}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <p className="truncate text-xs font-medium" title={row.productName ?? ""}>
                        {row.productName ?? <EmptyHint />}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {row.productSn ?? row.productId}
                      </p>
                    </TableCell>
                    <TableCell>
                      {row.plan ? (
                        <Badge variant="secondary" className="rounded-[4px]">{row.plan.adShowStatusLabel}</Badge>
                      ) : (
                        <EmptyHint />
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.plan ? yuan(row.plan.budget) : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.plan?.roas ?? <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(row.report?.adSpend ?? row.plan?.spendFen) != null
                        ? yuan(row.report?.adSpend ?? row.plan?.spendFen)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(row.report?.orderPayAmt ?? row.plan?.orderPayAmtFen) != null
                        ? yuan(row.report?.orderPayAmt ?? row.plan?.orderPayAmtFen)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.report?.roas != null ? row.report.roas.toFixed(2) : (row.plan?.roasSummary ?? <EmptyHint />)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.report?.transactionCost != null
                        ? yuan(row.report.transactionCost)
                        : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.report?.goodsNum != null ? num(row.report.goodsNum) : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {row.report?.imprCnt != null ? num(row.report.imprCnt) : <EmptyHint />} /{" "}
                      {row.report?.clkCnt != null ? num(row.report.clkCnt) : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.plan ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setModifying({ row: row.plan!, action: "budget" })}
                          >
                            改预算
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setModifying({ row: row.plan!, action: "roas" })}
                          >
                            改ROAS
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setModifying({ row: row.plan!, action: "pause" })}
                          >
                            <Pause className="size-3.5" /> 暂停
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setModifying({ row: row.plan!, action: "open" })}
                          >
                            <Play className="size-3.5" /> 开启
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
            </div>
          )}
        </CardContent>
        {/* 弹窗为 Portal 渲染，挂在 Card 内不影响布局 */}
        {creating && (
          <CreateAdsDialog
            store={store}
            onClose={() => setCreating(false)}
            onDone={() => {
              setCreating(false)
              refreshAll()
            }}
          />
        )}
        {modifying && (
          <ModifyAdDialog
            modifying={modifying}
            pending={modifyPending}
            onCancel={() => setModifying(null)}
            onSubmit={(value) => onModify(modifying.row, modifying.action, value)}
          />
        )}
      </Card>
    </TooltipProvider>
  )
}

/* ─── 创建广告弹窗：选商品（可投性前置校验）+ 日预算 + 目标 ROAS ─── */

function CreateAdsDialog({
  store,
  onClose,
  onDone,
}: {
  store: string
  onClose: () => void
  onDone: () => void
}) {
  const [products, setProducts] = React.useState<TemuAdProductRow[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [q, setQ] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [budgetYuan, setBudgetYuan] = React.useState("")
  const [roas, setRoas] = React.useState("")
  const [loading, startLoading] = React.useTransition()
  const [submitting, setSubmitting] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [result, setResult] = React.useState<
    | { successCount: number; alreadyCount: number; fails: { productId: string; reason: string | null }[] }
    | null
  >(null)

  const load = React.useCallback(() => {
    startLoading(async () => {
      const r = await listTemuAdProductsAction({ store, q: q || undefined })
      if (r.ok) {
        setProducts(r.rows)
        setError(null)
      } else {
        setProducts([])
        setError(r.error)
      }
    })
  }, [store, q])

  React.useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0)
    return () => clearTimeout(t)
  }, [load, q])

  const toggle = (pid: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })

  const budgetFen = Math.round(Number(budgetYuan) * 100)
  const roasVal = Number(roas)
  const canSubmit =
    selected.size > 0 &&
    Number.isFinite(budgetFen) &&
    budgetFen > 0 &&
    Number.isFinite(roasVal) &&
    roasVal > 0

  const submit = async () => {
    setSubmitting(true)
    try {
      const items = [...selected].map((productId) => ({
        productId,
        budget: budgetFen,
        roas: roasVal,
      }))
      const r = await createTemuAdsAction({ store, items })
      if (r.ok) {
        setResult({ successCount: r.successCount, alreadyCount: r.alreadyCount, fails: r.fails })
        if (r.successCount > 0) toast.success(`已创建 ${r.successCount} 个商品的广告`)
        setConfirming(false)
      } else {
        toast.error(r.error, { duration: 10000 })
        setConfirming(false)
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束：提示错误并关闭确认弹窗，主弹窗保留可重试
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 10000 })
      setConfirming(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      {/* sm: 前缀必带：无前缀 max-w-* 会被基础类 sm:max-w-sm 压住（弹窗过窄） */}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>创建广告（官方 API）</DialogTitle>
          <DialogDescription>
            通过官方 API 创建的商品推广广告——仅此类广告的数据可回读展示。预算单位元；
            目标 ROAS 为数值（如 3.5）。商品列表已按官方接口校验可投性。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm">
              创建成功 <b>{result.successCount}</b> 个
              {result.alreadyCount > 0 && <>，此前已创建 {result.alreadyCount} 个</>}
              {result.fails.length > 0 && <>，失败 {result.fails.length} 个：</>}
            </p>
            {result.fails.length > 0 && (
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {result.fails.map((f) => (
                  <div key={f.productId} className="flex items-start gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">
                    <span className="font-mono text-muted-foreground">{f.productId}</span>
                    <span className="text-red-600 dark:text-red-400">{f.reason ?? "未知原因"}</span>
                  </div>
                ))}
              </div>
            )}
            <DialogFooter>
              <Button onClick={onDone}>完成</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">商品（可投性实时校验）</Label>
              <Input
                className="h-8 text-xs"
                placeholder="搜索商品名 / 货号"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {error ? (
                <p className="py-6 text-center text-xs text-red-600 dark:text-red-400">{error}</p>
              ) : loading && products.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">加载中…</p>
              ) : products.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  未找到可展示商品（店铺商品由定时同步维护）
                </p>
              ) : (
                products.map((p) => {
                  const disabled = !p.eligible
                  return (
                    <label
                      key={p.productId}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${disabled ? "opacity-60" : "hover:bg-muted/60"}`}
                    >
                      <Checkbox
                        checked={selected.has(p.productId)}
                        disabled={disabled}
                        onCheckedChange={() => toggle(p.productId)}
                        aria-label={`选择 ${p.productName ?? p.productId}`}
                      />
                      {p.mainImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.mainImageUrl} alt="" className="size-8 rounded object-cover" loading="lazy" />
                      ) : (
                        <div className="size-8 rounded bg-muted" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block max-w-80 truncate text-xs font-medium" title={p.productName ?? ""}>
                          {p.productName ?? <EmptyHint />}
                        </span>
                        <span className="block max-w-80 truncate font-mono text-[11px] text-muted-foreground">
                          {p.productSn ?? p.productId}
                        </span>
                      </span>
                      {p.advertised ? (
                        <Badge className="rounded-[4px] bg-blue-500/15 text-blue-700 dark:text-blue-400">已创建</Badge>
                      ) : p.eligible ? (
                        <Badge className="rounded-[4px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">可投</Badge>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Badge className="rounded-[4px] bg-red-500/15 text-red-700 dark:text-red-400" />
                            }
                          >
                            不可投
                          </TooltipTrigger>
                          <TooltipContent className="max-w-56 text-xs">
                            {p.grayReasons.join("；") || "官方未返回原因"}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </label>
                  )
                })
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">日预算（元 / 全部选中商品）</Label>
                <Input
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="如 50"
                  value={budgetYuan}
                  onChange={(e) => setBudgetYuan(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">目标 ROAS（如 3.5）</Label>
                <Input
                  className="h-8 text-xs"
                  inputMode="decimal"
                  placeholder="如 3.5"
                  value={roas}
                  onChange={(e) => setRoas(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={submitting}>
                取消
              </Button>
              <Button disabled={!canSubmit || submitting} onClick={() => setConfirming(true)}>
                创建（{selected.size} 个商品）
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>

      {confirming && (
        <ConfirmDialog
          open
          title="确认创建广告"
          description={`将为 ${selected.size} 个商品创建官方广告，日预算 ¥${budgetYuan} / 商品，目标 ROAS ${roas}。创建后立即生效并产生真实花费，请确认。`}
          confirmText="确认创建"
          pending={submitting}
          onConfirm={submit}
          onOpenChange={(v) => !v && setConfirming(false)}
        />
      )}
    </Dialog>
  )
}

/* ─── 修改弹窗：改预算 / 改目标 ROAS（暂停/开启走二次确认） ─── */

function ModifyAdDialog({
  modifying,
  pending,
  onCancel,
  onSubmit,
}: {
  modifying: { row: TemuAdPlanRow; action: "pause" | "open" | "budget" | "roas" }
  /** 提交请求进行中：确认按钮禁用（防连点重复提交官方写操作） */
  pending: boolean
  onCancel: () => void
  onSubmit: (value: { budget?: number; roas?: number }) => void
}) {
  const [value, setValue] = React.useState("")
  const [confirming, setConfirming] = React.useState(false)
  const isPause = modifying.action === "pause"
  const isOpen = modifying.action === "open"
  const isValue = modifying.action === "budget" || modifying.action === "roas"
  const numVal = Number(value)
  const valid = Number.isFinite(numVal) && numVal > 0

  return (
    <>
      <Dialog open={isValue} onOpenChange={(v) => !v && onCancel()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {modifying.action === "budget" ? "修改日预算" : "修改目标 ROAS"}
            </DialogTitle>
            <DialogDescription>
              商品：{modifying.row.productName ?? modifying.row.productId}
              {modifying.action === "budget"
                ? `，当前 ${yuan(modifying.row.budget)}`
                : `，当前 ${modifying.row.roas ?? "—"}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">{modifying.action === "budget" ? "新日预算（元）" : "新目标 ROAS"}</Label>
            <Input
              className="h-8 text-xs"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button
              disabled={!valid}
              onClick={() => setConfirming(true)}
            >
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {(isPause || isOpen) && (
        <ConfirmDialog
          open
          title={isPause ? "暂停广告" : "开启广告"}
          description={`${isPause ? "暂停" : "开启"}商品「${modifying.row.productName ?? modifying.row.productId}」的广告投放？`}
          confirmText={isPause ? "确认暂停" : "确认开启"}
          pending={pending}
          onConfirm={() => onSubmit({})}
          onOpenChange={(v) => !v && onCancel()}
        />
      )}

      {isValue && confirming && (
        <ConfirmDialog
          open
          title={modifying.action === "budget" ? "确认修改日预算" : "确认修改目标 ROAS"}
          description={
            modifying.action === "budget"
              ? `商品「${modifying.row.productName ?? modifying.row.productId}」日预算将改为 ¥${value}，立即生效。`
              : `商品「${modifying.row.productName ?? modifying.row.productId}」目标 ROAS 将改为 ${value}，立即生效。`
          }
          confirmText="确认"
          pending={pending}
          onConfirm={() =>
            onSubmit(
              modifying.action === "budget"
                ? { budget: Math.round(numVal * 100) }
                : { roas: numVal },
            )
          }
          onOpenChange={(v) => !v && setConfirming(false)}
        />
      )}
    </>
  )
}
