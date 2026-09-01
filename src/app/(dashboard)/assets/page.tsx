import { requireUserContext } from "@/lib/auth/session"
import { listAssetsAction, listPinnedTasksAction } from "@/server/actions/assets"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { ImageGallery } from "@/components/assets/image-gallery"

export const dynamic = "force-dynamic"

export default async function AssetsPage() {
  const ctx = await requireUserContext()
  const [assets, pinned] = await Promise.all([
    listAssetsAction({ limit: 60 }),
    listPinnedTasksAction(),
  ])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">资产管理</h1>
        <p className="text-sm text-muted-foreground">
          跨来源图片画廊（{ctx.enterprise?.name}）· 全部图片 {assets.length} 张 · 收藏 {pinned.length} 张
        </p>
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">全部图片</TabsTrigger>
          <TabsTrigger value="pinned">收藏 ({pinned.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="mt-4">
          <ImageGallery
            items={assets.map((a) => ({
              taskId: a.id,
              prompt: a.prompt,
              images: (a.resultImages as string[] | null) ?? [],
              modelDisplayName: a.modelDisplayName ?? "样机渲染",
              source: a.source,
              createdAt: a.createdAt,
            }))}
            emptyHint="暂无生成图片，去创作页生成吧"
          />
        </TabsContent>
        <TabsContent value="pinned" className="mt-4">
          <ImageGallery
            items={pinned.map((p) => ({
              taskId: p.taskId,
              pinnedId: p.id,
              prompt: p.prompt ?? "",
              images: (p.resultImages as string[] | null) ?? [],
              modelDisplayName: p.modelDisplayName ?? "样机渲染",
              source: "create",
              createdAt: p.createdAt,
            }))}
            emptyHint="暂无收藏，点击图片收藏"
            isPinnedView
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
