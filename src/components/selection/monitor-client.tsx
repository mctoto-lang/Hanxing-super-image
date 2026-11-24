"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Crosshair } from "lucide-react"
import { PageTabs } from "@/components/shared/page-tabs"
import { FilterSelect } from "@/components/selection/filter-select"
import { SelectionEmpty } from "@/components/selection/empty-state"
import { platformLabel } from "@/components/selection/labels"
import { MonitorAddDialog } from "@/components/selection/monitor/monitor-add-dialog"
import { MonitorCard, type MonitorRow } from "@/components/selection/monitor/monitor-row"
import { isSelectionPlatform, isMonitorablePlatform, SELECTION_PLATFORMS } from "@/lib/selection/platforms"
import { cn } from "@/lib/utils"

/**
 * 竞品监控页客户端：状态标签（全部 / 监控中 / 已暂停）+ 平台筛选 + 搜索 + 添加监控，
 * 全部 URL 驱动；目标卡片列表。
 */

export interface MonitorFilter {
  /** all / active / paused */
  status: string
  platform: string
  q: string
}

const BASE_PATH = "/selection/competitor"

/** 可监控的平台（有指标重抓或评论抓取能力） */
const MONITORABLE = SELECTION_PLATFORMS.filter((p) => isMonitorablePlatform(p))

function buildHref(filter: MonitorFilter, patch: Partial<MonitorFilter>): string {
  const next = { ...filter, ...patch }
  const params = new URLSearchParams()
  if (next.status && next.status !== "all") params.set("status", next.status)
  if (next.platform) params.set("platform", next.platform)
  if (next.q) params.set("q", next.q)
  const qs = params.toString()
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH
}

export function MonitorClient({
  initialMonitors,
  filter,
  counts,
  currentUserId,
  canManageAll = false,
}: {
  initialMonitors: MonitorRow[]
  filter: MonitorFilter
  /** 企业内全部目标的状态计数（不受筛选影响；trackingReviews = 评论追踪中） */
  counts: { active: number; paused: number; total: number; trackingReviews?: number }
  currentUserId: string
  /** 当前用户是企业管理员/所有者（周期/开关/暂停/删除对管理员也开放，服务端同口径） */
  canManageAll?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [keyword, setKeyword] = React.useState(filter.q)

  React.useEffect(() => {
    setKeyword(filter.q)
  }, [filter.q])

  const push = (patch: Partial<MonitorFilter>) => {
    startTransition(() => router.push(buildHref(filter, patch)))
  }

  const statusTabs = [
    { value: "all", label: `全部 ${counts.total}`, href: buildHref(filter, { status: "all" }) },
    { value: "active", label: `监控中 ${counts.active}`, href: buildHref(filter, { status: "active" }) },
    { value: "paused", label: `已暂停 ${counts.paused}`, href: buildHref(filter, { status: "paused" }) },
  ]

  const hasFilter = Boolean(filter.platform || filter.q)

  return (
    <div className={cn("space-y-3 transition-opacity", pending && "opacity-70")}>
      <PageTabs tabs={statusTabs} value={filter.status}>
        <MonitorAddDialog />
      </PageTabs>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          ariaLabel="平台筛选"
          placeholder="全部平台"
          value={isSelectionPlatform(filter.platform) ? filter.platform : ""}
          onChange={(v) => push({ platform: v })}
          items={[
            { value: "", label: "全部平台" },
            ...MONITORABLE.map((p) => ({ value: p, label: platformLabel(p) })),
          ]}
          width="w-32"
        />
        <input
          type="search"
          aria-label="搜索监控目标"
          placeholder="搜索标题或链接"
          value={keyword}
          maxLength={120}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") push({ q: keyword.trim() })
          }}
          className="h-8 w-56 rounded-md border border-input bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        {filter.q ? (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => push({ q: "" })}
          >
            清除搜索
          </button>
        ) : null}
      </div>

      {initialMonitors.length === 0 ? (
        <SelectionEmpty
          icon={<Crosshair className="size-6" />}
          title={hasFilter ? "没有符合筛选条件的监控目标" : "还没有监控目标"}
          description={
            hasFilter
              ? "试试切换状态或清除筛选。"
              : "点右上角「添加监控」粘贴商品 / 帖子链接，或在选品发现、市场分析的卡片上点准星按钮加入。"
          }
        />
      ) : (
        <div className="space-y-3">
          {initialMonitors.map((m) => (
            <MonitorCard key={m.id} m={m} currentUserId={currentUserId} canManageAll={canManageAll} />
          ))}
        </div>
      )}
    </div>
  )
}
