import Link from "next/link"
import { requireSuperAdmin } from "@/lib/auth/session"
import { listEnterprisesAction } from "@/server/actions/platform"
import { listSubscriptionPlansAction } from "@/server/actions/platform-plans"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TablePagination,
  parsePageParam,
  parseQueryParam,
} from "@/components/shared/table-pagination"
import { TableEmpty } from "@/components/shared/table-empty"
import { formatDate } from "@/lib/datetime"
import { PlanBadge } from "@/components/shared/plan-badge"
import { EnterpriseCreateDialog } from "@/components/superadmin/enterprise-create-dialog"
import { RechargeDialog } from "@/components/superadmin/recharge-dialog"
import { PlanAssignDialog } from "@/components/superadmin/plan-assign-dialog"
import { ModulesDialog } from "@/components/superadmin/modules-dialog"
import { EnterpriseFilterBar } from "@/components/superadmin/enterprise-filter-bar"
import type { ModuleName } from "@/db/schema"

export const dynamic = "force-dynamic"

/** 排序白名单（与 listEnterprisesAction / EnterpriseFilterBar 的 sort 入参一致） */
const SORT_VALUES = ["createdAt_desc", "createdAt_asc", "credits_desc"] as const

export default async function EnterprisesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")
  const status = parseQueryParam(sp, "status")
  const plan = parseQueryParam(sp, "plan")
  const sortParam = parseQueryParam(sp, "sort")
  const sort = (
    (SORT_VALUES as readonly string[]).includes(sortParam) ? sortParam : "createdAt_desc"
  ) as (typeof SORT_VALUES)[number]

  const [{ items: enterprises, total, pageSize }, { items: plans }] =
    await Promise.all([
      listEnterprisesAction({
        page,
        pageSize: 20,
        q,
        status: status === "active" || status === "suspended" ? status : undefined,
        planId: plan || undefined,
        sort,
      }),
      listSubscriptionPlansAction(), // 套餐筛选下拉（含停用套餐，便于筛查存量）
    ])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">企业管理</h1>
          <p className="text-sm text-muted-foreground">
            创建企业、配置模块开关、充值积分（D20：唯一创建入口）· 共 {total} 家企业
          </p>
        </div>
        <EnterpriseCreateDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">企业列表</CardTitle>
          <CardDescription>
            点击企业名称进入详情页，集中管理套餐 / 成员 / 积分流水与各项配置
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 筛选条（客户端组件）：shadcn Select 选中即提交，h-8 齐高 */}
          <EnterpriseFilterBar
            q={q}
            status={status}
            plan={plan}
            sort={sort}
            plans={plans.map((p) => ({ id: p.id, name: p.name }))}
          />

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>企业名称</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>订阅套餐</TableHead>
                <TableHead>积分余额</TableHead>
                <TableHead>成员</TableHead>
                <TableHead>累计任务</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enterprises.length === 0 ? (
                <TableEmpty
                  colSpan={8}
                  noun="企业"
                  filtered={!!(q || status || plan)}
                />
              ) : null}
              {enterprises.map((e) => {
                const suspended = e.status !== "active"
                // 行内可分配选项：启用中套餐 + 当前套餐（可能已停用，仅供续期）
                const rowPlans = plans
                  .filter((p) => p.isActive)
                  .map((p) => ({
                    id: p.id,
                    name: p.name,
                    iconKey: p.iconKey,
                    color: p.color,
                    creditsPerCycle: p.creditsPerCycle,
                    cycleDays: p.cycleDays,
                    maxMembers: p.maxMembers,
                    isActive: p.isActive,
                  }))
                if (e.planId && !rowPlans.some((p) => p.id === e.planId)) {
                  rowPlans.push({
                    id: e.planId,
                    name: e.planName ?? "",
                    iconKey: e.planIconKey ?? "medal",
                    color: e.planColor ?? "#8b5cf6",
                    creditsPerCycle: e.planCreditsPerCycle ?? 0,
                    cycleDays: e.planCycleDays ?? 30,
                    maxMembers: e.planMaxMembers ?? null,
                    isActive: false,
                  })
                }
                return (
                  <TableRow key={e.id} className={suspended ? "opacity-60" : undefined}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/platform/enterprises/${e.id}`}
                        className="hover:underline"
                      >
                        {e.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.slug}</TableCell>
                    <TableCell>
                      <Badge variant={suspended ? "destructive" : "default"}>
                        {suspended ? "已停用" : "正常"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {e.planId && e.planName ? (
                        <div className="space-y-0.5">
                          <PlanBadge
                            iconKey={e.planIconKey}
                            color={e.planColor}
                            name={e.planName}
                            isExpired={e.planIsExpired}
                            size="sm"
                          />
                          <div className="text-xs text-muted-foreground">
                            到期 {formatDate(e.planExpiresAt)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          免费版
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {e.creditsBalance.toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {e.memberCount}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {e.taskCount}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          nativeButton={false}
                          render={<Link href={`/platform/enterprises/${e.id}`} />}
                        >
                          详情
                        </Button>
                        <ModulesDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                          currentModules={e.enabledModules as ModuleName[]}
                        />
                        <RechargeDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                        />
                        <PlanAssignDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                          current={
                            e.planId && e.planName
                              ? {
                                  planId: e.planId,
                                  planName: e.planName,
                                  iconKey: e.planIconKey ?? "medal",
                                  color: e.planColor ?? "#8b5cf6",
                                  expiresAt: e.planExpiresAt ?? "",
                                  isExpired: e.planIsExpired,
                                }
                              : null
                          }
                          plans={rowPlans}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/platform/enterprises"
          query={{ q, status, plan, sort }}
        />
      </Card>
    </div>
  )
}
