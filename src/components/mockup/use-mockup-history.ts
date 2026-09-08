"use client"

import * as React from "react"
import type { DateRange } from "react-day-picker"
import type {
  MockupBatchView,
  MockupCardHistoryView,
} from "@/lib/mockup/types"
import {
  listAllCardHistoryAction,
  listMockupBatchesAction,
} from "@/server/actions/mockup"

export type MockupHistorySource = "card" | "batch"

/**
 * 生成历史共用状态：来源切换（模板渲染卡片 / 批量替换批次）、日期筛选、
 * 按来源懒加载 + 批量替换进行中 5s 轮询（页面隐藏暂停）。
 * 模板渲染与批量替换两页各实例化一次，defaultSource 随所在页而定。
 */
export function useMockupHistory(defaultSource: MockupHistorySource) {
  const [source, setSource] = React.useState<MockupHistorySource>(defaultSource)
  const [cardRecords, setCardRecords] = React.useState<MockupCardHistoryView[]>(
    [],
  )
  const [batchRecords, setBatchRecords] = React.useState<MockupBatchView[]>([])
  const [loading, setLoading] = React.useState(false)
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>(
    undefined,
  )

  const handleRefresh = React.useCallback(
    async (override?: MockupHistorySource) => {
      const target = override ?? source
      setLoading(true)
      try {
        if (target === "card") {
          const res = await listAllCardHistoryAction()
          if (res.ok) setCardRecords(res.cards)
        } else {
          const res = await listMockupBatchesAction()
          if (res.ok) setBatchRecords(res.batches)
        }
      } finally {
        setLoading(false)
      }
    },
    [source],
  )

  // 切换来源 / 首次进入时按需加载
  React.useEffect(() => {
    const empty = source === "card" ? cardRecords.length === 0 : batchRecords.length === 0
    if (empty) void handleRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // 批量替换来源下有进行中批次 → 5s 轮询刷新（页面隐藏暂停）
  const batchProcessing = batchRecords.some((b) => b.processingCount > 0)
  React.useEffect(() => {
    if (source !== "batch" || !batchProcessing) return
    const timer = setInterval(() => {
      if (document.hidden) return
      void listMockupBatchesAction().then((res) => {
        if (res.ok) setBatchRecords(res.batches)
      })
    }, 5000)
    return () => clearInterval(timer)
  }, [source, batchProcessing])

  // 日期筛选：卡片 = 最近出图时间 / 批次 = 批次创建时间
  const filterActive = dateRange?.from !== undefined
  const filteredCardRecords = React.useMemo(() => {
    const { from, to } = dateRange ?? {}
    if (!from && !to) return cardRecords
    const start = from ? new Date(from) : null
    start?.setHours(0, 0, 0, 0)
    const end = to ? new Date(to) : null
    end?.setHours(23, 59, 59, 999)
    return cardRecords.filter((c) => {
      const t = new Date(c.latestAt).getTime()
      if (start && t < start.getTime()) return false
      if (end && t > end.getTime()) return false
      return true
    })
  }, [cardRecords, dateRange])

  const filteredBatchRecords = React.useMemo(() => {
    const { from, to } = dateRange ?? {}
    if (!from && !to) return batchRecords
    const start = from ? new Date(from) : null
    start?.setHours(0, 0, 0, 0)
    const end = to ? new Date(to) : null
    end?.setHours(23, 59, 59, 999)
    return batchRecords.filter((b) => {
      const t = new Date(b.createdAt).getTime()
      if (start && t < start.getTime()) return false
      if (end && t > end.getTime()) return false
      return true
    })
  }, [batchRecords, dateRange])

  return {
    source,
    setSource,
    loading,
    handleRefresh,
    dateRange,
    setDateRange,
    filterActive,
    cardRecords: filteredCardRecords,
    batchRecords: filteredBatchRecords,
  }
}
