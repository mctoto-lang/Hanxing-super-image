import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 我的作品（视频生成占位页，功能开发中）
 */
export default function VideoWorksPage() {
  return (
    <ModuleComingSoon
      module="video"
      moduleLabel="视频生成"
      title="我的作品"
      description="视频任务进度与成片统一管理。"
    />
  )
}
