import { Suspense } from "react"
import { requireUserContext } from "@/lib/auth/session"
import { listAvailableModelsAction } from "@/server/actions/create"
import {
  listConversationsAction,
  listConversationTasksAction,
} from "@/server/actions/conversations"
import { CreateApp } from "@/components/create/create-app"
import { type TaskDetail } from "@/components/create/task-detail-card"
import type { CreateModel } from "@/components/create/types"

export const dynamic = "force-dynamic"

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>
}) {
  const ctx = await requireUserContext()
  const [models, conversations, sp] = await Promise.all([
    listAvailableModelsAction(),
    listConversationsAction(),
    searchParams,
  ])

  // 预取当前选中会话的任务（仅当 URL c 指向一个真实存在的会话时）
  let conversationTasks: TaskDetail[] = []
  if (sp.c && conversations.some((x) => x.id === sp.c)) {
    const rows = await listConversationTasksAction(sp.c)
    conversationTasks = rows.map((r) => ({
      id: r.id,
      modelId: r.modelId,
      prompt: r.prompt,
      status: r.status,
      imageSize: r.imageSize,
      imageCount: r.imageCount,
      resultImages: (r.resultImages as string[] | null) ?? null,
      referenceImages: (r.referenceImages as string[] | null) ?? null,
      errorMessage: r.errorMessage,
      creditsCharged: r.creditsCharged,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      modelDisplayName: r.modelDisplayName,
      modelIconUrl: r.modelIconUrl,
    }))
  }

  return (
    // 绝对定位贴满 header 以下的工作区（相对 SidebarInset 的 relative）：
    // 高度天然确定，不参与外层 min-h-svh 的内容回撑，从根源消除页面级滚动条
    <div className="absolute inset-x-0 top-16 bottom-0">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            加载中…
          </div>
        }
      >
        <CreateApp
          models={models as CreateModel[]}
          conversations={conversations.map((c) => ({
            id: c.id,
            title: c.title,
            lastImageThumb: c.lastImageThumb,
            pinnedAt: c.pinnedAt,
            updatedAt: c.updatedAt,
          }))}
          conversationTasks={conversationTasks}
          userCredits={ctx.user.creditsBalance}
          enterpriseCredits={ctx.enterprise?.creditsBalance ?? 0}
        />
      </Suspense>
    </div>
  )
}
