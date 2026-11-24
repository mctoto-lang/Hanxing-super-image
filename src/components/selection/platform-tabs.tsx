import type * as React from "react"

import { PageTabs } from "@/components/shared/page-tabs"
import { PlatformLogo } from "@/components/selection/platform-badges"
import { platformLabel } from "@/components/selection/labels"
import { platformsForCategory, type PlatformCategory } from "@/lib/selection/platforms"
import type { PoolFilterState } from "@/lib/selection/pool-url"
import { platformSwitchQuery } from "@/lib/selection/pool-url"

/**
 * 平台标签条（选品发现 / 市场分析共用）：每个平台一个标签，带 logo 与去重后的条数；
 * 点击切换 = URL 上换 platform（保留排序 / 日期 / 视图，清掉属于原平台的国家、
 * 来源任务与搜索词）。宽度不够时由 PageTabs 自动折叠为下拉。
 */
export function PlatformTabs({
  category,
  value,
  counts,
  filter,
  basePath,
  children,
}: {
  category: PlatformCategory
  value: string
  /** 各平台条数（getSelectionPoolCountsAction） */
  counts: Record<string, number>
  filter: PoolFilterState
  basePath: string
  /** 右侧工具（如「抓取该平台」） */
  children?: React.ReactNode
}) {
  const tabs = platformsForCategory(category).map((p) => {
    const count = counts[p] ?? 0
    return {
      value: p,
      label: count > 0 ? `${platformLabel(p)} ${count}` : platformLabel(p),
      href: hrefOf(basePath, filter, p),
      icon: <PlatformLogo platform={p} size={14} />,
    }
  })
  return (
    <PageTabs tabs={tabs} value={value}>
      {children}
    </PageTabs>
  )
}

function hrefOf(basePath: string, filter: PoolFilterState, platform: string): string {
  const q = platformSwitchQuery(filter, platform)
  const qs = new URLSearchParams(
    Object.entries(q).filter((pair): pair is [string, string] => pair[1] != null),
  ).toString()
  return qs ? `${basePath}?${qs}` : `${basePath}?platform=${platform}`
}
