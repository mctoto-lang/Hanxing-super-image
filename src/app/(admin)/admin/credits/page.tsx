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

export const dynamic = "force-dynamic"

const TYPE_LABELS: Record<string, string> = {
  recharge: "充值",
  consumption: "消费",
  refund: "退款",
  adjustment: "调整",
}

const TYPE_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  recharge: "default",
  consumption: "secondary",
  refund: "outline",
  adjustment: "outline",
}

export default async function AdminCreditsPage() {
  const ctx = await requireEnterpriseContext()
  const transactions = await listTransactionsAction({ limit: 100 })

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">积分流水</h1>
        <p className="text-sm text-muted-foreground">
          {ctx.enterprise?.name} · 当前余额{" "}
          <strong className="tabular-nums">
            {ctx.enterprise?.creditsBalance.toLocaleString("zh-CN")}
          </strong>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">流水记录</CardTitle>
          <CardDescription>最近 100 条（D8：企业共享积分池）</CardDescription>
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
      </Card>
    </div>
  )
}
