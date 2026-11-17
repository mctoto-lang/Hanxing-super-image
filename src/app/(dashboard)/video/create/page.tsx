import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 视频创作（视频生成占位页，功能开发中）
 */
export default function VideoCreatePage() {
  return (
    <ModuleComingSoon
      module="video"
      moduleLabel="视频生成"
      title="视频创作"
      description="文生视频、图生视频，从提示词到成片一站完成。"
    />
  )
}
