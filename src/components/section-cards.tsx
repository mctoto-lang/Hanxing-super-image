"use client"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { TrendingUpIcon, TrendingDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** dashboard-01 SectionCards：仅注入数据，标记与样式保持模板原样 */
export interface SectionCardData {
  label: string
  /** 已格式化的展示值 */
  value: string
  /** 环比百分比；null = 暂无环比（徽章显示"—"）；缺省 = 整卡无环比（不渲染徽章，
   *  footerLead 作为普通口径说明展示） */
  delta?: number | null
  /** footer 首行文案（如 "较昨日增长 12.5%"）；有环比时 null 显示"暂无环比数据" */
  footerLead?: string | null
  /** footer 次行说明（可选，不传则不渲染该行） */
  footerSub?: string
}

export function SectionCards({
  cards,
  className,
}: {
  cards: SectionCardData[]
  /** 追加容器类（tailwind-merge 覆盖默认栅格，如非 @container/main 布局的页面） */
  className?: string
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card",
        className,
      )}
    >
      {cards.map((card) => {
        const hasDelta = card.delta !== undefined
        const up = (card.delta ?? 0) >= 0
        const TrendIcon =
          card.delta == null ? null : up ? TrendingUpIcon : TrendingDownIcon
        return (
          <Card key={card.label} className="@container/card">
            <CardHeader>
              <CardDescription>{card.label}</CardDescription>
              <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
                {card.value}
              </CardTitle>
              {hasDelta && (
                <CardAction>
                  {TrendIcon ? (
                    <Badge variant="outline">
                      <TrendIcon />
                      {up ? "+" : "-"}
                      {Math.abs(card.delta ?? 0)}%
                    </Badge>
                  ) : (
                    <Badge variant="outline">—</Badge>
                  )}
                </CardAction>
              )}
            </CardHeader>
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              {hasDelta && (
                <div className="line-clamp-1 flex gap-2 font-medium">
                  {card.footerLead ?? "暂无环比数据"}{" "}
                  {TrendIcon && <TrendIcon className="size-4" />}
                </div>
              )}
              {!hasDelta && card.footerLead && (
                <div className="line-clamp-1 font-medium">{card.footerLead}</div>
              )}
              {card.footerSub && (
                <div className="text-muted-foreground">{card.footerSub}</div>
              )}
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}
