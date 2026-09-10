import { requireSuperAdmin } from "@/lib/auth/session"
import { listPlatformsConfigAction } from "@/server/actions/platform-product-config"
import { PlatformFormDialog } from "@/components/superadmin/platform-config-dialogs"
import type { PlatformConfigRow } from "@/components/superadmin/platform-config-dialogs"
import { PlatformsConfigTable } from "@/components/superadmin/platforms-config-table"

export const dynamic = "force-dynamic"

export default async function ProductPlatformsConfigPage() {
  await requireSuperAdmin()
  const platforms = (await listPlatformsConfigAction()) as PlatformConfigRow[]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          用户选择平台后，生图按此处预配置的提示词组织；表空时回退内置常量
        </p>
        <PlatformFormDialog />
      </div>

      <PlatformsConfigTable platforms={platforms} />
    </div>
  )
}
