import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 数据任务（选品工具占位页，功能开发中）
 */
export default function SelectionTasksPage() {
  return (
    <ModuleComingSoon
      module="selection"
      moduleLabel="选品工具"
      title="数据任务"
      description="定制化数据抓取与推送任务。"
    />
  )
}
