import { requireSuperAdmin } from "@/lib/auth/session"
import { listEnterprisesAction } from "@/server/actions/platform"
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
import { EnterpriseCreateDialog } from "@/components/superadmin/enterprise-create-dialog"
import { RechargeDialog } from "@/components/superadmin/recharge-dialog"
import { ModulesDialog } from "@/components/superadmin/modules-dialog"
import type { ModuleName } from "@/db/schema"

export const dynamic = "force-dynamic"

const MODULE_LABELS: Record<ModuleName, string> = {
  create: "创作",
  assets: "资产",
  workspace: "批量生图",
  product: "商品主图",
  settings: "设置",
}

export default async function EnterprisesPage() {
  await requireSuperAdmin()
  const enterprises = await listEnterprisesAction()

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">企业管理</h1>
          <p className="text-sm text-muted-foreground">
            创建企业、配置模块开关、充值积分（D20：唯一创建入口）
          </p>
        </div>
        <EnterpriseCreateDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">企业列表</CardTitle>
          <CardDescription>共 {enterprises.length} 家企业</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>企业名称</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">积分余额</TableHead>
                <TableHead>已开通模块</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enterprises.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.name}</TableCell>
                  <TableCell className="font-mono text-xs">{e.slug}</TableCell>
                  <TableCell>
                    <Badge
                      variant={e.status === "active" ? "default" : "destructive"}
                    >
                      {e.status === "active" ? "正常" : "已停用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.creditsBalance.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(e.enabledModules as ModuleName[]).map((m) => (
                        <Badge key={m} variant="outline" className="text-xs">
                          {MODULE_LABELS[m] ?? m}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <RechargeDialog
                        enterpriseId={e.id}
                        enterpriseName={e.name}
                      />
                      <ModulesDialog
                        enterpriseId={e.id}
                        enterpriseName={e.name}
                        currentModules={e.enabledModules as ModuleName[]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {enterprises.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    暂无企业，点击右上角创建
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
