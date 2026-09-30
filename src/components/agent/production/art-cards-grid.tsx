"use client"

/**
 * 卡面生产网格（art 阶段「卡面生产」Tab）：
 * 状态筛选 chips + 一行 6 个正方形缩略图（完整比例 contain，点击打开
 * 逐轮回放弹窗，见 card-thumb-grid）。
 */
import { useMemo, useState } from "react"
import { Images } from "lucide-react"
import { cn } from "@/lib/utils"
import { CardThumbGrid } from "../card-thumb-grid"
import type { TemplateWorkspaceData } from "../use-template-workspace"

type WorkspaceItem = TemplateWorkspaceData["items"][number]

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "sample", label: "小样" },
  { key: "waiting", label: "待确认" },
  { key: "done", label: "已产出" },
  { key: "inflight", label: "进行中" },
  { key: "failed", label: "失败" },
] as const

type FilterKey = (typeof FILTERS)[number]["key"]

function matchFilter(item: WorkspaceItem, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true
    case "sample":
      return item.isSample
    case "waiting":
      return item.status === "waiting_human"
    case "done":
      return ["confirmed", "approved_by_ai", "fallback"].includes(item.status)
    case "inflight":
      return ["pending", "drafting", "generating", "reviewing"].includes(item.status)
    case "failed":
      return item.status === "failed" || item.status === "cancelled"
  }
}

export function ArtCardsGrid({
  data,
  onOpenItem,
}: {
  data: TemplateWorkspaceData
  onOpenItem: (itemId: string) => void
}) {
  const [filter, setFilter] = useState<FilterKey>("all")
  const items = useMemo(
    () => data.items.filter((item) => matchFilter(item, filter)),
    [data.items, filter],
  )

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Images className="size-4 text-violet-500" />
          卡面
        </span>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setFilter(option.key)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs transition-colors",
                filter === option.key
                  ? "bg-violet-500/15 font-medium text-violet-600 dark:text-violet-300"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">点击卡牌查看逐轮修改与评分</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {items.length}/{data.items.length} 张
        </span>
      </div>

      <div className="border-t p-3">
        {data.items.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">卡牌清单尚未生成</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">该筛选下暂无卡牌</p>
        ) : (
          <CardThumbGrid
            items={items.map((item) => ({
              id: item.id,
              index: item.index,
              name: item.name,
              status: item.status,
              isSample: item.isSample,
              fallbackContentWarning: item.fallbackContentWarning,
              errorMessage: item.errorMessage,
              imageUrl: item.latestImageUrl,
              roundNumber: item.latestRoundNumber,
            }))}
            onOpen={onOpenItem}
          />
        )}
      </div>
    </section>
  )
}
