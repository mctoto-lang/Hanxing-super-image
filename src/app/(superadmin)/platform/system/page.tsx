import { requireSuperAdmin } from "@/lib/auth/session"
import {
  getStorageSettingAction,
  getQueueSettingAction,
  getImageRetentionSettingAction,
} from "@/server/actions/platform-system"
import { SystemSettings } from "@/components/platform/system-settings"

export const dynamic = "force-dynamic"

export default async function PlatformSystemPage() {
  await requireSuperAdmin()

  const [storage, queue, retention] = await Promise.all([
    getStorageSettingAction(),
    getQueueSettingAction(),
    getImageRetentionSettingAction(),
  ])

  return (
    <SystemSettings
      initialStorage={storage}
      initialQueue={queue}
      initialRetention={retention}
    />
  )
}
