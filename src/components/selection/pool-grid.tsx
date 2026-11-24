"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { ResultCard } from "@/components/selection/result-card"
import { ResultDetailDialog } from "@/components/selection/result-detail-dialog"
import { ResultTable } from "@/components/selection/result-table"
import { toggleSelectionBookmarkAction } from "@/server/actions/selection"
import { addSelectionMonitorAction } from "@/server/actions/selection-monitor"
import type { PoolColumnDef } from "@/lib/selection/platform-views"
import type { PoolSort, SelectionPoolItem } from "@/lib/selection/pool-types"
import { poolQuery, type PoolFilterState } from "@/lib/selection/pool-url"

/**
 * 数据池网格（选品发现 / 市场分析共用）：卡片视图或表格视图；点击卡片 / 行打开
 * 详情弹窗；收藏星乐观切换（失败回滚 + toast）；竞品监控按钮按平台能力显隐，
 * 加入后乐观置亮。表格列头排序走 URL。
 */
export function PoolGrid({
  items,
  filter,
  basePath,
  columns,
  bookmarkedIds,
  monitoredUrls = [],
  monitoredIds = [],
}: {
  items: SelectionPoolItem[]
  filter: PoolFilterState
  basePath: string
  /** 表格视图列定义（电商）；空数组 = 该平台无表格视图 */
  columns: PoolColumnDef[]
  bookmarkedIds: string[]
  /** 企业内已监控目标 URL（卡片按钮态） */
  monitoredUrls?: string[]
  /** 企业内已监控目标的平台原生 ID（链接形态不同也能命中） */
  monitoredIds?: string[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [bookmarked, setBookmarked] = React.useState<Set<string>>(() => new Set(bookmarkedIds))
  React.useEffect(() => {
    setBookmarked(new Set(bookmarkedIds))
  }, [bookmarkedIds])

  const [monitored, setMonitored] = React.useState<Set<string>>(
    () => new Set([...monitoredUrls, ...monitoredIds]),
  )
  React.useEffect(() => {
    setMonitored(new Set([...monitoredUrls, ...monitoredIds]))
  }, [monitoredUrls, monitoredIds])

  const [openItem, setOpenItem] = React.useState<SelectionPoolItem | null>(null)
  // 加入监控的在途防重：连点卡片准星 / 表格行按钮 / 详情弹窗按钮不会并发提交
  // （服务端另有认领+在途检查兜底，这里是第一道界面防线）
  const [monitorPending, setMonitorPending] = React.useState<string | null>(null)

  const toggleBookmark = (id: string) => {
    const wasBookmarked = bookmarked.has(id)
    // 乐观切换 + 失败回滚（对齐旧 result-table 口径）
    setBookmarked((s) => {
      const next = new Set(s)
      if (wasBookmarked) next.delete(id)
      else next.add(id)
      return next
    })
    void (async () => {
      try {
        const res = await toggleSelectionBookmarkAction(id)
        if (!res.ok) throw new Error(res.error)
        if (res.bookmarked) {
          toast.success("已加入我的选品")
        }
      } catch (err) {
        setBookmarked((s) => {
          const next = new Set(s)
          if (wasBookmarked) next.add(id)
          else next.delete(id)
          return next
        })
        toast.error(err instanceof Error ? err.message : "操作失败，请重试")
      }
    })()
  }

  const addMonitor = (item: SelectionPoolItem) => {
    // 已监控 / 请求在途时忽略（已监控的准星此前仍可点，重复提交靠这里与服务端兜底）
    if (monitorPending != null || isMonitored(item)) return
    setMonitorPending(item.id)
    void (async () => {
      try {
        const res = await addSelectionMonitorAction({ resultId: item.id })
        if (!res.ok) throw new Error(res.error)
        setMonitored((s) => {
          const next = new Set(s)
          if (item.sourceUrl) next.add(item.sourceUrl)
          if (item.externalId) next.add(item.externalId)
          return next
        })
        toast.success("已加入竞品监控，首轮抓取已发起（数据任务页可跟踪进度）")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "加入监控失败，请重试")
      } finally {
        setMonitorPending(null)
      }
    })()
  }

  const onSort = (sort: PoolSort) => {
    const params = new URLSearchParams(
      Object.entries(poolQuery({ ...filter, sort, view: filter.view })).filter(
        (pair): pair is [string, string] => pair[1] != null,
      ),
    )
    const pageSize = searchParams.get("pageSize")
    if (pageSize) params.set("pageSize", pageSize)
    const qs = params.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath)
  }

  const isMonitored = (item: SelectionPoolItem) =>
    (item.sourceUrl != null && monitored.has(item.sourceUrl)) ||
    (item.externalId != null && monitored.has(item.externalId))

  return (
    <>
      {filter.view === "table" && columns.length > 0 ? (
        <ResultTable
          items={items}
          columns={columns}
          sort={filter.sort as PoolSort}
          bookmarkedIds={bookmarked}
          monitoredIds={monitored}
          onSort={onSort}
          onOpen={setOpenItem}
          onToggleBookmark={toggleBookmark}
          onAddMonitor={addMonitor}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <ResultCard
              key={item.id}
              item={item}
              bookmarked={bookmarked.has(item.id)}
              monitored={isMonitored(item)}
              onToggleBookmark={toggleBookmark}
              onAddMonitor={addMonitor}
              onOpen={setOpenItem}
            />
          ))}
        </div>
      )}

      <ResultDetailDialog
        item={openItem}
        open={openItem !== null}
        onOpenChange={(o) => !o && setOpenItem(null)}
        bookmarked={openItem != null && bookmarked.has(openItem.id)}
        onToggleBookmark={toggleBookmark}
        monitored={openItem != null && isMonitored(openItem)}
        onAddMonitor={addMonitor}
      />
    </>
  )
}
