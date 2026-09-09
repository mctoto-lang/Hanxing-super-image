import { requireSuperAdmin } from "@/lib/auth/session"
import { getStorageSettingAction } from "@/server/actions/platform-system"
import { SystemSettings } from "@/components/platform/system-settings"

export const dynamic = "force-dynamic"

export default async function PlatformSystemPage() {
  await requireSuperAdmin()

  const storage = await getStorageSettingAction()

  return <SystemSettings initialStorage={storage} />
}
