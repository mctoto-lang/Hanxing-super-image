"use client"

import * as React from "react"
import { toast } from "sonner"
import { ResultCard } from "@/components/selection/result-card"
import { ResultDetailDialog } from "@/components/selection/result-detail-dialog"
import { toggleSelectionBookmarkAction } from "@/server/actions/selection"
import { addSelectionMonitorAction } from "@/server/actions/selection-monitor"
import type { SelectionPoolItem } from "@/lib/selection/pool-types"

/**
 * 数据池卡片网格（选品发现/市场分析共用）
 *
 * 2~5 列自适应；点击卡片开详情弹窗；收藏星乐观切换（失败回滚 + toast）；
 * 竞品监控按钮按平台能力显隐，加入后乐观置蓝。
 */
export function PoolGrid({
  items,
  bookmarkedIds,
  monitoredUrls,
}: {
  items: SelectionPoolItem[]
  bookmarkedIds: string[]
  /** 企业内已监控目标 URL（卡片按钮态） */
  monitoredUrls?: string[]
}) {
  const [bookmarked, setBookmarked] = React.useState<Set<string>>(
    () => new Set(bookmarkedIds),
  )
  React.useEffect(() => {
    setBookmarked(new Set(bookmarkedIds))
  }, [bookmarkedIds])

  const [monitored, setMonitored] = React.useState<Set<string>>(
    () => new Set(monitoredUrls ?? []),
  )
  React.useEffect(() => {
    setMonitored(new Set(monitoredUrls ?? []))
  }, [monitoredUrls])

  const [openItem, setOpenItem] = React.useState<SelectionPoolItem | null>(null)

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
    if (!item.sourceUrl) return
    void (async () => {
      try {
        const res = await addSelectionMonitorAction({ resultId: item.id })
        if (!res.ok) throw new Error(res.error)
        setMonitored((s) => new Set(s).add(item.sourceUrl!))
        toast.success("已加入竞品监控，首轮抓取已发起（数据任务页可跟踪进度）")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "加入监控失败，请重试")
      }
    })()
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => (
          <ResultCard
            key={item.id}
            item={item}
            bookmarked={bookmarked.has(item.id)}
            monitored={item.sourceUrl != null && monitored.has(item.sourceUrl)}
            onToggleBookmark={toggleBookmark}
            onAddMonitor={addMonitor}
            onOpen={setOpenItem}
          />
        ))}
      </div>

      <ResultDetailDialog
        item={openItem}
        open={openItem !== null}
        onOpenChange={(o) => !o && setOpenItem(null)}
        bookmarked={openItem != null && bookmarked.has(openItem.id)}
        onToggleBookmark={toggleBookmark}
      />
    </>
  )
}
