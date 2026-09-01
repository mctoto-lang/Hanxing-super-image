import { requireSuperAdmin } from "@/lib/auth/session"
import {
  getStorageSettingAction,
  getQueueSettingAction,
} from "@/server/actions/platform-system"
import { SystemSettings } from "@/components/platform/system-settings"

export const dynamic = "force-dynamic"

export default async function PlatformSystemPage() {
  await requireSuperAdmin()

  const [storage, queue] = await Promise.all([
    getStorageSettingAction(),
    getQueueSettingAction(),
  ])

  return <SystemSettings initialStorage={storage} initialQueue={queue} />
}
