"use client"

import * as React from "react"
import { toast } from "sonner"
import { CheckSquare, Loader2, RefreshCw, Send, Square, Zap } from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  getStockableProductsAction,
  batchApplyTemuStockingAction,
  autoStockingLinkAction,
  type TemuStockableRow,
  type TemuStockApplyBatchResult,
  type TemuAutoStockResult,
} from "@/server/actions/temu-fulfillment"
import { ProductNameCell, EmptyHint } from "@/components/temu/products-table"

/**
 * 申报备货视图（备货 Tab 子视图）：对商品向平台主动申请新备货单（VMI 备货，
 * 非待接单状态推进）。官方无「可申报商品」查询接口——候选为本地在售商品池 +
 * salesv2 canPurchase 标记；批量申报逐项串行调 apply，官方错误原样透传。
 */
export function StockView({
  store,
  isAdmin,
  onBack,
}: {
  store: string
  isAdmin: boolean
  /** 返回「备货单」视图 */
  onBack: () => void
}) {
  const [q, setQ] = React.useState("")
  const [onlyCanPurchase, setOnlyCanPurchase] = React.useState(true)
  const [rows, setRows] = React.useState<TemuStockableRow[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, startLoading] = React.useTransition()
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  /** 行内申报数量（skcId → 数量；未填用默认 1） */
  const [quantities, setQuantities] = React.useState<Record<string, string>>({})
  const [batchResult, setBatchResult] = React.useState<TemuStockApplyBatchResult[] | null>(null)
  const [applying, startApplying] = React.useTransition()
  const [autoOpen, setAutoOpen] = React.useState(false)

  const load = React.useCallback(() => {
    startLoading(async () => {
      const r = await getStockableProductsAction({
        store,
        q: q.trim() || undefined,
        onlyCanPurchase,
      })
      if (r.ok) {
        setRows(r.rows)
        setError(null)
        setSelected(new Set())
      } else {
        setRows([])
        setError(r.error)
      }
    })
  }, [store, q, onlyCanPurchase])

  React.useEffect(() => {
    const t = setTimeout(load, 400)
    return () => clearTimeout(t)
  }, [load])

  const selectedRows = rows.filter((r) => selected.has(r.productSkcId))

  const runBatch = () => {
    startApplying(async () => {
      const r = await batchApplyTemuStockingAction({
        store,
        items: selectedRows.map((row) => ({
          productSkcId: Number(row.productSkcId),
          productName: row.productName ?? "",
          skuIds: row.skus.map((s) => s.skuId),
          quantity: Math.min(100_000, Math.max(1, Math.round(Number(quantities[row.productSkcId]) || 1))),
        })),
      })
      if (r.ok) {
        setBatchResult(r.results)
        const ok = r.results.filter((x) => x.ok).length
        const bad = r.results.length - ok
        if (bad === 0) toast.success(`已申报 ${ok} 个商品的备货`)
        else toast.warning(`申报完成：${ok} 成功 / ${bad} 失败`, { duration: 8000 })
      } else {
        toast.error(r.error, { duration: 6000 })
      }
    })
  }

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">申报备货（{rows.length}）</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && selectedRows.length > 0 && (
            <>
              <Button size="sm" className="h-9! text-xs" disabled={applying} onClick={runBatch}>
                {applying ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                批量申报（{selectedRows.length}）
              </Button>
              <Button variant="outline" size="sm" className="h-9! text-xs" onClick={() => setAutoOpen(true)}>
                <Zap className="size-4" />
                自动备货（{selectedRows.length}）
              </Button>
            </>
          )}
          <Input
            className="h-9 w-56 text-xs"
            placeholder="搜索商品名 / 货号 / SKC（防抖 400ms）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select
            items={[
              { value: "orders", label: "备货单" },
              { value: "stock", label: "申报备货" },
            ]}
            value="stock"
            onValueChange={(v) => {
              if (v === "orders") onBack()
            }}
          >
            <SelectTrigger className="h-9! w-28 text-xs" aria-label="切换视图">
              <SelectValue>申报备货</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="orders">备货单</SelectItem>
              <SelectItem value="stock">申报备货</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={onlyCanPurchase ? "yes" : "all"}
            onValueChange={(v) => setOnlyCanPurchase(v !== "all")}
          >
            <SelectTrigger className="h-9! w-32 text-xs" aria-label="可备货筛选">
              <SelectValue>{onlyCanPurchase ? "仅可备货" : "全部商品"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="yes">仅可备货</SelectItem>
              <SelectItem value="all">全部商品</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9! text-xs" onClick={load} disabled={loading} aria-label="刷新可申报商品">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto scrollbar-hide">
        <p className="mb-3 text-xs text-muted-foreground">
          申报 = 对商品向平台<b>主动申请新备货单</b>（VMI 备货，非待接单状态推进）；候选为在售商品池，
          「可备货」标记来自官方销售接口（canPurchase）。数量为每 SKU 申报量，上限以官方校验为准（定制品不支持）。
        </p>
        {batchResult && (
          <div className="mb-3 rounded-md border px-3 py-2 text-xs">
            <p className="font-medium">
              上次批量申报：{batchResult.filter((x) => x.ok).length} 成功 / {batchResult.filter((x) => !x.ok).length} 失败
            </p>
            {batchResult.filter((x) => !x.ok).length > 0 && (
              <ul className="mt-1 space-y-0.5 text-red-600 dark:text-red-400">
                {batchResult.filter((x) => !x.ok).map((x) => (
                  <li key={x.productSkcId}>
                    {x.productName || x.productSkcId}：{x.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error ? (
          <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {loading ? "加载中…" : "无可申报商品（可切「全部商品」或调整搜索）"}
          </p>
        ) : (
          <table className="w-max min-w-full caption-bottom text-sm [&_td]:px-3 [&_th]:px-3">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                {isAdmin && <TableHead className="w-8"></TableHead>}
                <TableHead>主图</TableHead>
                <TableHead>商品名</TableHead>
                <TableHead>货号</TableHead>
                <TableHead className="text-right">近7日销量</TableHead>
                <TableHead className="text-right">可用库存</TableHead>
                <TableHead className="text-right">可售天数</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>可备货</TableHead>
                {isAdmin && <TableHead className="text-right">每 SKU 申报量</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const checked = selected.has(r.productSkcId)
                const selectable = isAdmin && r.skus.length > 0
                return (
                  <TableRow key={r.productSkcId}>
                    {isAdmin && (
                      <TableCell>
                        <button
                          type="button"
                          aria-label="选择"
                          disabled={!selectable}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                          onClick={() =>
                            setSelected((s) => {
                              const n = new Set(s)
                              if (n.has(r.productSkcId)) n.delete(r.productSkcId)
                              else n.add(r.productSkcId)
                              return n
                            })
                          }
                        >
                          {checked ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                        </button>
                      </TableCell>
                    )}
                    <TableCell>
                      {r.mainImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.mainImageUrl} alt="" className="size-10 rounded-md object-cover" loading="lazy" />
                      ) : (
                        <div className="size-10 rounded-md bg-muted" />
                      )}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <ProductNameCell name={r.productName} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.productSn ?? <EmptyHint />}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.last7DaysSalesVolume ?? <EmptyHint />}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.warehouseAvailableStock ?? <EmptyHint />}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.availableSaleDays != null ? Math.round(r.availableSaleDays) : <EmptyHint />}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.skus.length === 0
                        ? <EmptyHint />
                        : r.skus.length === 1
                          ? (r.skus[0]?.className ?? r.skus[0]?.skuId ?? <EmptyHint />)
                          : `${r.skus[0]?.className ?? r.skus[0]?.skuId ?? "—"} 等 ${r.skus.length} 个`}
                    </TableCell>
                    <TableCell>
                      {r.canPurchase ? (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">可备货</span>
                      ) : (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <Input
                          className="ml-auto h-8 w-20 text-xs"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          placeholder="1"
                          value={quantities[r.productSkcId] ?? ""}
                          onChange={(e) => setQuantities((s) => ({ ...s, [r.productSkcId]: e.target.value }))}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </table>
        )}
      </CardContent>
      {autoOpen && (
        <AutoStockDialog
          store={store}
          items={selectedRows.map((row) => ({
            productSkcId: Number(row.productSkcId),
            productName: row.productName ?? "",
            skuIds: row.skus.map((s) => s.skuId),
          }))}
          onClose={() => setAutoOpen(false)}
          onBackfill={(map) => {
            if (Object.keys(map).length === 0) return
            setQuantities((s) => ({ ...s, ...map }))
            toast.success(`已回填 ${Object.keys(map).length} 个低于门槛链接的最大可备货量到申报量输入框`)
          }}
        />
      )}
    </Card>
  )
}

/** 自动备货弹窗：试跑（首链接 dryRun 探测确认错误格式）→ 逐链接执行（探测上限→SKU 级判断按最大量备满；
 *  低于最低量不申报，最大量回填表单）。客户端逐链接驱动，天然进度与无超时。 */
function AutoStockDialog({
  store,
  items,
  onClose,
  onBackfill,
}: {
  store: string
  items: Array<{ productSkcId: number; productName: string; skuIds: string[] }>
  onClose: () => void
  /** 低于门槛链接 → 回填量（各 SKU 最大量的最小值） */
  onBackfill: (map: Record<string, string>) => void
}) {
  /** config=输最低量 → probe=试跑首链接 → run=逐链接执行 → done */
  const [phase, setPhase] = React.useState<"config" | "probe" | "run" | "done">("config")
  const [minQty, setMinQty] = React.useState("100")
  const [busy, setBusy] = React.useState(false)
  const [probe, setProbe] = React.useState<TemuAutoStockResult | null>(null)
  const [results, setResults] = React.useState<
    Array<{
      name: string
      skcId: number
      status: "applied" | "below" | "failed" | "rollback"
      summary: string
      note?: string
    }>
  >([])
  const [cursor, setCursor] = React.useState(-1)
  /** 中止标记：关闭弹窗/组件卸载后 runAll 不再继续逐链接调官方申报接口 */
  const abortedRef = React.useRef(false)

  React.useEffect(() => {
    // 卸载（父层切店/关视图等强制移除）时中止后续链接执行
    return () => {
      abortedRef.current = true
    }
  }, [])

  /** 主动关闭：先置中止再交给父层卸载（run 阶段被 onOpenChange 拦截，不会走到这里） */
  const close = () => {
    abortedRef.current = true
    onClose()
  }

  const min = Math.max(1, Math.trunc(Number(minQty) || 0))

  const runProbe = () => {
    setBusy(true)
    void (async () => {
      try {
        const r = await autoStockingLinkAction({ ...items[0]!, store, minQuantity: min, dryRun: true })
        if (r.ok) {
          setProbe(r.result)
          setPhase("probe")
        } else {
          toast.error(`试跑失败：${r.error}`, { duration: 8000 })
        }
      } finally {
        setBusy(false)
      }
    })()
  }

  const runAll = () => {
    setPhase("run")
    setBusy(true)
    void (async () => {
      const acc: typeof results = []
      const backfill: Record<string, string> = {}
      for (let i = 0; i < items.length; i++) {
        if (abortedRef.current) {
          toast.warning(`已中止：完成 ${i}/${items.length}，剩余未执行`, { duration: 8000 })
          break
        }
        const it = items[i]!
        setCursor(i)
        let entry: (typeof results)[number]
        try {
          const r = await autoStockingLinkAction({ ...it, store, minQuantity: min })
          if (!r.ok) {
            entry = { name: it.productName || String(it.productSkcId), skcId: it.productSkcId, status: "failed", summary: r.error }
          } else if (r.result.rollbackNote) {
            entry = { name: it.productName || String(it.productSkcId), skcId: it.productSkcId, status: "rollback", summary: r.result.rollbackNote }
            toast.error(`${it.productName || it.productSkcId}：${r.result.rollbackNote}`, { duration: 10000 })
          } else if (r.result.applied.length > 0) {
            entry = {
              name: it.productName || String(it.productSkcId),
              skcId: it.productSkcId,
              status: "applied",
              summary: `已按最大量申报 ${r.result.applied.map((a) => `${a.skuId}×${a.quantity}`).join("、")}`,
            }
          } else {
            const limits = r.result.skuLimits.map((s) => `${s.skuId}:${s.maxQuantity ?? "?"}`).join("、")
            const allZero = r.result.skuLimits.every((s) => s.maxQuantity === 0)
            entry = {
              name: it.productName || String(it.productSkcId),
              skcId: it.productSkcId,
              status: "below",
              summary: allZero
                ? "全部 SKU 上限为 0（当前不可申报）"
                : `各 SKU 上限（${limits}）均低于最低量，未申报`,
              ...(r.result.backfillQuantity != null ? { note: `已回填申报量 ${r.result.backfillQuantity}` } : {}),
            }
            if (r.result.backfillQuantity != null) backfill[String(it.productSkcId)] = String(r.result.backfillQuantity)
          }
        } catch (err) {
          entry = {
            name: it.productName || String(it.productSkcId),
            skcId: it.productSkcId,
            status: "failed",
            summary: err instanceof Error ? err.message : String(err),
          }
        }
        acc.push(entry)
        setResults([...acc])
      }
      onBackfill(backfill)
      setCursor(-1)
      setBusy(false)
      setPhase("done")
      const ok = acc.filter((x) => x.status === "applied").length
      const below = acc.filter((x) => x.status === "below").length
      const bad = acc.filter((x) => x.status === "failed" || x.status === "rollback").length
      if (abortedRef.current) {
        toast.warning(`自动备货已中止：完成 ${acc.length}/${items.length}（${ok} 申报 / ${below} 低于门槛 / ${bad} 失败）`, { duration: 10000 })
      } else if (bad > 0) toast.warning(`自动备货完成：${ok} 申报 / ${below} 低于门槛 / ${bad} 失败`, { duration: 10000 })
      else toast.success(`自动备货完成：${ok} 申报 / ${below} 低于门槛（已回填）`)
    })()
  }

  const statusLabel: Record<string, string> = {
    applied: "已申报",
    below: "低于门槛",
    failed: "失败",
    rollback: "需人工核查",
  }
  const statusCls: Record<string, string> = {
    applied: "text-emerald-600 dark:text-emerald-400",
    below: "text-amber-600 dark:text-amber-400",
    failed: "text-red-600 dark:text-red-400",
    rollback: "text-red-600 dark:text-red-400",
  }

  return (
    <Dialog
      open
      onOpenChange={(v, details) => {
        if (!v && busy) {
          // 执行中拦截 X / Esc / 点遮罩（三者均经 onOpenChange，cancel 阻止关闭），
          // 误关会让后台继续逐链接申报且界面消失
          details.cancel()
          toast.warning("自动备货执行中，请等待完成后再关闭")
          return
        }
        if (!v) close()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>自动备货（{items.length} 个链接）</DialogTitle>
          <DialogDescription>
            无上限查询接口——先以大数值探测官方上限（错误文案返回），SKU 级判断：上限 ≥ 最低量则按最大量备满申报；
            低于最低量不申报并回填到表单申报量。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto">
          {phase === "config" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <Label className="text-xs">最低申请备货量（SKU 级门槛）*</Label>
                <Input
                  className="h-9 text-xs"
                  inputMode="numeric"
                  min={1}
                  value={minQty}
                  onChange={(e) => setMinQty(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  每个 SKU 独立判断：探测到的最大可申请量 ≥ 该值 → 按最大量申报；低于该值 → 跳过并回填。
                  先试跑第一个链接确认官方错误格式，再执行全部。
                </p>
              </div>
            </div>
          )}
          {phase === "probe" && probe && (
            <div className="space-y-2 text-xs">
              <p className="font-medium">试跑（{items[0]?.productName || items[0]?.productSkcId}）：</p>
              <div className="rounded-md border bg-muted/40 px-2.5 py-2 break-all text-muted-foreground">
                官方原始错误：{probe.rawError ?? "（无——探测被接受）"}
              </div>
              <p>
                解析出的各 SKU 上限：
                {probe.skuLimits.map((s) => (
                  <span key={s.skuId} className="mr-2 font-mono">
                    {s.skuId}→<b className="text-foreground">{s.maxQuantity ?? "未解析"}</b>
                  </span>
                ))}
              </p>
              {probe.skuLimits.every((s) => s.maxQuantity == null) && (
                <p className="text-amber-600 dark:text-amber-400">
                  未能从错误文案解析出上限数字——执行时这些链接会标记失败，建议先与官方错误格式比对后重试。
                </p>
              )}
            </div>
          )}
          {(phase === "run" || phase === "done") && (
            <div className="space-y-1.5 text-xs">
              {phase === "run" && (
                <p className="text-muted-foreground">
                  执行中 {cursor + 1}/{items.length}（每链接探测+申报两次调用，约 1-2 秒/条）…
                </p>
              )}
              {results.map((r, i) => (
                <div
                  key={r.skcId}
                  className={`rounded-md border px-2.5 py-1.5 ${i === cursor ? "border-primary" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">
                      {i === cursor ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null}
                      {r.name}
                    </span>
                    <span className={`shrink-0 font-medium ${statusCls[r.status]}`}>{statusLabel[r.status]}</span>
                  </div>
                  <p className="mt-0.5 break-all text-muted-foreground">
                    {r.summary}
                    {r.note ? ` · ${r.note}` : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          {phase === "config" && (
            <>
              <Button variant="outline" size="sm" onClick={close} disabled={busy}>
                取消
              </Button>
              <Button size="sm" disabled={busy || min < 1} onClick={runProbe}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                试跑首链接
              </Button>
            </>
          )}
          {phase === "probe" && (
            <>
              <Button variant="outline" size="sm" onClick={close} disabled={busy}>
                取消
              </Button>
              <Button size="sm" disabled={busy} onClick={runAll}>
                格式正确，执行全部 {items.length} 条
              </Button>
            </>
          )}
          {phase === "done" && (
            <Button size="sm" onClick={close}>
              完成
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
