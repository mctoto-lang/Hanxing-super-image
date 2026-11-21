import Link from "next/link"
import { and, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionTasks, users } from "@/db/schema"
import { requireUserContext } from "@/lib/auth/session"
import { hasSelectionToken } from "@/lib/selection/provider-config"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { TaskCreateDialog } from "@/components/selection/task-create-dialog"
import { SelectionTaskTable } from "@/components/selection/task-table"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

const STATUS_FILTERS = [
  { key: "active", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
  { key: "cancelled", label: "已取消" },
  { key: "all", label: "全部" },
] as const

/**
 * 数据任务 = 唯一抓取入口：新建任务弹窗 + 任务表格（状态/进度/结算/查看数据
 * 跳数据池），企业内共享。
 */
export default async function SelectionTasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess("selection")) return <NoPermission module="选品工具" />
  const enterpriseId = ctx.user.enterpriseId!

  const sp = await searchParams
  const statusParam = (Array.isArray(sp.status) ? sp.status[0] : sp.status) ?? "active"
  const status = (STATUS_FILTERS.find((s) => s.key === statusParam)?.key ??
    "active") as (typeof STATUS_FILTERS)[number]["key"]

  const conds = [eq(selectionTasks.enterpriseId, enterpriseId)]
  if (status === "active") {
    conds.push(inArray(selectionTasks.status, ["queued", "processing"]))
  } else if (status !== "all") {
    conds.push(
      eq(
        selectionTasks.status,
        status as (typeof selectionTasks.$inferSelect)["status"],
      ),
    )
  }

  const [tasks, apifyReady] = await Promise.all([
    db
      .select({
        task: selectionTasks,
        creatorName: users.name,
        creatorUsername: users.username,
      })
      .from(selectionTasks)
      .leftJoin(users, eq(selectionTasks.userId, users.id))
      .where(and(...conds))
      .orderBy(desc(selectionTasks.createdAt))
      .limit(50),
    hasSelectionToken(enterpriseId),
  ])

  return (
    <div className="space-y-4">
      <PageHeader
        title="数据任务"
        description="全部抓取任务的唯一入口：新建抓取、跟踪进度、结算积分（企业内共享）。"
      >
        <TaskCreateDialog
          userCredits={ctx.user.creditsBalance}
          apifyReady={apifyReady}
        />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "active" ? "/selection/tasks" : `/selection/tasks?status=${f.key}`}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition-colors",
              status === f.key
                ? "bg-primary text-primary-foreground"
                : "border hover:bg-muted",
            )}
          >
            {f.label}
          </Link>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">仅显示最近 50 条任务</span>
      </div>

      <SelectionTaskTable
        tasks={tasks.map((r) => ({
          ...r.task,
          creatorName: r.creatorName || r.creatorUsername || null,
        }))}
      />
    </div>
  )
}
