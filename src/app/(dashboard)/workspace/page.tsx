import { requireUserContext } from "@/lib/auth/session"
import {
  listWorkspaceTasksAction,
  listWorkspaceModelsAction,
} from "@/server/actions/workspace"
import { WorkspaceClient } from "@/components/workspace/workspace-client"

export const dynamic = "force-dynamic"

export default async function WorkspacePage() {
  await requireUserContext()
  const [{ tasks }, models] = await Promise.all([
    listWorkspaceTasksAction({ pageSize: 30 }),
    listWorkspaceModelsAction(),
  ])

  return (
    <WorkspaceClient
      initialTasks={tasks}
      initialModels={models.map((m) => ({
        id: m.id,
        name: m.name,
        displayName: m.displayName,
        sizePresets: m.sizePresets,
        iconUrl: m.iconUrl,
        supportsReferenceImage: m.supportsReferenceImage,
        maxReferenceImages: m.maxReferenceImages,
        costPerImage: m.costPerImage,
      }))}
    />
  )
}
