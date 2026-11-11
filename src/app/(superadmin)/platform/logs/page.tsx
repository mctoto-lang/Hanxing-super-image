import Link from "next/link"
import { FileText, LogIn } from "lucide-react"
import { requireSuperAdmin } from "@/lib/auth/session"
import { formatDateTime } from "@/lib/datetime"
import {
  listAllTaskLogsAction,
  listAllLoginLogsAction,
} from "@/server/actions/platform-logs"
import { cn } from "@/lib/utils"
import {
  Card,
  CardAction,
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
  parseQueryParam,
} from "@/components/shared/table-pagination"
import { PlatformLogsTaskTable } from "@/components/superadmin/platform-logs-table"
import { AdminListFilters } from "@/components/admin/admin-list-filters"
import { TASK_SOURCE_OPTIONS, filterQuery } from "@/lib/admin/table-filters"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 20

/**
 * 平台全量日志（超管）：生图任务日志 + 登录审计，全平台视角（无企业
 * 过滤，行附归属企业）。结构对齐企业侧 /admin/logs（Tab / 筛选 / 分页
 * 均由 URL 参数驱动），只读口径。
 */
export default async function PlatformLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const sp = await searchParams
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab
  const tab = rawTab === "login" ? "login" : "tasks"
  const page = parsePageParam(sp)
  const q = parseQueryParam(sp, "q")
  const moduleFilter = parseQueryParam(sp, "module")
  const from = parseQueryParam(sp, "from")
  const to = parseQueryParam(sp, "to")

  // Tab 切换链接携带当前筛选（分页参数不携带，切回第 1 页）
  const filterQs = new URLSearchParams(
    filterQuery({ q, module: moduleFilter, from, to }),
  )
  const withFilters = (tabValue: string) =>
    filterQs.size > 0 ? `/platform/logs?tab=${tabValue}&${filterQs}` : `/platform/logs?tab=${tabValue}`

  const tabs = [
    { value: "tasks", href: withFilters("tasks"), label: "生图日志", icon: FileText },
    { value: "login", href: withFilters("login"), label: "登录日志", icon: LogIn },
  ] as const

  return (
    <div className="space-y-4">
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

      {tab === "tasks" ? (
        <TasksSection
          page={page}
          q={q}
          module={moduleFilter}
          from={from}
          to={to}
        />
      ) : (
        <LoginSection page={page} />
      )}
    </div>
  )
}

async function TasksSection({
  page,
  q,
  module: moduleFilter,
  from,
  to,
}: {
  page: number
  q: string
  module: string
  from: string
  to: string
}) {
  const { tasks, total } = await listAllTaskLogsAction({
    page,
    pageSize: PAGE_SIZE,
    q,
    source: moduleFilter || undefined,
    from,
    to,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">全平台生图日志</CardTitle>
        <CardDescription>共 {total} 条任务记录（全部企业）</CardDescription>
        <CardAction>
          <AdminListFilters
            basePath="/platform/logs"
            q={q}
            module={moduleFilter}
            from={from}
            to={to}
            moduleOptions={TASK_SOURCE_OPTIONS}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        <PlatformLogsTaskTable tasks={tasks} />
      </CardContent>
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/platform/logs"
        query={{
          tab: "tasks",
          ...filterQuery({ q, module: moduleFilter, from, to }),
        }}
      />
    </Card>
  )
}

async function LoginSection({ page }: { page: number }) {
  const { logs, total } = await listAllLoginLogsAction({ page, pageSize: PAGE_SIZE })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">全平台登录审计日志</CardTitle>
        <CardDescription>共 {total} 条登录记录（全部企业）</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户名</TableHead>
              <TableHead>归属企业</TableHead>
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
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  暂无登录记录
                </TableCell>
              </TableRow>
            ) : (
              logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.username ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {l.enterpriseName ?? "—"}
                  </TableCell>
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
                    {formatDateTime(l.createdAt)}
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
        basePath="/platform/logs"
        query={{ tab: "login" }}
      />
    </Card>
  )
}
