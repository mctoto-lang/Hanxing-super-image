import { requireUserContext } from "@/lib/auth/session"
import { listAssetsAction, listPinnedTasksAction } from "@/server/actions/assets"
import { ImageGallery } from "@/components/assets/image-gallery"

export const dynamic = "force-dynamic"

export default async function AssetsPage() {
  await requireUserContext()
  const [assets, pinned] = await Promise.all([
    listAssetsAction({ limit: 200 }),
    listPinnedTasksAction(),
  ])

  return (
    <ImageGallery
      items={assets.map((a) => ({
        taskId: a.id,
        prompt: a.prompt,
        images: (a.resultImages as string[] | null) ?? [],
        modelDisplayName: a.modelDisplayName ?? "样机渲染",
        source: a.source,
        createdAt: a.createdAt,
      }))}
      pinnedTasks={pinned.map((p) => ({ taskId: p.taskId, pinnedId: p.id }))}
    />
  )
}
