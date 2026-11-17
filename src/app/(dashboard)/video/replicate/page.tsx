import { ModuleComingSoon } from "@/components/shared/module-coming-soon"

export const dynamic = "force-dynamic"

/**
 * 视频复刻（视频生成占位页，功能开发中）
 */
export default function VideoReplicatePage() {
  return (
    <ModuleComingSoon
      module="video"
      moduleLabel="视频生成"
      title="视频复刻"
      description="上传参考视频，一键复刻同款运镜与节奏。"
    />
  )
}
