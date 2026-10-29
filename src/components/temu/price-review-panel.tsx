"use client"

import * as React from "react"
import { toast } from "sonner"
import { CheckCircle2, Loader2, RefreshCw, TrendingDown, TrendingUp, XCircle } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import {
  ConfirmDialog,
} from "@/components/shared/confirm-dialog"
import {
  getTemuPriceReviewsAction,
  confirmTemuPriceReviewAction,
  rejectTemuPriceReviewAction,
  getTemuAdjustOrdersAction,
  batchApproveTemuAdjustAction,
  type TemuPriceReviewRow,
  type TemuAdjustOrderRow,
} from "@/server/actions/temu-workbench"
import { BARGAIN_REASON_TYPES } from "@/lib/temu-api/workbench-labels"
import { ProductNameCell, EmptyHint } from "@/components/temu/products-table"
import { formatDateTime as fmtTs } from "@/lib/datetime"

/**
 * 核价调价工作台（官方 bg.price.review.* / bg.full.adjust.price.* 实时拉取）：
 * - 核价单：状态筛选（默认待核价）、同意建议价 / 拒绝并重新报价（原因 + SKU 新价）
 * - 调价单：状态筛选（默认待调价）、勾选批量通过
 * 写操作限企业管理员（action 内强制），二次确认后执行。
 */

const REVIEW_STATUS_OPTIONS = [
  { value: "supplier", label: "待供应商确认" },
  { value: "passed", label: "核价通过" },
  { value: "rejected", label: "核价驳回" },
]

const ADJUST_STATUS_OPTIONS = [
  { value: "supplier", label: "待供应商确认" },
  { value: "success", label: "调价成功" },
  { value: "failed", label: "调价失败" },
]

const yuan = (fen: number | null | undefined) =>
  fen == null ? "—" : `¥${(fen / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) }`

/** 价差百分比（正=建议/调价降价 → 红色下降趋势线；负=涨价 → 绿色；0 无图标）。
 *  核价单与调价单同款展示 */
function DeltaPctCell({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct == null) return <EmptyHint />
  const tone =
    deltaPct > 0
      ? "text-red-600 dark:text-red-400"
      : deltaPct < 0
        ? "text-emerald-600 dark:text-emerald-400"
        : ""
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 tabular-nums ${tone}`}>
      {deltaPct > 0 ? (
        <TrendingDown className="size-3.5" />
      ) : deltaPct < 0 ? (
        <TrendingUp className="size-3.5" />
      ) : null}
      {Math.abs(deltaPct).toFixed(1)}%
    </span>
  )
}

/** 价差百分比计算：基准价与新价均为分；(基准-新)/基准，正=降价 */
function deltaPctOf(base: number | null, next: number | null): number | null {
  if (base == null || next == null || base <= 0) return null
  return Math.round(((base - next) / base) * 1000) / 10
}

function StatusBadge({ label, tone }: { label: string; tone: "warn" | "ok" | "bad" | "muted" }) {
  const cls =
    tone === "warn"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : tone === "ok"
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        : tone === "bad"
          ? "bg-red-500/15 text-red-700 dark:text-red-400"
          : "bg-muted text-muted-foreground"
  return <Badge className={`rounded-[4px] ${cls}`}>{label}</Badge>
}

function reviewTone(status: number): "warn" | "ok" | "bad" | "muted" {
  // 0/1 均为待办可操作态（1=待供应商确认是主态）
  if (status === 0 || status === 1) return "warn"
  if (status === 2) return "ok"
  if (status === 3) return "bad"
  return "muted"
}

export function TemuPriceReviewPanel({ store }: { store?: string }) {
  const [section, setSection] = React.useState<"review" | "adjust">("review")
  /** 已成功操作的核价单(orderId)/调价单(priceOrderSn)：官方状态回写有秒级延迟，
   *  操作后行可能仍留在列表——冻结防重复提交（重复提交官方报 4000000）。
   *  提升到面板层：切换单据类型/筛选后区块重挂载也不丢失冻结状态 */
  const [doneReviewOps, setDoneReviewOps] = React.useState<Set<number>>(new Set())
  const [doneAdjustOps, setDoneAdjustOps] = React.useState<Set<string>>(new Set())
  if (!store) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">核价调价</CardTitle>
          <CardDescription>请在右上角选择具体店铺后操作（价格类接口按店铺 token 调用）。</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    // base-ui Tooltip 必须有 Provider 才会显示（缺 Provider 悬浮静默不弹）；
    // 上提到面板根共享，避免每行一个 Provider
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col">
        {section === "review" ? (
          <ReviewSection
            store={store}
            section={section}
            onSectionChange={setSection}
            doneOps={doneReviewOps}
            onDoneOp={(id) => setDoneReviewOps((s) => new Set(s).add(id))}
          />
        ) : (
          <AdjustSection
            store={store}
            section={section}
            onSectionChange={setSection}
            doneOps={doneAdjustOps}
            onDoneOp={(sn) => setDoneAdjustOps((s) => new Set(s).add(sn))}
          />
        )}
      </div>
    </TooltipProvider>
  )
}

/** 单据类型切换（核价单/调价单）：置于各区块工具行最左侧、状态筛选之左 */
function SectionSelect({
  section,
  onSectionChange,
}: {
  section: "review" | "adjust"
  onSectionChange: (v: "review" | "adjust") => void
}) {
  return (
    <Select
      value={section}
      onValueChange={(v) => {
        if (v === "review" || v === "adjust") onSectionChange(v)
      }}
    >
      {/* base-ui SelectValue 默认渲染原始 value（review/adjust），须传 children 显示中文 */}
      <SelectTrigger className="h-8 w-28 text-xs" aria-label="单据类型切换">
        <SelectValue>{section === "review" ? "核价单" : "调价单"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="review">核价单</SelectItem>
        <SelectItem value="adjust">调价单</SelectItem>
      </SelectContent>
    </Select>
  )
}

/** 同意（绿）/拒绝（红）按钮配色：仅图标与文字着色，冻结态与可点态复用 */
const AGREE_BTN_CLS =
  "h-7 border-emerald-600/40 text-xs text-emerald-700 hover:bg-emerald-600/10 hover:text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400"
const REJECT_BTN_CLS =
  "h-7 border-red-600/40 text-xs text-red-700 hover:bg-red-600/10 hover:text-red-700 dark:border-red-500/40 dark:text-red-400"

/* ─── 核价单 ─── */

function ReviewSection({
  store,
  section,
  onSectionChange,
  doneOps,
  onDoneOp,
}: {
  store: string
  section: "review" | "adjust"
  onSectionChange: (v: "review" | "adjust") => void
  /** 已成功操作（同意/拒绝）的核价单号：按钮冻结 */
  doneOps: Set<number>
  onDoneOp: (orderId: number) => void
}) {
  // 默认「待供应商确认」：平台已出建议价、等供应商操作的主态
  const [status, setStatus] = React.useState("supplier")
  const [rows, setRows] = React.useState<TemuPriceReviewRow[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [rejecting, setRejecting] = React.useState<TemuPriceReviewRow | null>(null)
  /** 提交中的核价单号（请求未返回期间禁用按钮，防连点） */
  const [pendingOps, setPendingOps] = React.useState<Set<number>>(new Set())

  const load = React.useCallback(() => {
    if (!store) return
    startLoading(async () => {
      const r = await getTemuPriceReviewsAction({ store, status })
      if (r.ok) {
        setRows(r.rows)
        setError(null)
      } else {
        setRows([])
        setError(r.error)
      }
    })
  }, [store, status])

  React.useEffect(load, [load])

  const onConfirm = async (row: TemuPriceReviewRow) => {
    setPendingOps((s) => new Set(s).add(row.orderId))
    try {
      const r = await confirmTemuPriceReviewAction({ store, orderId: row.orderId })
      if (r.ok) {
        toast.success(`核价单 ${row.orderId} 已同意建议价`)
        onDoneOp(row.orderId)
        load()
      } else {
        toast.error(r.error ?? "操作失败", { duration: 6000 })
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束（不走 {ok:false} 分支）：提示错误，
      // finally 复位 pending——否则按钮永久冻结却谎称「已提交操作」
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 6000 })
    } finally {
      setPendingOps((s) => {
        const n = new Set(s)
        n.delete(row.orderId)
        return n
      })
    }
  }

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      {/* 与商品信息页同构：标题居左，状态筛选/刷新工具行居右 */}
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">核价单（{rows.length}）</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <SectionSelect section={section} onSectionChange={onSectionChange} />
          <Select value={status} onValueChange={(v) => v && setStatus(v)}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label="核价单状态筛选">
              <SelectValue>
                {REVIEW_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {REVIEW_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={load} disabled={loading} aria-label="刷新核价单">
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
                <TableHead>商品名</TableHead>
                <TableHead>货号</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">申报价</TableHead>
                <TableHead className="text-right">建议价</TableHead>
                <TableHead className="text-right">价差</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                    {loading ? "加载中…" : "该状态下暂无核价单"}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const frozen = pendingOps.has(r.orderId) || doneOps.has(r.orderId)
                return (
                <TableRow key={r.orderId}>
                  <TableCell>
                    {r.products[0]?.mainImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.products[0].mainImageUrl} alt="" className="size-10 rounded object-cover" loading="lazy" />
                    ) : (
                      <div className="size-10 rounded bg-muted" />
                    )}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <ProductNameCell name={r.products[0]?.productName ?? null} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.products[0]?.productSn ?? <EmptyHint />}</TableCell>
                  <TableCell>
                    {r.skuIds.length === 0 ? (
                      <EmptyHint />
                    ) : r.skuIds.length === 1 ? (
                      <span className="font-mono text-xs">{r.skuIds[0]}</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={<span className="cursor-default font-mono text-xs" />}>
                          {r.skuIds[0]} 等 {r.skuIds.length} 个
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          <div className="flex max-w-44 flex-col gap-0.5">
                            {r.skuIds.map((id) => (
                              <span key={id} className="font-mono">{id}</span>
                            ))}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.supplyPrice != null ? yuan(r.supplyPrice) : <EmptyHint />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.suggestSupplyPrice != null ? yuan(r.suggestSupplyPrice) : <EmptyHint />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <DeltaPctCell deltaPct={r.deltaPct} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={r.statusLabel} tone={reviewTone(r.status)} />
                  </TableCell>
                  <TableCell className="text-right">
                    {/* 0 待核价 / 1 待供应商确认：均为可操作态（1 是供应商
                        确认建议价的主态；对齐调价单 0/1 可操作的口径）。
                        canBargain=false：官方锁议价（极端压价单），拒绝置灰 */}
                    {r.status === 0 || r.status === 1 ? (
                      <div className="flex justify-end gap-1.5">
                        {/* 已操作冻结（官方状态回写有秒级延迟，行仍留在列表）+
                            in-flight 期间禁用，防重复提交（官方报 4000000）。
                            Trigger 挂 span：Button disabled 带 pointer-events-none，
                            悬浮事件挂按钮上永不触发 */}
                        {frozen ? (
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
                              <Button size="sm" variant="outline" className={AGREE_BTN_CLS} disabled>
                                <CheckCircle2 className="size-3.5" /> 同意
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                              该单已提交操作，等待官方同步（稍后自动从列表消失）
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className={AGREE_BTN_CLS}
                            onClick={() => onConfirm(r)}
                          >
                            <CheckCircle2 className="size-3.5" /> 同意
                          </Button>
                        )}
                        {frozen || !r.canBargain ? (
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
                              <Button size="sm" variant="outline" className={REJECT_BTN_CLS} disabled>
                                <XCircle className="size-3.5" /> 拒绝
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">
                              {frozen ? "该单已提交操作，等待官方同步" : "该单不可重新报价"}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className={REJECT_BTN_CLS}
                            onClick={() => setRejecting(r)}
                          >
                            <XCircle className="size-3.5" /> 拒绝
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </table>
          </div>
        )}
      </CardContent>
      {rejecting && (
        <RejectDialog
          store={store}
          row={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            // 提交成功即冻结该单操作（官方状态回写有延迟，行可能仍留在列表）
            onDoneOp(rejecting.orderId)
            setRejecting(null)
            load()
          }}
        />
      )}
    </Card>
  )
}

/** 拒绝核价：SKU 新申报价（默认建议价，元输入×100 转分）+ 重新报价原因（1~3 条） */
function RejectDialog({
  store,
  row,
  onClose,
  onDone,
}: {
  store: string
  row: TemuPriceReviewRow
  onClose: () => void
  onDone: () => void
}) {
  const [prices, setPrices] = React.useState<Record<string, string>>(() =>
    // 默认回填当前申报价（缺失时兜底官方建议价），单位元
    Object.fromEntries(
      row.skuIds.map((id) => [id, ((row.supplyPrice ?? row.suggestSupplyPrice ?? 0) / 100).toFixed(2)]),
    ),
  )
  const [reasons, setReasons] = React.useState<Array<{ type: string; reason: string }>>([
    { type: "2", reason: "" },
  ])
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async () => {
    const priceItemList = row.skuIds
      .map((id) => {
        const yuanVal = Number(prices[id])
        if (!Number.isFinite(yuanVal) || yuanVal <= 0) return null
        return { productSkuId: Number(id), price: Math.round(yuanVal * 100) }
      })
      .filter((v): v is { productSkuId: number; price: number } => v != null)
    const reasonList = reasons
      .filter((r) => r.reason.trim() !== "")
      .map((r) => ({ type: Number(r.type), reason: r.reason.trim() }))
    if (priceItemList.length === 0) {
      toast.error("请为全部 SKU 填写有效新申报价")
      return
    }
    if (priceItemList.length !== row.skuIds.length) {
      toast.error("存在无效价格，请补全后再提交")
      return
    }
    if (reasonList.length === 0) {
      toast.error("请至少填写一条重新报价原因")
      return
    }
    setSubmitting(true)
    try {
      const r = await rejectTemuPriceReviewAction({
        store,
        orderId: row.orderId,
        priceItemList,
        reasons: reasonList,
      })
      if (r.ok) {
        toast.success(`核价单 ${row.orderId} 已提交新申报价`)
        onDone()
      } else {
        toast.error(r.error ?? "操作失败", { duration: 6000 })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>拒绝建议价并重新报价（单号 {row.orderId}）</DialogTitle>
          <DialogDescription>
            新申报价默认取当前申报价（缺失时取官方建议价），可逐 SKU 调整；单位元。官方要求至少一条重新报价原因。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-3 overflow-y-auto">
          <div className="space-y-1">
            <Label className="text-xs">SKU 新申报价（{row.skuIds.length} 个）</Label>
            {row.skuIds.map((id) => (
              <div key={id} className="flex items-center gap-2">
                <span className="w-32 shrink-0 truncate font-mono text-xs text-muted-foreground">{id}</span>
                <Input
                  className="h-8 text-xs"
                  inputMode="decimal"
                  value={prices[id] ?? ""}
                  onChange={(e) => setPrices((p) => ({ ...p, [id]: e.target.value }))}
                />
                <span className="text-xs text-muted-foreground">元</span>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">重新报价原因</Label>
            {reasons.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={r.type}
                  onValueChange={(v) => {
                    if (v == null) return
                    setReasons((rs) => rs.map((x, j) => (j === i ? { ...x, type: v } : x)))
                  }}
                >
                  <SelectTrigger className="h-8 w-28 shrink-0 text-xs">
                    <SelectValue>{BARGAIN_REASON_TYPES[Number(r.type)] ?? r.type}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(BARGAIN_REASON_TYPES).map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 text-xs"
                  placeholder="具体原因（如：同款市场价更低）"
                  value={r.reason}
                  onChange={(e) =>
                    setReasons((rs) => rs.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))
                  }
                />
                {reasons.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0"
                    onClick={() => setReasons((rs) => rs.filter((_, j) => j !== i))}
                    aria-label="删除原因"
                  >
                    <XCircle className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {reasons.length < 3 && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setReasons((rs) => [...rs, { type: "2", reason: "" }])}>
                + 添加原因
              </Button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}提交新报价
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ─── 调价单 ─── */

function AdjustSection({
  store,
  section,
  onSectionChange,
  doneOps,
  onDoneOp,
}: {
  store: string
  section: "review" | "adjust"
  onSectionChange: (v: "review" | "adjust") => void
  /** 已成功通过的调价单号：同意按钮冻结（防重复提交报 4000000） */
  doneOps: Set<string>
  onDoneOp: (priceOrderSn: string) => void
}) {
  const [status, setStatus] = React.useState("supplier")
  const [rows, setRows] = React.useState<TemuAdjustOrderRow[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  /** 待二次确认通过的单据（逐行同意） */
  const [approving, setApproving] = React.useState<TemuAdjustOrderRow | null>(null)
  /** approve 请求进行中（ConfirmDialog 确认按钮禁用，防连点重复提交） */
  const [approvingPending, setApprovingPending] = React.useState(false)

  const load = React.useCallback(() => {
    startLoading(async () => {
      const r = await getTemuAdjustOrdersAction({ store, status })
      if (r.ok) {
        setRows(r.rows)
        setError(null)
      } else {
        setRows([])
        setError(r.error)
      }
    })
  }, [store, status])

  React.useEffect(load, [load])

  /** 官方接口仅支持「通过」：逐行同意走 batch.review 传单个单号 */
  const approve = async (row: TemuAdjustOrderRow) => {
    setApprovingPending(true)
    try {
      const r = await batchApproveTemuAdjustAction({ store, priceOrderSns: [row.priceOrderSn] })
      if (r.ok) {
        toast.success(`已通过调价单（${row.productName ?? row.priceOrderSn}）`)
        onDoneOp(row.priceOrderSn)
        setApproving(null)
        load()
      } else {
        toast.error(r.error ?? "操作失败", { duration: 6000 })
      }
    } catch (e) {
      // action 内权限校验等以 throw 结束（不走 {ok:false} 分支）：提示错误并
      // 复位 pending——确认按钮保持可用可重试/取消，不静默失败
      toast.error(e instanceof Error ? e.message : "操作失败", { duration: 6000 })
    } finally {
      setApprovingPending(false)
    }
  }

  const actionable = status === "supplier"

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      {/* 与商品信息页同构：标题居左，单据类型/状态筛选/刷新工具行居右 */}
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">调价单（{rows.length}）</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <SectionSelect section={section} onSectionChange={onSectionChange} />
          <Select value={status} onValueChange={(v) => v && setStatus(v)}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label="调价单状态筛选">
              <SelectValue>
                {ADJUST_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ADJUST_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={load} disabled={loading} aria-label="刷新调价单">
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
                <TableHead>商品名</TableHead>
                <TableHead>SKC/货号</TableHead>
                <TableHead>SKU/货号</TableHead>
                <TableHead className="text-right">申报价</TableHead>
                <TableHead className="text-right">调价后申报价</TableHead>
                <TableHead className="text-right">价差</TableHead>
                <TableHead>价格类型</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>创建时间</TableHead>
                {actionable && <TableHead className="text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="h-20 text-center text-muted-foreground">
                    {loading ? "加载中…" : "该状态下暂无调价单"}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.priceOrderSn}>
                  <TableCell>
                    {r.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt="" className="size-10 rounded object-cover" loading="lazy" />
                    ) : (
                      <div className="size-10 rounded bg-muted" />
                    )}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <ProductNameCell name={r.productName} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.skcExtCode ?? r.skcId ?? <EmptyHint />}</TableCell>
                  <TableCell className="text-xs">
                    {/* 货号 → 规格 → SKU ID 优先显示（官方部分行不返回 skuExtCode） */}
                    {r.skuItems.length === 0 ? (
                      <EmptyHint />
                    ) : (
                      `${r.skuItems[0]?.skuExtCode ?? r.skuItems[0]?.spec ?? r.skuItems[0]?.skuId ?? "—"}${r.skuItems.length > 1 ? ` 等 ${r.skuItems.length} 个` : ""}`
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.currentSupplyPrice != null ? yuan(r.currentSupplyPrice) : <EmptyHint />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.newSupplyPrice != null ? yuan(r.newSupplyPrice) : <EmptyHint />}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <DeltaPctCell deltaPct={deltaPctOf(r.currentSupplyPrice, r.newSupplyPrice)} />
                  </TableCell>
                  <TableCell className="text-xs">{r.priceType === 1 ? "活动价" : "日常价"}</TableCell>
                  <TableCell className="max-w-40 truncate text-xs text-muted-foreground" title={r.adjustReason ?? ""}>
                    {r.adjustReason ?? <EmptyHint />}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {r.orderCreateTime != null ? fmtTs(r.orderCreateTime) : <EmptyHint />}
                  </TableCell>
                  {actionable && (
                    <TableCell className="text-right">
                      {doneOps.has(r.priceOrderSn) ? (
                        <Tooltip>
                          <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
                            <Button size="sm" variant="outline" className={AGREE_BTN_CLS} disabled>
                              <CheckCircle2 className="size-3.5" /> 同意
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">该单已通过，等待官方同步</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className={AGREE_BTN_CLS}
                          onClick={() => setApproving(r)}
                        >
                          <CheckCircle2 className="size-3.5" /> 同意
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </table>
          </div>
        )}
      </CardContent>
      {approving && (
        <ConfirmDialog
          open
          title="确认通过调价单"
          description={`确认通过「${approving.productName ?? approving.priceOrderSn}」的调价单？官方接口仅支持「通过」操作，执行后调价即时生效。`}
          confirmText="确认通过"
          pending={approvingPending}
          onConfirm={() => approve(approving)}
          onOpenChange={(v) => !v && setApproving(null)}
        />
      )}
    </Card>
  )
}
