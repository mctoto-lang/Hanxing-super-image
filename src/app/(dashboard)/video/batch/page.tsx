import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 批量生成（视频生成占位页，功能开发中）
 */
export default function VideoBatchPage() {
  return (
    <ModuleComingSoon
      module="video"
      moduleLabel="视频生成"
      title="批量生成"
      description="多任务排队批量出片，效率翻倍。"
    />
  )
}
