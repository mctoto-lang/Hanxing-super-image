import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { getInventoryOverviewAction } from "@/server/actions/inventory"
import { StockOverviewPanel } from "@/components/inventory/stock-overview-panel"
import { MovementPanel } from "@/components/inventory/movement-panel"
import { AnalysisPanel } from "@/components/inventory/analysis-panel"
import { ReplenishPanel } from "@/components/inventory/replenish-panel"
import { StockViewNav } from "@/components/inventory/stock-view-nav"
import {
  STOCK_VIEW_VALUES,
  type StockView,
} from "@/components/inventory/stock-views"

export const dynamic = "force-dynamic"

/**
 * 库存数据（原 /inventory?tab=stock 独立成页）
 *
 * 子视图走 URL ?view=（overview/movement/analysis/replenish），
 * 刷新/直链保持位置；总览首屏数据（顺带幂等补建期初仓）仅该视图拉取，
 * 其余视图客户端自拉。
 */

export default async function InventoryStockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("inventory")) {
    return (
      <NoPermission
        module="库存管理"
        description="当前企业未开通库存管理模块，请联系平台管理员在企业管理中启用。"
      />
    )
  }

  const sp = await searchParams
  const rawView = (Array.isArray(sp.view) ? sp.view[0] : sp.view) as string | undefined
  const view: StockView = STOCK_VIEW_VALUES.includes(rawView as StockView)
    ? (rawView as StockView)
    : "overview"
  // 分析页下钻预设状态筛选（六态；非法值忽略）
  const rawStatus = (Array.isArray(sp.status) ? sp.status[0] : sp.status) as string | undefined
  const STATUS_VALUES = [
    "normal",
    "restock",
    "out_of_stock",
    "stagnant",
    "discontinued",
    "clearance",
  ]
  const initialStatus = STATUS_VALUES.includes(rawStatus ?? "") ? rawStatus : undefined

  const overview = view === "overview" ? await getInventoryOverviewAction({}) : null

  return (
    <div className="absolute inset-x-0 top-16 bottom-0 flex flex-col overflow-y-auto p-4 scrollbar-hide">
      <StockViewNav view={view} />
      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        {view === "overview" ? (
          overview?.ok ? (
            <StockOverviewPanel
              initialRows={overview.rows}
              initialThresholdDays={overview.thresholdDays}
              initialStatus={initialStatus}
            />
          ) : (
            <p className="text-sm text-red-600">{overview?.error}</p>
          )
        ) : view === "movement" ? (
          <MovementPanel />
        ) : view === "analysis" ? (
          <AnalysisPanel />
        ) : (
          <ReplenishPanel />
        )}
      </div>
    </div>
  )
}
