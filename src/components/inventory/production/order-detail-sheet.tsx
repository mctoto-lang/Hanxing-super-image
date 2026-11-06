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
import { getProductionOrderDetailAction } from "@/server/actions/inventory-production"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/datetime"
import { InvBadge } from "../inv-badge"
import {
  MOVEMENT_TYPE_BADGE,
  MOVEMENT_TYPE_LABELS,
  PRODUCTION_STATUS_BADGE,
  PRODUCTION_STATUS_DOT,
  PRODUCTION_STATUS_LABELS,
} from "../labels"

/** 生产单详情右抽屉（对齐货号详情抽屉模板：border-b 头部 + 滚动体分区）：
 *  直发记录 + 入库/直发流水（含冲正） */

export function OrderDetailSheet({
  orderId,
  onOpenChange,
}: {
  orderId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = React.useState<Awaited<
    ReturnType<typeof getProductionOrderDetailAction>
  > | null>(null)
  const [, startLoad] = React.useTransition()

  React.useEffect(() => {
    if (!orderId) {
      setData(null)
      return
    }
    startLoad(async () => {
      const r = await getProductionOrderDetailAction(orderId)
      if (r.ok) setData(r)
      else toast.error(r.error)
    })
  }, [orderId])

  const order = data?.ok ? data.order : null
  const remain = order ? order.quantity - order.directQty - order.shippedQty : 0

  return (
    <Sheet open={Boolean(orderId)} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-[520px]"
        overlayBlur={false}
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2.5">
            {data?.ok && data.product.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.product.imageUrl}
                alt=""
                className="size-12 shrink-0 rounded-md object-cover"
              />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-normal">
                {data?.ok ? data.product.productCode : ""}
              </span>
              <span className="block truncate text-sm font-normal text-muted-foreground">
                {data?.ok ? data.product.name : ""}
              </span>
            </span>
            {order ? (
              <InvBadge
                className={cn("shrink-0", PRODUCTION_STATUS_BADGE[order.status])}
                dot={PRODUCTION_STATUS_DOT[order.status]}
              >
                {PRODUCTION_STATUS_LABELS[order.status]}
              </InvBadge>
            ) : null}
          </SheetTitle>
          <SheetDescription className="pt-1">
            {order
              ? `${data?.ok ? data.factory.code : ""} · 数量 ${order.quantity} · 直发 ${order.directQty} · 入库 ${order.shippedQty} · 余量 ${remain}`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4 scrollbar-hide">
          <section>
            <h4 className="mb-2 text-xs font-normal text-muted-foreground">直发记录</h4>
            <div className="space-y-1.5">
              {(data?.ok ? data.ships : []).map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                >
                  <span>{s.shipDate}</span>
                  <span>{s.destType === "temu" ? "TEMU 直发" : "直发自有仓"}</span>
                  <span className="font-normal tabular-nums">{s.qty} 件</span>
                  <span className="text-muted-foreground">箱 {s.boxQty ?? "—"}</span>
                  <span className="text-muted-foreground">{s.temuRef ?? s.note ?? ""}</span>
                </div>
              ))}
              {data?.ok && data.ships.length === 0 ? (
                <p className="text-xs text-muted-foreground">无直发记录</p>
              ) : null}
            </div>
          </section>
          <section>
            <h4 className="mb-2 text-xs font-normal text-muted-foreground">
              入库/直发流水（含冲正）
            </h4>
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
                    className={cn(
                      "font-normal tabular-nums",
                      m.qtyChange > 0 ? "text-emerald-600" : "text-red-600",
                    )}
                  >
                    {m.qtyChange > 0 ? "+" : ""}
                    {m.qtyChange}
                  </span>
                  <span className="text-muted-foreground">{formatDateTime(m.createdAt)}</span>
                </div>
              ))}
              {data?.ok && data.movements.length === 0 ? (
                <p className="text-xs text-muted-foreground">无流水</p>
              ) : null}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
