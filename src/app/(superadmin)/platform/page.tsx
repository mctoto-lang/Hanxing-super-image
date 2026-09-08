import Link from "next/link"
import {
  Building2,
  Users,
  Image as ImageIcon,
  CheckCircle2,
  CalendarDays,
  MessageSquare,
  MessagesSquare,
  Gauge,
  Timer,
  FolderOpen,
} from "lucide-react"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  getPlatformStatsAction,
  getChatStatsAction,
} from "@/server/actions/platform"
import { cn } from "@/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DistributionPieChart,
  RankingBarChart,
  TrendAreaChart,
} from "@/components/platform/charts"

export const dynamic = "force-dynamic"

/** 生图任务状态（queued/processing/completed/failed）+ 对话消息状态（streaming/stopped） */
const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  processing: "处理中",
  streaming: "生成中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
}

/**
 * 平台数据看板：生图类 / 对话类两个看板（?tab=image|chat，默认生图）。
 * Tab 由 URL 参数驱动，服务端按需聚合对应看板数据。
 */
export default async function PlatformPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireSuperAdmin()
  const sp = await searchParams
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab
  const tab = rawTab === "chat" ? "chat" : "image"

  const tabs = [
    { value: "image", href: "/platform?tab=image", label: "生图看板", icon: ImageIcon },
    { value: "chat", href: "/platform?tab=chat", label: "对话看板", icon: MessageSquare },
  ] as const

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">平台管理</h1>
        <p className="text-sm text-muted-foreground">
          超级管理员 · {ctx.user.username} · 平台数据看板
        </p>
      </div>

      {/* 看板 Tab（Link 驱动，样式对齐 shadcn Tabs） */}
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

      {tab === "image" ? <ImageDashboard /> : <ChatDashboard />}
    </div>
  )
}

async function ImageDashboard() {
  const stats = await getPlatformStatsAction()

  return (
    <>
      {/* KPI 卡（6 张） */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard icon={<Building2 className="size-3.5 text-chart-3" />} label="企业总数" value={stats.enterpriseCount} />
        <KpiCard icon={<Users className="size-3.5 text-chart-2" />} label="用户总数" value={stats.userCount} />
        <KpiCard label="平台积分总量" value={stats.totalCredits} />
        <KpiCard icon={<ImageIcon className="size-3.5 text-chart-1" />} label="累计生图" value={stats.totalTasks} />
        <KpiCard icon={<CheckCircle2 className="size-3.5 text-chart-2" />} label="已完成生图" value={stats.completedTasks} />
        <KpiCard icon={<CalendarDays className="size-3.5 text-chart-5" />} label="今日生图" value={stats.todayTasks} />
      </div>

      {/* 趋势面积图 + 状态分布环形图 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">近 30 天生图趋势</CardTitle>
            <CardDescription>按日聚合的生图任务数与完成数</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart data={stats.dailyTrend} emptyText="近 30 天暂无生图任务" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">任务状态分布</CardTitle>
            <CardDescription>全部生图任务当前状态</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionPieChart
              data={stats.statusDistribution.map((s) => ({
                label: STATUS_LABELS[s.status] ?? s.status,
                value: s.count,
              }))}
              emptyText="暂无任务"
            />
          </CardContent>
        </Card>
      </div>

      {/* 企业生图排行 + 模型使用排行 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">企业生图排行（Top 10）</CardTitle>
            <CardDescription>按生图任务数排序，含累计消耗积分</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>企业</TableHead>
                  <TableHead className="text-right">生图次数</TableHead>
                  <TableHead className="text-right">消耗积分</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.enterpriseRanking.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      暂无生图数据
                    </TableCell>
                  </TableRow>
                ) : (
                  stats.enterpriseRanking.map((r, i) => (
                    <TableRow key={r.enterpriseId}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {i + 1}
                      </TableCell>
                      <TableCell className="font-medium">{r.enterpriseName}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.taskCount.toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.totalCharged.toLocaleString("zh-CN")}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">模型使用排行（Top 10）</CardTitle>
            <CardDescription>按调用次数排序的生图模型</CardDescription>
          </CardHeader>
          <CardContent>
            <RankingBarChart
              data={stats.modelRanking.map((m) => ({
                name: m.modelDisplayName,
                value: m.taskCount,
              }))}
              emptyText="暂无生图数据"
            />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

async function ChatDashboard() {
  const stats = await getChatStatsAction()
  const avgDuration =
    stats.avgDurationMs != null
      ? `${(stats.avgDurationMs / 1000).toFixed(1)}s`
      : null

  return (
    <>
      {/* KPI 卡（5 张） */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          icon={<MessagesSquare className="size-3.5 text-chart-1" />}
          label="累计对话消息"
          value={stats.totalMessages}
        />
        <KpiCard
          icon={<CalendarDays className="size-3.5 text-chart-5" />}
          label="今日对话消息"
          value={stats.todayMessages}
        />
        <KpiCard
          icon={<Gauge className="size-3.5 text-chart-2" />}
          label="消息成功率"
          text={stats.successRate != null ? `${stats.successRate.toFixed(1)}%` : "—"}
        />
        <KpiCard
          icon={<Timer className="size-3.5 text-chart-4" />}
          label="平均耗时"
          text={avgDuration ?? "—"}
        />
        <KpiCard
          icon={<FolderOpen className="size-3.5 text-chart-3" />}
          label="对话会话总数"
          value={stats.conversationCount}
        />
      </div>

      {/* 趋势面积图 + 消息状态分布环形图 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">近 30 天对话消息趋势</CardTitle>
            <CardDescription>按日聚合的助手消息数与完成数（/chat 交互式对话）</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart data={stats.dailyTrend} emptyText="近 30 天暂无对话消息" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">消息状态分布</CardTitle>
            <CardDescription>全部助手消息当前状态</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionPieChart
              data={stats.statusDistribution.map((s) => ({
                label: STATUS_LABELS[s.status] ?? s.status,
                value: s.count,
              }))}
              emptyText="暂无对话消息"
            />
          </CardContent>
        </Card>
      </div>

      {/* 模型排行 + 企业占比 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">对话模型使用排行（Top 10）</CardTitle>
            <CardDescription>按助手消息数排序的对话模型</CardDescription>
          </CardHeader>
          <CardContent>
            <RankingBarChart
              data={stats.modelRanking.map((m) => ({
                name: m.displayName ?? "未知模型",
                value: m.taskCount,
              }))}
              emptyText="暂无对话调用"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">企业对话占比</CardTitle>
            <CardDescription>按助手消息数聚合（Top 5 + 其他）</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionPieChart
              data={stats.enterpriseShare.map((e) => ({
                label: e.name,
                value: e.count,
              }))}
              emptyText="暂无对话数据"
            />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function KpiCard({
  icon,
  label,
  value,
  text,
}: {
  icon?: React.ReactNode
  label: string
  /** 数值型（数字格式化展示） */
  value?: number
  /** 文本型（如百分比/时长，优先于 value） */
  text?: string
}) {
  const display = text ?? (value ?? 0).toLocaleString("zh-CN")
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-bold tabular-nums">{display}</CardContent>
    </Card>
  )
}
