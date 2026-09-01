import { requireSuperAdmin } from "@/lib/auth/session"
import { listWeartryScenesAdminAction } from "@/server/actions/platform-weartry"
import { ScenesConfig } from "@/components/superadmin/scenes-config"
import type { SceneRow } from "@/components/superadmin/scene-form-dialog"

export const dynamic = "force-dynamic"

export default async function WeartryScenesConfigPage() {
  await requireSuperAdmin()
  const scenes = (await listWeartryScenesAdminAction()) as unknown as SceneRow[]
  return <ScenesConfig scenes={scenes} />
}
