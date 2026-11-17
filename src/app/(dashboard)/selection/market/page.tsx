import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 市场分析（选品工具占位页，功能开发中）
 */
export default function SelectionMarketPage() {
  return (
    <ModuleComingSoon
      module="selection"
      moduleLabel="选品工具"
      title="市场分析"
      description="类目趋势与价格带深度分析。"
    />
  )
}
