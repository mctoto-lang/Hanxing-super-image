"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { X } from "lucide-react"
import { FilterSelect } from "@/components/selection/filter-select"
import { platformLabel } from "@/components/selection/labels"
import { SELECTION_PLATFORMS, isSelectionPlatform } from "@/lib/selection/platforms"
import { TASK_TYPE_OPTIONS, buildTaskQuery, type TaskFilter } from "@/lib/selection/task-links"
import { cn } from "@/lib/utils"

/**
 * 数据任务页筛选栏（URL 驱动）：平台 / 类型 / 关键词搜索；右侧放「新建抓取任务」。
 */

export function TaskToolbar({
  status,
  filter,
  children,
}: {
  status: string
  filter: TaskFilter
  children?: React.ReactNode
}) {
  const router = useRouter()
  const [pending, startTransition] = React.useTransition()
  const [keyword, setKeyword] = React.useState(filter.q)

  React.useEffect(() => {
    setKeyword(filter.q)
  }, [filter.q])

  const push = (patch: Partial<TaskFilter>) => {
    startTransition(() => router.push(buildTaskQuery(status, filter, patch)))
  }
  const hasFilter = Boolean(filter.platform || filter.taskType || filter.q)

  return (
    <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", pending && "opacity-70")}>
      <FilterSelect
        ariaLabel="平台筛选"
        placeholder="全部平台"
        value={isSelectionPlatform(filter.platform) ? filter.platform : ""}
        onChange={(v) => push({ platform: v })}
        items={[
          { value: "", label: "全部平台" },
          ...SELECTION_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) })),
        ]}
        width="w-32"
      />
      <FilterSelect
        ariaLabel="类型筛选"
        placeholder="全部类型"
        value={filter.taskType}
        onChange={(v) => push({ taskType: v })}
        items={[{ value: "", label: "全部类型" }, ...TASK_TYPE_OPTIONS]}
        width="w-32"
      />
      <input
        type="search"
        aria-label="搜索任务关键词"
        placeholder="搜索关键词"
        value={keyword}
        maxLength={120}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") push({ q: keyword.trim() })
        }}
        className="h-8 w-52 rounded-md border border-input bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      {hasFilter ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => push({ platform: "", taskType: "", q: "" })}
        >
          <X className="size-3.5" />
          清除筛选
        </button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  )
}
