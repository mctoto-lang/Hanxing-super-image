import { requireSuperAdmin } from "@/lib/auth/session"
import { listEnterprisesAction } from "@/server/actions/platform"
import { listSubscriptionPlansAction } from "@/server/actions/platform-plans"
import { listPresetModelsAction } from "@/server/actions/platform-models"
import { listPresetChatModelsAction } from "@/server/actions/platform-chat-models"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"
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
import { PlanBadge } from "@/components/shared/plan-badge"
import { EnterpriseCreateDialog } from "@/components/superadmin/enterprise-create-dialog"
import { RechargeDialog } from "@/components/superadmin/recharge-dialog"
import { ModulesDialog } from "@/components/superadmin/modules-dialog"
import { MockupConfigDialog } from "@/components/superadmin/mockup-config-dialog"
import { EnterpriseModelConfigDialog } from "@/components/superadmin/enterprise-model-config-dialog"
import { EnterpriseConcurrencyDialog } from "@/components/superadmin/enterprise-concurrency-dialog"
import { PlanAssignDialog } from "@/components/superadmin/plan-assign-dialog"
import type { ModuleName } from "@/db/schema"

export const dynamic = "force-dynamic"

const MODULE_LABELS: Record<ModuleName, string> = {
  create: "创作",
  chat: "AI 对话",
  assets: "资产",
  workspace: "批量生图",
  product: "商品图片",
  weartry: "穿戴图片",
  mockup: "样机渲染",
  temu: "Temu 数据",
  settings: "设置",
}

export default async function EnterprisesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")

  const [
    { items: enterprises, total, pageSize },
    { items: presetModels, total: presetTotal },
    { items: presetChatModels },
    { items: plans },
  ] = await Promise.all([
    listEnterprisesAction({ page, pageSize: 20, q }),
    listPresetModelsAction({ pageSize: 100 }), // 企业模型配置弹窗全量下拉
    listPresetChatModelsAction({ pageSize: 100 }), // 对话模型白名单全量下拉
    listSubscriptionPlansAction(), // 分配套餐弹窗数据源（启用中套餐）
  ])
  // 可分配套餐 = 启用中的套餐（弹窗内按企业当前套餐自动并入续期选项）
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">企业管理</h1>
          <p className="text-sm text-muted-foreground">
            创建企业、配置模块开关、充值积分（D20：唯一创建入口）· 共 {total} 家企业
          </p>
        </div>
        <div className="flex items-center gap-2">
          <form action="/platform/enterprises" className="flex items-center gap-2">
            <Input
              name="q"
              defaultValue={q}
              placeholder="搜索企业名 / Slug"
              className="w-52"
            />
            <Button type="submit" variant="outline" size="sm">
              <Search className="size-3.5" />
              搜索
            </Button>
          </form>
          <EnterpriseCreateDialog />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">企业列表</CardTitle>
          <CardDescription>共 {total} 家企业</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>企业名称</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>订阅套餐</TableHead>
                <TableHead className="text-right">积分余额</TableHead>
                <TableHead>已开通模块</TableHead>
                <TableHead>自定义模型</TableHead>
                <TableHead>并发（生图/对话）</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enterprises.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {q ? `未找到与「${q}」匹配的企业` : "暂无企业，点击右上角创建"}
                  </TableCell>
                </TableRow>
              ) : null}
              {enterprises.map((e) => {
                const visible = (e.visiblePresetModels as string[]) ?? []
                const visibleChat = (e.visiblePresetChatModels as string[]) ?? []
                // 行内可分配选项：启用中套餐 + 当前套餐（可能已停用，仅供续期）
                const rowPlans =
                  e.planId && !assignablePlans.some((p) => p.id === e.planId)
                    ? [
                        ...assignablePlans,
                        {
                          id: e.planId,
                          name: e.planName ?? "",
                          iconKey: e.planIconKey ?? "medal",
                          color: e.planColor ?? "#8b5cf6",
                          creditsPerCycle: e.planCreditsPerCycle ?? 0,
                          cycleDays: e.planCycleDays ?? 30,
                          maxMembers: e.planMaxMembers ?? null,
                          isActive: false,
                        },
                      ]
                    : assignablePlans
                return (
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
                            到期{" "}
                            {new Date(e.planExpiresAt ?? "").toLocaleDateString("zh-CN")}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          免费版
                        </span>
                      )}
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
                    <TableCell>
                      <Badge variant={e.allowCustomModels ? "default" : "outline"}>
                        {e.allowCustomModels ? "允许" : "禁止"}
                      </Badge>
                      {visible.length > 0 ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          预置可见 {visible.length}/{presetTotal}
                        </span>
                      ) : (
                        <span className="ml-2 text-xs text-muted-foreground">
                          预置全部可见
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {e.maxConcurrent} / {e.chatMaxConcurrent}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
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
                        <RechargeDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                        />
                        <EnterpriseConcurrencyDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                          maxConcurrent={e.maxConcurrent}
                          chatMaxConcurrent={e.chatMaxConcurrent}
                        />
                        <ModulesDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                          currentModules={e.enabledModules as ModuleName[]}
                        />
                        <MockupConfigDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                        />
                        <EnterpriseModelConfigDialog
                          enterpriseId={e.id}
                          enterpriseName={e.name}
                          allowCustomModels={e.allowCustomModels}
                          visiblePresetModels={visible}
                          presetModels={presetModels}
                          visiblePresetChatModels={visibleChat}
                          presetChatModels={presetChatModels}
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
          query={{ q }}
        />
      </Card>
    </div>
  )
}
