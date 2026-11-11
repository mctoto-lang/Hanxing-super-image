import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Building2 } from "lucide-react"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  getEnterpriseDetailAction,
  listEnterpriseMembersAction,
  listEnterpriseTransactionsAction,
  listEnterpriseGroupsAction,
} from "@/server/actions/platform"
import { listSubscriptionPlansAction } from "@/server/actions/platform-plans"
import { listPresetModelsAction } from "@/server/actions/platform-models"
import { listPresetChatModelsAction } from "@/server/actions/platform-chat-models"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
} from "@/components/shared/table-pagination"
import { TableEmpty } from "@/components/shared/table-empty"
import { StatCard } from "@/components/shared/stat-card"
import { PlanBadge } from "@/components/shared/plan-badge"
import { roleLabel } from "@/lib/auth/permissions"
import { formatDateTime, formatDate } from "@/lib/datetime"
import type { ModuleName } from "@/db/schema"
import { EnterpriseEditDialog } from "@/components/superadmin/enterprise-edit-dialog"
import { EnterpriseStatusDialog } from "@/components/superadmin/enterprise-status-dialog"
import { EnterpriseMemberCreateDialog } from "@/components/superadmin/enterprise-member-create-dialog"
import { RechargeDialog } from "@/components/superadmin/recharge-dialog"
import { PlanAssignDialog } from "@/components/superadmin/plan-assign-dialog"
import { EnterpriseConcurrencyDialog } from "@/components/superadmin/enterprise-concurrency-dialog"
import { ModulesDialog } from "@/components/superadmin/modules-dialog"
import { MockupConfigDialog } from "@/components/superadmin/mockup-config-dialog"
import { TemuAppConfigDialog } from "@/components/superadmin/temu-app-config-dialog"
import { EnterpriseModelConfigDialog } from "@/components/superadmin/enterprise-model-config-dialog"

export const dynamic = "force-dynamic"

const TX_TYPE_LABELS: Record<string, string> = {
  recharge: "充值",
  consumption: "消费",
  refund: "退款",
  adjustment: "调整",
  allocation: "分配下发",
  allocation_deduct: "个人消费",
  allocation_refund: "个人退还",
  plan_grant: "套餐发放",
}

export default async function EnterpriseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const { id } = await params
  const sp = await searchParams
  const page = parsePageParam(sp)

  const detail = await getEnterpriseDetailAction(id)
  if (!detail) notFound()

  const [
    { items: members, total: memberTotal, pageSize: memberPageSize },
    { items: transactions },
    { items: groups },
    { items: presetModels, total: presetTotal },
    { items: presetChatModels },
    { items: plans },
  ] = await Promise.all([
    listEnterpriseMembersAction({ enterpriseId: id, page, pageSize: 20 }),
    listEnterpriseTransactionsAction({ enterpriseId: id, pageSize: 10 }),
    listEnterpriseGroupsAction(id),
    listPresetModelsAction({ pageSize: 100 }),
    listPresetChatModelsAction({ pageSize: 100 }),
    listSubscriptionPlansAction(),
  ])

  const suspended = detail.status !== "active"
  const visible = (detail.visiblePresetModels as string[]) ?? []
  const visibleChat = (detail.visiblePresetChatModels as string[]) ?? []

  // 可分配套餐 = 启用中套餐 + 当前套餐（可能已停用，仅供续期）
  const assignablePlans = plans
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
  const currentPlan =
    detail.planId && detail.planName
      ? {
          planId: detail.planId,
          planName: detail.planName,
          iconKey: detail.planIconKey ?? "medal",
          color: detail.planColor ?? "#8b5cf6",
          expiresAt: detail.planExpiresAt ?? "",
          isExpired: detail.planIsExpired,
        }
      : null
  if (
    detail.planId &&
    !assignablePlans.some((p) => p.id === detail.planId)
  ) {
    assignablePlans.push({
      id: detail.planId,
      name: detail.planName ?? "",
      iconKey: detail.planIconKey ?? "medal",
      color: detail.planColor ?? "#8b5cf6",
      creditsPerCycle: detail.planCreditsPerCycle ?? 0,
      cycleDays: detail.planCycleDays ?? 30,
      maxMembers: detail.planMaxMembers ?? null,
      isActive: false,
    })
  }

  return (
    <div className="space-y-4">
      {/* 顶部：返回 + 企业标识 + 生命周期操作 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回企业列表"
            nativeButton={false}
            render={<Link href="/platform/enterprises" />}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Avatar className="size-10">
            <AvatarImage src={detail.logoUrl ?? undefined} alt={detail.name} />
            <AvatarFallback>
              <Building2 className="size-4 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{detail.name}</h1>
              <Badge variant={suspended ? "destructive" : "default"}>
                {suspended ? "已停用" : "正常"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              slug：<span className="font-mono">{detail.slug}</span> · 创建于{" "}
              {formatDateTime(detail.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <EnterpriseEditDialog
            enterpriseId={detail.id}
            enterpriseName={detail.name}
            slug={detail.slug}
            logoUrl={detail.logoUrl}
            size="default"
          />
          <EnterpriseStatusDialog
            enterpriseId={detail.id}
            enterpriseName={detail.name}
            status={detail.status}
            size="default"
          />
        </div>
      </div>

      {/* 概要区 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="积分余额" variant="compact">
          {detail.creditsBalance.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard label="订阅套餐" variant="compact">
          {detail.planId && detail.planName ? (
            <PlanBadge
              iconKey={detail.planIconKey}
              color={detail.planColor}
              name={detail.planName}
              isExpired={detail.planIsExpired}
              size="sm"
            />
          ) : (
            "免费版"
          )}
          {detail.planExpiresAt ? (
            <p className="mt-0.5 text-xs font-normal text-muted-foreground">
              到期 {formatDate(detail.planExpiresAt)}
            </p>
          ) : null}
        </StatCard>
        <StatCard label="成员数" variant="compact">
          {detail.memberCount}
        </StatCard>
        <StatCard label="累计生图任务" variant="compact">
          {detail.taskCount}
        </StatCard>
        <StatCard label="并发（生图/对话）" variant="compact">
          {detail.maxConcurrent} / {detail.chatMaxConcurrent}
        </StatCard>
      </div>

      {/* 成员管理区 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">成员（{memberTotal}）</CardTitle>
          <CardDescription>
            企业内全部账号；owner 由超管在此创建或指定
          </CardDescription>
          <CardAction>
            <EnterpriseMemberCreateDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
              groups={groups}
            />
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>权限组</TableHead>
                <TableHead>个人配额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近登录</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 ? (
                <TableEmpty colSpan={6} noun="成员" />
              ) : null}
              {members.map((m) => {
                const initials = (m.name || m.username)
                  .slice(0, 1)
                  .toUpperCase()
                return (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-8">
                          <AvatarImage
                            src={m.image ?? undefined}
                            alt={m.name ?? m.username}
                          />
                          <AvatarFallback className="text-xs">
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="font-mono text-sm">{m.username}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {m.name}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          m.enterpriseRole === "owner"
                            ? "default"
                            : m.enterpriseRole === "admin"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {roleLabel(m.enterpriseRole)}
                      </Badge>
                    </TableCell>
                    <TableCell>{m.groupName ?? "—"}</TableCell>
                    <TableCell className="tabular-nums font-medium">
                      {m.creditsBalance.toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={m.status === "active" ? "default" : "destructive"}
                      >
                        {m.status === "active" ? "正常" : "禁用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(m.lastLoginAt)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={memberPageSize}
          total={memberTotal}
          basePath={`/platform/enterprises/${detail.id}`}
        />
      </Card>

      {/* 积分流水区 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">积分流水</CardTitle>
          <CardDescription>最新 {transactions.length} 条变动记录</CardDescription>
          <CardAction>
            <RechargeDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
            />
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>变动</TableHead>
                <TableHead>变动后余额</TableHead>
                <TableHead>触发者</TableHead>
                <TableHead>备注</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.length === 0 ? (
                <TableEmpty colSpan={6} noun="流水" />
              ) : null}
              {transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(t.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {TX_TYPE_LABELS[t.type] ?? t.type}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={`tabular-nums font-medium ${
                      t.amount >= 0 ? "text-emerald-600" : "text-destructive"
                    }`}
                  >
                    {t.amount >= 0 ? "+" : ""}
                    {t.amount.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {t.balanceAfter.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-sm">{t.userName ?? "—"}</TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                    {t.remark ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 配置区：列表行原有 7 个弹窗全部集中于此 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">企业配置</CardTitle>
          <CardDescription>
            套餐 / 充值 / 并发 / 模块开关 / 样机服务 / TEMU 凭证 / 模型权限
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <PlanAssignDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
              current={currentPlan}
              plans={assignablePlans}
            />
            <RechargeDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
            />
            <EnterpriseConcurrencyDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
              maxConcurrent={detail.maxConcurrent}
              chatMaxConcurrent={detail.chatMaxConcurrent}
            />
            <ModulesDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
              currentModules={detail.enabledModules as ModuleName[]}
            />
            <MockupConfigDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
            />
            <TemuAppConfigDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
            />
            <EnterpriseModelConfigDialog
              enterpriseId={detail.id}
              enterpriseName={detail.name}
              allowCustomModels={detail.allowCustomModels}
              visiblePresetModels={visible}
              presetModels={presetModels}
              visiblePresetChatModels={visibleChat}
              presetChatModels={presetChatModels}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            模块开关含 TEMU 总开关与页面级子权限；样机 / TEMU 凭证均加密存储。
            当前预置生图模型可见 {visible.length > 0 ? `${visible.length}/${presetTotal}` : `全部 ${presetTotal}`}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
