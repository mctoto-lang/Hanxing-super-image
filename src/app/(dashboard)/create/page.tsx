import { requireUserContext } from "@/lib/auth/session"
import { listAvailableModelsAction } from "@/server/actions/create"
import { CreateWorkspace } from "@/components/create/create-workspace"
import { HistoryList } from "@/components/create/history-list"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

export const dynamic = "force-dynamic"

export default async function CreatePage() {
  const ctx = await requireUserContext()
  const models = await listAvailableModelsAction()
  const creditsBalance = ctx.enterprise?.creditsBalance ?? 0

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="border-b px-4 py-3">
        <h1 className="text-xl font-bold">创作</h1>
        <p className="text-sm text-muted-foreground">
          统一 AI 创作页（合并自由创作与项目创作，单一积分计费）
        </p>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        <ResizablePanel defaultSize={65} minSize={40}>
          <div className="h-full overflow-auto p-4">
            <div className="mx-auto max-w-3xl">
              <CreateWorkspace models={models} creditsBalance={creditsBalance} />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={35} minSize={20}>
          <HistoryList />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
