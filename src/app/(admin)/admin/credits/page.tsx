import { requireEnterpriseContext } from "@/lib/auth/session"
import { listTransactionsAction } from "@/server/actions/credits"
import {
  Card,
  CardAction,
  CardContent,
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
import {
  TablePagination,
  parsePageParam,
  parseQueryParam,
} from "@/components/shared/table-pagination"
import { AdminListFilters } from "@/components/admin/admin-list-filters"
import {
  CREDIT_MODULE_OPTIONS,
  MODULE_LABELS,
  filterQuery,
} from "@/lib/admin/table-filters"

export const dynamic = "force-dynamic"

const TYPE_LABELS: Record<string, string> = {
  recharge: "充值",
  consumption: "消费",
  refund: "退款",
  adjustment: "调整",
  allocation: "分配下发",
  allocation_deduct: "个人消费",
  allocation_refund: "个人退还",
  plan_grant: "套餐发放",
}

const TYPE_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  recharge: "default",
  consumption: "secondary",
  refund: "outline",
  adjustment: "outline",
  allocation: "secondary",
  allocation_deduct: "secondary",
  allocation_refund: "outline",
  plan_grant: "default",
}

/** 模块列：source（生图任务）→ 中文；备注前缀识别 AI 对话；其余显示 — */
function moduleLabelOf(t: { source: string | null; remark: string | null }): string {
  if (t.source) return MODULE_LABELS[t.source] ?? t.source
  if (t.remark?.startsWith("AI 对话")) return "AI 对话"
  return "—"
}

export default async function AdminCreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireEnterpriseContext()
  const sp = await searchParams
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")
  const moduleFilter = parseQueryParam(sp, "module")
  const from = parseQueryParam(sp, "from")
  const to = parseQueryParam(sp, "to")
  const { items: transactions, total, pageSize: actionPageSize } =
    await listTransactionsAction({
      page,
      pageSize: 20,
      q,
      module: moduleFilter,
      from,
      to,
    })

  // 统计：当前页 allocation_deduct 已消费累计（负数取绝对值作参考）
  const consumedByUsers = transactions
    .filter((t) => t.type === "allocation_deduct")
    .reduce((sum, t) => sum + Math.abs(t.amount), 0)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              企业积分池余额
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {ctx.enterprise?.creditsBalance.toLocaleString("zh-CN")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              我的个人配额
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {ctx.user.creditsBalance.toLocaleString("zh-CN")}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              本页成员消费合计
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {consumedByUsers.toLocaleString("zh-CN")}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">流水记录</CardTitle>
          <CardAction>
            <AdminListFilters
              basePath="/admin/credits"
              q={q}
              module={moduleFilter}
              from={from}
              to={to}
              moduleOptions={CREDIT_MODULE_OPTIONS}
            />
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>模块</TableHead>
                <TableHead>明细</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">积分消耗</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    {t.userName ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {moduleLabelOf(t)}
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate text-sm text-muted-foreground">
                    {t.remark ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANTS[t.type] ?? "outline"}>
                      {TYPE_LABELS[t.type] ?? t.type}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium tabular-nums ${
                      t.amount > 0 ? "text-emerald-500" : "text-destructive"
                    }`}
                  >
                    {t.amount > 0 ? "+" : ""}
                    {t.amount.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(t.createdAt).toLocaleString("zh-CN")}
                  </TableCell>
                </TableRow>
              ))}
              {transactions.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    暂无流水记录
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={actionPageSize}
          total={total}
          basePath="/admin/credits"
          query={filterQuery({ q, module: moduleFilter, from, to })}
        />
      </Card>
    </div>
  )
}
