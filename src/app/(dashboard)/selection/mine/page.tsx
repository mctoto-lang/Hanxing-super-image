import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 我的选品（选品工具占位页，功能开发中）
 */
export default function SelectionMinePage() {
  return (
    <ModuleComingSoon
      module="selection"
      moduleLabel="选品工具"
      title="我的选品"
      description="选品收藏、分组与跟进管理。"
    />
  )
}
