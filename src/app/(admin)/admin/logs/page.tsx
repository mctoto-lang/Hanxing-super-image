import Link from "next/link"
import { FileText, LogIn } from "lucide-react"
import { requireEnterpriseAdmin } from "@/lib/auth/session"
import {
  listTaskLogsAction,
  listLoginLogsAction,
} from "@/server/actions/admin-logs"
import { cn } from "@/lib/utils"
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
import { LogsTaskTable } from "@/components/admin/logs-task-table"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 20

/**
 * 操作日志：生图任务日志 + 登录审计（企业隔离）。
 *
 * Tab 与分页均由 URL 参数驱动（?tab=tasks|login&page=n），
 * 服务端按当前 Tab 取数；铺满内容区宽度（与其他管理页一致）。
 */
export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireEnterpriseAdmin()
  const sp = await searchParams
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab
  const tab = rawTab === "login" ? "login" : "tasks"
  const page = parsePageParam(sp)

  const tabs = [
    { value: "tasks", href: "/admin/logs?tab=tasks", label: "生图日志", icon: FileText },
    { value: "login", href: "/admin/logs?tab=login", label: "登录日志", icon: LogIn },
  ] as const

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">操作日志</h1>
        <p className="text-sm text-muted-foreground">
          生图任务日志与登录审计（企业隔离）
        </p>
      </div>

      {/* Tab（Link 驱动，样式对齐 shadcn Tabs） */}
      <div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
        {tabs.map((t) => (
          <Link
            key={t.value}
            href={t.href}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
              tab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "hover:text-foreground",
            )}
          >
            <t.icon className="size-4" />
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "tasks" ? <TasksSection page={page} /> : <LoginSection page={page} />}
    </div>
  )
}

async function TasksSection({ page }: { page: number }) {
  const { tasks, total } = await listTaskLogsAction({ page, pageSize: PAGE_SIZE })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">生图任务日志</CardTitle>
        <CardDescription>共 {total} 条任务记录</CardDescription>
      </CardHeader>
      <CardContent>
        <LogsTaskTable tasks={tasks} />
      </CardContent>
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/admin/logs"
        query={{ tab: "tasks" }}
      />
    </Card>
  )
}

async function LoginSection({ page }: { page: number }) {
  const { logs, total } = await listLoginLogsAction({ page, pageSize: PAGE_SIZE })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">登录审计日志</CardTitle>
        <CardDescription>共 {total} 条登录记录</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户名</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>失败原因</TableHead>
              <TableHead>时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-muted-foreground"
                >
                  暂无登录记录
                </TableCell>
              </TableRow>
            ) : (
              logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.username ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{l.ip}</TableCell>
                  <TableCell>
                    {l.success ? (
                      <Badge>成功</Badge>
                    ) : (
                      <Badge variant="destructive">失败</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.failureReason ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(l.createdAt).toLocaleString("zh-CN")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/admin/logs"
        query={{ tab: "login" }}
      />
    </Card>
  )
}
