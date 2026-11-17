import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 带货视频（视频生成占位页，功能开发中）
 */
export default function VideoCommercePage() {
  return (
    <ModuleComingSoon
      module="video"
      moduleLabel="视频生成"
      title="带货视频"
      description="商品素材一键生成电商带货短视频。"
    />
  )
}
