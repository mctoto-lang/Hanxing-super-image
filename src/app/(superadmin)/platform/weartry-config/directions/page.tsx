import { requireSuperAdmin } from "@/lib/auth/session"
import { listDirectionsAction } from "@/server/actions/platform-product"
import { WeartryDirectionsConfig } from "@/components/superadmin/weartry-directions-config"
import type { DirectionRow } from "@/components/superadmin/direction-form-dialog"

export const dynamic = "force-dynamic"

export default async function WeartryDirectionsConfigPage() {
  await requireSuperAdmin()
  const directions = (await listDirectionsAction()) as unknown as DirectionRow[]
  return <WeartryDirectionsConfig directions={directions} />
}
