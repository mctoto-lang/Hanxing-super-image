import { requireUserContext } from "@/lib/auth/session"
import { hasSelectionToken } from "@/lib/selection/provider-config"
import { NoPermission } from "@/components/shared/no-permission"
import { PageHeader } from "@/components/shared/page-header"
import { TablePagination, parsePageParam } from "@/components/shared/table-pagination"
import { PageTabs } from "@/components/shared/page-tabs"
import { TaskCreateDialog } from "@/components/selection/task-create-dialog"
import { TaskToolbar } from "@/components/selection/task-toolbar"
import { SelectionTaskTable } from "@/components/selection/task-table"
import { compactNumber } from "@/components/selection/labels"
import { isSelectionPlatform } from "@/lib/selection/platforms"
import { TASK_STATUS_TABS, TASK_TYPE_OPTIONS, buildTaskQuery, isTaskStatusKey } from "@/lib/selection/task-links"
import {
  getSelectionTaskOverviewAction,
  getSelectionTasksAction,
} from "@/server/actions/selection"

export const dynamic = "force-dynamic"

const PAGE_SIZE_OPTIONS = [10, 20, 50]

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ""
}

/**
 * 数据任务 = 唯一抓取入口：新建任务弹窗 + 状态标签 + 筛选 + 任务表（企业内共享）。
 * 状态 / 平台 / 类型 / 关键词 / 分页全部 URL 驱动；其它页面可用
 * ?new=1&platform=X&type=Y 直接打开预置好的新建弹窗。
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
  const statusRaw = first(sp.status)
  const status = isTaskStatusKey(statusRaw) ? statusRaw : "active"
  const platformRaw = first(sp.platform)
  const platform = isSelectionPlatform(platformRaw) ? platformRaw : ""
  const taskTypeRaw = first(sp.type)
  const taskType = TASK_TYPE_OPTIONS.some((t) => t.value === taskTypeRaw) ? taskTypeRaw : ""
  const q = first(sp.q).slice(0, 120)
  const page = parsePageParam(sp)
  const pageSizeRaw = Number(first(sp.pageSize))
  const pageSize = PAGE_SIZE_OPTIONS.includes(pageSizeRaw) ? pageSizeRaw : PAGE_SIZE_OPTIONS[0]!
  // ?new=1 且带平台 → 直接打开预置的新建弹窗
  const presetPlatform = first(sp.platform)
  const autoOpen = first(sp.new) === "1" && isSelectionPlatform(presetPlatform)

  const [tasks, overview, apifyReady] = await Promise.all([
    getSelectionTasksAction({
      status,
      platform: platform || undefined,
      taskType: taskType || undefined,
      q: q || undefined,
      page,
      pageSize,
    }),
    getSelectionTaskOverviewAction(),
    hasSelectionToken(enterpriseId),
  ])
  if (!tasks.ok) {
    return (
      <div className="space-y-6">
        <PageHeader title="数据任务" description="全部抓取任务的唯一入口。" />
        <p className="text-sm text-destructive">{tasks.error}</p>
      </div>
    )
  }

  const filter = { platform, taskType, q }
  const hasFilter = Boolean(platform || taskType || q)

  return (
    <div className="space-y-4">
      <PageHeader
        title="数据任务"
        description="全部抓取任务的唯一入口：新建抓取、跟踪进度、结算积分（企业内共享）。"
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          今日已提交 {overview.todayUsed} / {overview.dailyLimit} 个任务
        </span>
        <span>·</span>
        <span>积分余额 {compactNumber(overview.creditsBalance)}</span>
      </div>

      <PageTabs
        tabs={TASK_STATUS_TABS.map((t) => ({
          value: t.key,
          label: `${t.label} ${overview.counts[t.key] ?? 0}`,
          href: buildTaskQuery(t.key, { ...filter, q: "" }, {}),
        }))}
        value={status}
      />

      <TaskToolbar status={status} filter={filter}>
        <TaskCreateDialog
          userCredits={overview.creditsBalance}
          apifyReady={apifyReady}
          initialPlatform={presetPlatform || undefined}
          initialTaskType={first(sp.type) || undefined}
          autoOpen={autoOpen}
          todayUsed={overview.todayUsed}
        />
      </TaskToolbar>

      {tasks.items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {hasFilter || status !== "active"
            ? "没有符合筛选条件的任务。"
            : "暂无进行中的任务——点右上角「新建抓取任务」发起第一次抓取。"}
        </div>
      ) : (
        <SelectionTaskTable
          tasks={tasks.items.map((t) => ({
            id: t.id,
            userId: t.userId,
            platform: t.platform,
            taskType: t.taskType,
            keyword: t.keyword,
            country: t.country,
            status: t.status,
            progress: t.progress,
            fetchedCount: t.fetchedCount,
            maxResults: t.maxResults,
            estimatedCredits: t.estimatedCredits,
            actualCredits: t.actualCredits,
            errorMessage: t.errorMessage,
            monitorId: t.monitorId,
            creatorName: t.creatorName,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
          }))}
          currentUserId={ctx.user.id}
          canCancelOthers={ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"}
        />
      )}

      <TablePagination
        page={page}
        pageSize={pageSize}
        total={tasks.total}
        basePath="/selection/tasks"
        query={{ ...(status !== "active" ? { status } : {}), ...(platform ? { platform } : {}), ...(taskType ? { type: taskType } : {}), ...(q ? { q } : {}) }}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
      />
    </div>
  )
}
