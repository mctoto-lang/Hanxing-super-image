import { requireUserContext } from "@/lib/auth/session"
import { generationDurationMs } from "@/lib/utils"
import { listAssetsAction, listPinnedTasksAction } from "@/server/actions/assets"
import { ImageGallery } from "@/components/assets/image-gallery"

export const dynamic = "force-dynamic"

/** 图库首页任务页大小（后续页由 fetchAssetsPageAction 无限滚动追加） */
const PAGE_SIZE = 60

export default async function AssetsPage() {
  await requireUserContext()
  // 多取 1 条探测 hasMore：服务端分页突破原先一次性 200 条的硬上限
  const [rows, pinned] = await Promise.all([
    listAssetsAction({ limit: PAGE_SIZE + 1 }),
    listPinnedTasksAction(),
  ])
  const hasMore = rows.length > PAGE_SIZE
  const assets = rows.slice(0, PAGE_SIZE)

  return (
    <ImageGallery
      items={assets.map((a) => ({
        taskId: a.id,
        prompt: a.prompt,
        images: (a.resultImages as string[] | null) ?? [],
        modelDisplayName: a.modelDisplayName ?? "样机渲染",
        source: a.source,
        // 展示/筛选用完成时间（图片实际产出时刻），缺省回退提交时间
        createdAt: a.completedAt ?? a.createdAt,
        durationMs: generationDurationMs(a),
      }))}
      pinnedTasks={pinned.map((p) => ({ taskId: p.taskId, pinnedId: p.id }))}
      initialHasMore={hasMore}
    />
  )
}
