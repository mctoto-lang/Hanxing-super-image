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
  AlertTriangle,
  Coins,
  UserCheck,
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
  HourlyBarChart,
  MultiSeriesAreaChart,
  RankingBarChart,
  TrendAreaChart,
} from "@/components/platform/charts"
import { PageHeader } from "@/components/shared/page-header"
import { StatCard } from "@/components/shared/stat-card"
import { TableEmpty } from "@/components/shared/table-empty"

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

/** 看板时间范围档位（与服务端 normalizeDashboardRange 白名单一致） */
const RANGE_OPTIONS = [7, 30, 90] as const

/**
 * 平台数据看板：生图类 / 对话类两个看板（?tab=image|chat，默认生图）。
 * Tab 与时间范围（?range=7|30|90，默认 30）均由 URL 参数驱动，服务端
 * 按需聚合对应看板数据；趋势图按所选范围取窗，其余全量口径不变。
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
  const rawRange = Number(Array.isArray(sp.range) ? sp.range[0] : sp.range)
  const range = (RANGE_OPTIONS as readonly number[]).includes(rawRange)
    ? rawRange
    : 30

  const tabs = [
    { value: "image", href: `/platform?tab=image&range=${range}`, label: "生图看板", icon: ImageIcon },
    { value: "chat", href: `/platform?tab=chat&range=${range}`, label: "对话看板", icon: MessageSquare },
  ] as const

  return (
    <div className="space-y-4">
      <PageHeader
        title="平台管理"
        description={`超级管理员 · ${ctx.user.username} · 平台数据看板`}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
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

        {/* 时间范围切换（趋势图窗口，两个看板同步） */}
        <div className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
          {RANGE_OPTIONS.map((r) => (
            <Link
              key={r}
              href={`/platform?tab=${tab}&range=${r}`}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
                range === r
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:text-foreground",
              )}
            >
              近 {r} 天
            </Link>
          ))}
        </div>
      </div>

      {tab === "image" ? <ImageDashboard range={range} /> : <ChatDashboard range={range} />}
    </div>
  )
}

async function ImageDashboard({ range }: { range: number }) {
  const stats = await getPlatformStatsAction(range)
  const avgDuration =
    stats.avgDurationMs != null ? `${(stats.avgDurationMs / 1000).toFixed(1)}s` : null

  return (
    <>
      {/* KPI 卡（10 张：总量 5 + 今日活跃 5） */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={<Building2 className="size-3.5 text-chart-3" />} label="企业总数">
          {stats.enterpriseCount.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard icon={<Users className="size-3.5 text-chart-2" />} label="用户总数">
          {stats.userCount.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard label="平台积分总量">
          {stats.totalCredits.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard icon={<ImageIcon className="size-3.5 text-chart-1" />} label="累计生图">
          {stats.totalTasks.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard icon={<CheckCircle2 className="size-3.5 text-chart-2" />} label="已完成生图">
          {stats.completedTasks.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard
          icon={<CalendarDays className="size-3.5 text-chart-5" />}
          label="今日生图"
          trend={{ delta: stats.todayTasks - stats.yesterdayTasks, base: stats.yesterdayTasks }}
        >
          {stats.todayTasks.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard icon={<UserCheck className="size-3.5 text-chart-2" />} label="今日活跃用户">
          {stats.todayActiveUsers.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard icon={<AlertTriangle className="size-3.5 text-chart-4" />} label="今日失败率">
          {stats.todayFailedRate != null ? `${stats.todayFailedRate.toFixed(1)}%` : "—"}
        </StatCard>
        <StatCard icon={<Timer className="size-3.5 text-chart-4" />} label="平均生成耗时">
          {avgDuration ?? "—"}
        </StatCard>
        <StatCard icon={<Coins className="size-3.5 text-chart-3" />} label="今日积分消耗">
          {stats.todayCreditsConsumed.toLocaleString("zh-CN")}
        </StatCard>
      </div>

      {/* 趋势面积图 + 状态分布环形图 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">近 {range} 天生图趋势</CardTitle>
            <CardDescription>按日聚合的生图任务数与完成数</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              data={stats.dailyTrend}
              emptyText={`近 ${range} 天暂无生图任务`}
            />
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

      {/* 24 小时时段分布 + 积分消耗趋势 + 用户/企业增长 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">生图时段分布</CardTitle>
            <CardDescription>近 {range} 天按小时的生图次数（0-23 时）</CardDescription>
          </CardHeader>
          <CardContent>
            <HourlyBarChart
              data={stats.hourlyDistribution}
              emptyText={`近 ${range} 天暂无生图任务`}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">积分消耗趋势</CardTitle>
            <CardDescription>近 30 天每日生图积分消耗</CardDescription>
          </CardHeader>
          <CardContent>
            <MultiSeriesAreaChart
              data={stats.creditsTrend}
              series={[{ key: "amount", label: "积分消耗" }]}
              emptyText="近 30 天暂无积分消耗"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">用户 / 企业增长</CardTitle>
            <CardDescription>近 30 天每日新增用户与企业</CardDescription>
          </CardHeader>
          <CardContent>
            <MultiSeriesAreaChart
              data={stats.userGrowthTrend.map((u) => ({
                day: u.day,
                users: u.count,
                enterprises:
                  stats.enterpriseGrowthTrend.find((e) => e.day === u.day)?.count ?? 0,
              }))}
              series={[
                { key: "users", label: "新增用户", color: "var(--chart-2)" },
                { key: "enterprises", label: "新增企业", color: "var(--chart-3)" },
              ]}
              emptyText="近 30 天暂无新增"
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
                  <TableHead>生图次数</TableHead>
                  <TableHead>消耗积分</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.enterpriseRanking.length === 0 ? (
                  <TableEmpty colSpan={4} noun="生图数据" />
                ) : (
                  stats.enterpriseRanking.map((r, i) => (
                    <TableRow key={r.enterpriseId}>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {i + 1}
                      </TableCell>
                      <TableCell className="font-medium">{r.enterpriseName}</TableCell>
                      <TableCell className="tabular-nums">
                        {r.taskCount.toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
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

async function ChatDashboard({ range }: { range: number }) {
  const stats = await getChatStatsAction(range)
  const avgDuration =
    stats.avgDurationMs != null
      ? `${(stats.avgDurationMs / 1000).toFixed(1)}s`
      : null

  return (
    <>
      {/* KPI 卡（6 张） */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={<MessagesSquare className="size-3.5 text-chart-1" />}
          label="累计对话消息"
        >
          {stats.totalMessages.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard
          icon={<CalendarDays className="size-3.5 text-chart-5" />}
          label="今日对话消息"
          trend={{ delta: stats.todayMessages - stats.yesterdayMessages, base: stats.yesterdayMessages }}
        >
          {stats.todayMessages.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard
          icon={<UserCheck className="size-3.5 text-chart-2" />}
          label="今日活跃对话用户"
        >
          {stats.todayActiveChatUsers.toLocaleString("zh-CN")}
        </StatCard>
        <StatCard icon={<Gauge className="size-3.5 text-chart-2" />} label="消息成功率">
          {stats.successRate != null ? `${stats.successRate.toFixed(1)}%` : "—"}
        </StatCard>
        <StatCard icon={<Timer className="size-3.5 text-chart-4" />} label="平均耗时">
          {avgDuration ?? "—"}
        </StatCard>
        <StatCard
          icon={<FolderOpen className="size-3.5 text-chart-3" />}
          label="对话会话总数"
        >
          {stats.conversationCount.toLocaleString("zh-CN")}
        </StatCard>
      </div>

      {/* 趋势面积图 + 消息状态分布环形图 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">近 {range} 天对话消息趋势</CardTitle>
            <CardDescription>按日聚合的助手消息数与完成数（/chat 交互式对话）</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              data={stats.dailyTrend}
              emptyText={`近 ${range} 天暂无对话消息`}
            />
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
