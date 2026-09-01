import { requireEnterpriseContext } from "@/lib/auth/session"
import { listTransactionsAction } from "@/server/actions/credits"
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
import {
  TablePagination,
  parsePageParam,
} from "@/components/shared/table-pagination"

export const dynamic = "force-dynamic"

const TYPE_LABELS: Record<string, string> = {
  recharge: "充值",
  consumption: "消费",
  refund: "退款",
  adjustment: "调整",
  allocation: "分配下发",
  allocation_deduct: "个人消费",
  allocation_refund: "个人退还",
}

const TYPE_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  recharge: "default",
  consumption: "secondary",
  refund: "outline",
  adjustment: "outline",
  allocation: "secondary",
  allocation_deduct: "secondary",
  allocation_refund: "outline",
}

export default async function AdminCreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireEnterpriseContext()
  const page = parsePageParam(await searchParams)
  const { items: transactions, total, pageSize: actionPageSize } =
    await listTransactionsAction({ page, pageSize: 20 })

  // 统计：当前页 allocation_deduct 已消费累计（负数取绝对值作参考）
  const consumedByUsers = transactions
    .filter((t) => t.type === "allocation_deduct")
    .reduce((sum, t) => sum + Math.abs(t.amount), 0)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">积分流水</h1>
        <p className="text-sm text-muted-foreground">
          {ctx.enterprise?.name} · 企业积分池与分配流水（需求 3：池→个人配额两级）
        </p>
      </div>

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
              成员累计消费（当前页）
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
          <CardDescription>共 {total} 条（D8：企业共享积分池）</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">变动</TableHead>
                <TableHead className="text-right">变动后余额</TableHead>
                <TableHead>备注</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(t.createdAt).toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={TYPE_VARIANTS[t.type] ?? "outline"}>
                      {TYPE_LABELS[t.type] ?? t.type}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums font-medium ${
                      t.amount > 0 ? "text-emerald-500" : "text-destructive"
                    }`}
                  >
                    {t.amount > 0 ? "+" : ""}
                    {t.amount.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.balanceAfter.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.remark ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {transactions.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
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
        />
      </Card>
    </div>
  )
}
