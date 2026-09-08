import { requireSuperAdmin } from "@/lib/auth/session"
import { listSubscriptionPlansAction } from "@/server/actions/platform-plans"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PlanBadge } from "@/components/shared/plan-badge"
import {
  PlanEditButton,
  PlanFormDialog,
} from "@/components/superadmin/plan-form-dialog"
import { PlanToggleButton } from "@/components/superadmin/plan-toggle-button"

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
            成员侧边栏用户名旁与账户弹窗中会展示套餐勋章；停用后不可新分配，存量订阅履约至到期
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>套餐 / 勋章</TableHead>
                <TableHead className="text-right">每周期积分</TableHead>
                <TableHead className="text-right">周期</TableHead>
                <TableHead className="text-right">人数上限</TableHead>
                <TableHead className="text-right">使用企业</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    暂无套餐，点击右上角新建
                  </TableCell>
                </TableRow>
              ) : null}
              {items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <PlanBadge
                        iconKey={p.iconKey}
                        color={p.color}
                        name={p.name}
                        size="md"
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.creditsPerCycle.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.cycleDays} 天
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.maxMembers ? `${p.maxMembers} 人` : "不限"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.enterpriseCount}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.isActive ? "default" : "outline"}>
                      {p.isActive ? "启用" : "已停用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <PlanEditButton
                        plan={{
                          id: p.id,
                          name: p.name,
                          iconKey: p.iconKey,
                          color: p.color,
                          creditsPerCycle: p.creditsPerCycle,
                          cycleDays: p.cycleDays,
                          maxMembers: p.maxMembers,
                          sortOrder: p.sortOrder,
                          isActive: p.isActive,
                        }}
                      />
                      <PlanToggleButton
                        planId={p.id}
                        planName={p.name}
                        isActive={p.isActive}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
