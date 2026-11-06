"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { getProductDetailAction } from "@/server/actions/inventory"
import { getProductTrendAction } from "@/server/actions/inventory-analysis"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Area, AreaChart, XAxis, YAxis } from "recharts"
import { formatDateTime } from "@/lib/datetime"
import { InvBadge } from "./inv-badge"
import {
  MOVEMENT_TYPE_BADGE,
  PRODUCT_FIELD_LABELS,
  MOVEMENT_TYPE_LABELS,
  PRODUCTION_STATE_BADGE,
  PRODUCTION_STATE_DOT,
  PRODUCTION_STATE_LABELS,
  SHIP_STATE_BADGE,
  SHIP_STATE_DOT,
  SHIP_STATE_LABELS,
} from "./labels"

/**
 * 货号详情右抽屉（shadcn 模板结构：border-b 头部 + 滚动体分区）：
 * 档案信息 + 当前库存 + 库存趋势 + 最近流水 + 档案变更日志。
 * 编辑入口在总览表格行内铅笔（抽屉不再带「编辑档案」）。
 */

export function ProductDetailSheet({
  productId,
  onOpenChange,
}: {
  productId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = React.useState<Awaited<
    ReturnType<typeof getProductDetailAction>
  > | null>(null)
  const [, startLoad] = React.useTransition()

  React.useEffect(() => {
    if (!productId) {
      setData(null)
      return
    }
    startLoad(async () => {
      const r = await getProductDetailAction(productId)
      if (r.ok) setData(r)
      else toast.error(r.error)
    })
  }, [productId])

  const [trend, setTrend] = React.useState<Array<{ day: string; qty: number }>>([])
  React.useEffect(() => {
    if (!productId) {
      setTrend([])
      return
    }
    void getProductTrendAction(productId, 30).then((r) => {
      if (r.ok) setTrend(r.points)
    })
  }, [productId])

  const product = data?.ok ? data.product : null
  const total = data?.ok ? data.totalQty : 0
  // 流水按 createdAt 倒序，首条即最后变动
  const lastMovementAt =
    data?.ok && data.movements.length > 0 ? data.movements[0].createdAt : null

  /** 档案信息定义项（空值统一 —） */
  const profile: Array<[string, React.ReactNode]> = [
    ["装箱数", product?.cartonQty != null ? String(product.cartonQty) : null],
    ["生产周期(天)", product?.leadTimeDays != null ? String(product.leadTimeDays) : null],
    ["MOQ", product?.moq != null ? String(product.moq) : null],
    ["库存上限", product?.stockUpper != null ? String(product.stockUpper) : null],
    [
      "条码",
      product?.barcodePrePasted ? (
        <span title="出厂已预贴，无需打印">已预贴</span>
      ) : (
        <span className="text-muted-foreground" title="未预贴，发货时一并打印">
          未预贴
        </span>
      ),
    ],
  ]

  return (
    <Sheet open={Boolean(productId)} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-[520px]"
        overlayBlur={false}
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2.5">
            {product?.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.imageUrl}
                alt=""
                className="size-12 shrink-0 rounded-md object-cover"
              />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-normal">{product?.productCode ?? ""}</span>
              <span className="block truncate text-sm font-normal text-muted-foreground">
                {product?.name ?? ""}
              </span>
            </span>
            {product ? (
              <span className="flex shrink-0 items-center gap-1.5">
                <InvBadge
                  className={SHIP_STATE_BADGE[product.shipState]}
                  dot={SHIP_STATE_DOT[product.shipState]}
                >
                  {SHIP_STATE_LABELS[product.shipState]}
                </InvBadge>
                <InvBadge
                  className={PRODUCTION_STATE_BADGE[product.productionState]}
                  dot={PRODUCTION_STATE_DOT[product.productionState]}
                >
                  {PRODUCTION_STATE_LABELS[product.productionState]}
                </InvBadge>
              </span>
            ) : null}
          </SheetTitle>
          <SheetDescription className="pt-1">
            合计 {total} 件{lastMovementAt ? ` · 最后变动 ${formatDateTime(lastMovementAt)}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4 scrollbar-hide">
          <section>
            <h4 className="mb-2 text-xs font-normal text-muted-foreground">档案信息</h4>
            <div className="grid grid-cols-3 gap-x-4 gap-y-3 rounded-lg border px-4 py-3 text-sm">
              {profile.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-0.5 truncate tabular-nums">{value ?? "—"}</div>
                </div>
              ))}
              <div className="col-span-3 min-w-0">
                <div className="text-xs text-muted-foreground">备注</div>
                <div className="mt-0.5 whitespace-pre-wrap break-words">
                  {product?.note ? product.note : "—"}
                </div>
              </div>
            </div>
          </section>

          {trend.length > 0 ? (
            <section>
              <h4 className="mb-2 text-xs font-normal text-muted-foreground">
                库存趋势（近 30 天 · 日快照）
              </h4>
              <TrendChart points={trend} />
            </section>
          ) : null}

          <section>
            <h4 className="mb-2 text-xs font-normal text-muted-foreground">当前库存</h4>
            <div className="rounded-lg border px-3 py-2 text-sm">
              <div className="text-lg font-normal tabular-nums">{total}</div>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-normal text-muted-foreground">最近变动（前 20 条）</h4>
            <div className="space-y-1.5">
              {(data?.ok ? data.movements : []).map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                >
                  <InvBadge className={MOVEMENT_TYPE_BADGE[m.type] ?? ""}>
                    {MOVEMENT_TYPE_LABELS[m.type] ?? m.type}
                  </InvBadge>
                  <span className="text-muted-foreground">{m.warehouseName}</span>
                  <span
                    className={`font-normal tabular-nums ${
                      m.qtyChange > 0 ? "text-emerald-600" : "text-red-600"
                    }`}
                  >
                    {m.qtyChange > 0 ? "+" : ""}
                    {m.qtyChange}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {m.qtyBefore}→{m.qtyAfter}
                  </span>
                  <span className="text-muted-foreground">{formatDateTime(m.createdAt)}</span>
                </div>
              ))}
              {data?.ok && data.movements.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无变动</p>
              ) : null}
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-xs font-normal text-muted-foreground">档案变更日志</h4>
            <div className="space-y-1.5">
              {(data?.ok ? data.logs : []).map((l) => {
                /** 条码预贴存 true/false 字符串，展示层转中文 */
                const fmtVal = (v: string | null) =>
                  l.field === "barcodePrePasted" && v != null
                    ? v === "true"
                      ? "已预贴"
                      : "未预贴"
                    : (v ?? "空")
                return (
                <div key={l.id} className="rounded-md border px-2.5 py-1.5 text-xs">
                  <span className="font-normal">{PRODUCT_FIELD_LABELS[l.field] ?? l.field}</span>
                  <span className="text-muted-foreground">
                    ：{fmtVal(l.oldValue)} → {fmtVal(l.newValue)}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {l.operator} · {formatDateTime(l.createdAt)}
                  </span>
                </div>
                )
              })}
              {data?.ok && data.logs.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无修改记录</p>
              ) : null}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

const TREND_CONFIG = { qty: { label: "库存", color: "var(--chart-1)" } } satisfies ChartConfig

function TrendChart({ points }: { points: Array<{ day: string; qty: number }> }) {
  return (
    <ChartContainer config={TREND_CONFIG} className="h-28 w-full">
      <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id="invTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="day" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip
          content={({ active, payload }) =>
            active && payload?.[0] ? (
              <div className="rounded-md border bg-popover px-2 py-1 text-xs">
                {payload[0].payload.day}：{payload[0].payload.qty} 件
              </div>
            ) : null
          }
        />
        <Area
          dataKey="qty"
          type="monotone"
          stroke="var(--chart-1)"
          strokeWidth={1.5}
          fill="url(#invTrendFill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
