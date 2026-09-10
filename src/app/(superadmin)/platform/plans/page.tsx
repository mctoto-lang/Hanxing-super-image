import { requireSuperAdmin } from "@/lib/auth/session"
import { listSubscriptionPlansAction } from "@/server/actions/platform-plans"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { PlanFormDialog } from "@/components/superadmin/plan-form-dialog"
import { PlansTable } from "@/components/superadmin/plans-table"

export const dynamic = "force-dynamic"

/**
 * 订阅套餐管理（超管）
 *
 * 套餐 = 名称 + 勋章（预设图标 + 颜色）+ 周期积分 + 周期天数 + 人数上限；
 * 分配给企业后在 /platform/enterprises 每行「分配套餐」操作，
 * 每周期自动把 creditsPerCycle 发放到企业积分池（worker subscriptionLoop）。
 */
export default async function SubscriptionPlansPage() {
  await requireSuperAdmin()
  const { items } = await listSubscriptionPlansAction()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">订阅套餐</h1>
          <p className="text-sm text-muted-foreground">
            配置企业套餐的勋章样式与每周期积分额度；分配入口在「企业管理」· 共{" "}
            {items.length} 个套餐
          </p>
        </div>
        <PlanFormDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">套餐列表</CardTitle>
          <CardDescription>
            成员侧边栏用户名旁与账户弹窗中会展示套餐勋章；停用后不可新分配，存量订阅履约至到期；顺序拖动行首手柄调整
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PlansTable items={items} />
        </CardContent>
      </Card>
    </div>
  )
}
