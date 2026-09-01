import { requireSuperAdmin } from "@/lib/auth/session"
import { listDirectionsAction } from "@/server/actions/platform-product"
import {
  DirectionsConfig,
} from "@/components/superadmin/directions-config"
import type { DirectionRow } from "@/components/superadmin/direction-form-dialog"

export const dynamic = "force-dynamic"

/**
 * 图片方向配置（二级分类：商品套图 / A+详情页 / 产品精修）
 *
 * 三个分类共用 product_direction 表但作用域单选互斥（每行恰属一个分类），
 * 配置彻底隔开，互不重复、互不影响。
 */
export default async function ProductDirectionsPage() {
  await requireSuperAdmin()
  const directions = (await listDirectionsAction()) as DirectionRow[]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">图片方向</h2>
        <p className="text-sm text-muted-foreground">
          按二级分类管理：商品套图 / A+详情页 / 产品精修；每个分类专属独立的方向池
        </p>
      </div>

      <DirectionsConfig directions={directions} />
    </div>
  )
}
