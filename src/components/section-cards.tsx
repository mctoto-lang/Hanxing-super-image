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

/** dashboard-01 SectionCards：仅注入数据，标记与样式保持模板原样 */
export interface SectionCardData {
  label: string
  /** 已格式化的展示值 */
  value: string
  /** 环比百分比；null = 暂无环比（徽章显示"—"） */
  delta: number | null
  /** footer 首行文案（如 "较昨日增长 12.5%"）；null 显示"暂无环比数据" */
  footerLead: string | null
  /** footer 次行说明（可选，不传则不渲染该行） */
  footerSub?: string
}

export function SectionCards({ cards }: { cards: SectionCardData[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {cards.map((card) => {
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
            </CardHeader>
            <CardFooter className="flex-col items-start gap-1.5 text-sm">
              <div className="line-clamp-1 flex gap-2 font-medium">
                {card.footerLead ?? "暂无环比数据"}{" "}
                {TrendIcon && <TrendIcon className="size-4" />}
              </div>
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
