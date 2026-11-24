"use client"

import { PageTabs } from "@/components/shared/page-tabs"
import { STOCK_VIEWS, type StockView } from "./stock-views"

/** 库存数据页二级视图导航（URL ?view= 驱动，刷新/直链保持；
 *  宽度自适应同全站页面级 tab 条：tab 条放不下即折叠为单 tab 下拉） */

export function StockViewNav({ view }: { view: StockView }) {
  return (
    <PageTabs
      tabs={STOCK_VIEWS.map((v) => ({
        value: v.value,
        label: v.label,
        href: `/inventory/stock?view=${v.value}`,
        icon: <v.icon className="size-4" />,
      }))}
      value={view}
    />
  )
}
