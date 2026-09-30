"use client"

/**
 * 卡面生产统计卡（art 阶段顶部；自旧版 RunBoard 迁移）：
 * 产出进度（分小样/全套口径）/ 待人工数 / 生图次数 / 积分消耗。
 */
import { Coins, Images, ImagePlus, UserCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TemplateWorkspaceData } from "../use-template-workspace"

const DONE_STATUSES = ["confirmed", "approved_by_ai", "fallback"] as const
const TRANSIENT_STATUSES = ["pending", "drafting", "generating", "reviewing"] as const

/** 统计卡：彩色图标 chip + 大数字 + 可选副行（生产视图与历史只读看板共用） */
export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  chipClass,
  progress,
}: {
  icon: typeof Coins
  label: string
  value: string
  /** 副行补充指标（小字，顿号/点号分隔） */
  sub?: string
  chipClass: string
  progress?: { percent: number; running: boolean }
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-3.5 shadow-xs">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", chipClass)}>
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-semibold leading-tight tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
        {progress && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full bg-violet-500 transition-[width] duration-500",
                progress.running && "motion-safe:animate-pulse",
              )}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export function ProductionStats({
  data,
  busy,
}: {
  data: TemplateWorkspaceData
  busy: boolean
}) {
  const { run, items } = data
  // sample 阶段以小样口径统计；full/compose 阶段以全套口径统计
  const scope = run.phase === "sample" ? items.filter((item) => item.isSample) : items
  const scopeTotal = scope.length
  const doneCount = scope.filter((item) => DONE_STATUSES.includes(item.status as (typeof DONE_STATUSES)[number])).length
  const waitingCount = scope.filter((item) => item.status === "waiting_human").length
  const inFlight = scope.filter(
    (item) => TRANSIENT_STATUSES.includes(item.status as (typeof TRANSIENT_STATUSES)[number]),
  ).length
  const overallPercent = scopeTotal > 0 ? Math.round((doneCount / scopeTotal) * 100) : 0
  const totalCredits = run.imageCostCredits + run.costCenticredits / 100
  const failedCount = scope.filter((item) => item.status === "failed").length
  const llmCredits = run.costCenticredits / 100

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <StatCard
        icon={Images}
        label={run.phase === "sample" ? "小样产出" : "全套产出"}
        value={`${doneCount}/${scopeTotal} 张`}
        sub={`待确认 ${waitingCount} 张${failedCount > 0 ? ` · 失败 ${failedCount} 张` : ""}`}
        chipClass="bg-violet-500/15 text-violet-600 dark:text-violet-300"
        progress={{ percent: overallPercent, running: busy }}
      />
      <StatCard
        icon={UserCheck}
        label="待你确认"
        value={`${waitingCount} 张`}
        sub={waitingCount > 0 ? "点击卡面 → 逐轮回放中确认终版" : "暂无需人工确认的卡面"}
        chipClass="bg-amber-500/15 text-amber-600 dark:text-amber-300"
      />
      <StatCard
        icon={ImagePlus}
        label={inFlight > 0 ? `生图（${inFlight} 张在途）` : "生图"}
        value={`${run.imageCount} 次`}
        sub={`文本调用 ${run.llmCallCount} 次`}
        chipClass="bg-sky-500/15 text-sky-600 dark:text-sky-300"
      />
      <StatCard
        icon={Coins}
        label="积分消耗"
        value={`≈${Math.round(totalCredits * 100) / 100} 积分`}
        sub={`生图 ${run.imageCostCredits} · 文本 ≈${Math.round(llmCredits * 100) / 100}`}
        chipClass="bg-blue-500/15 text-blue-600 dark:text-blue-300"
      />
    </div>
  )
}
