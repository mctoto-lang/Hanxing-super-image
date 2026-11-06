import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { ProductionPanel } from "@/components/inventory/production-panel"

export const dynamic = "force-dynamic"

/**
 * 生产规划（原 /inventory?tab=production 独立成页）
 *
 * 全渠道一套库存（主仓/义乌仓混计），与飞书多维表格完全独立；
 * TEMU 装箱发货硬阻断联动见发货 tab（批次4 接入）。
 */

export default async function InventoryProductionPage() {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("inventory")) {
    return (
      <NoPermission
        module="库存管理"
        description="当前企业未开通库存管理模块，请联系平台管理员在企业管理中启用。"
      />
    )
  }

  return (
    <div className="absolute inset-x-0 top-16 bottom-0 flex flex-col overflow-y-auto p-4 scrollbar-hide">
      <ProductionPanel />
    </div>
  )
}
