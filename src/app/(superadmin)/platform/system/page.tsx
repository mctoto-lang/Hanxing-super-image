import { requireSuperAdmin } from "@/lib/auth/session"
import { getStorageSettingAction } from "@/server/actions/platform-system"
import { SystemSettings } from "@/components/platform/system-settings"

export const dynamic = "force-dynamic"

export default async function PlatformSystemPage() {
  await requireSuperAdmin()
  // TEMU 应用凭证已改为企业级配置：超管 → 企业管理 → TEMU应用（platform.ts）
  const storage = await getStorageSettingAction()

  return <SystemSettings initialStorage={storage} />
}
