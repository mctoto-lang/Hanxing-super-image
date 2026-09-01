"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Glasses,
  History,
  Images,
  Palette,
  RefreshCw,
  User,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { endOfDay, startOfDay } from "date-fns"
import type { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BatchView } from "@/components/product-v2/batch-view"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import {
  getWeartryBatchStatusAction,
  listWeartryBatchesAction,
  retryWeartryTaskAction,
  type GenerateWeartryResult,
} from "@/server/actions/weartry"
import type { WeartryModelRow, WeartrySceneRow } from "@/lib/weartry/types"
import type { ProductDirectionRow } from "@/lib/product/types"
import {
  WEARTRY_INTROS,
  WEARTRY_MODE_LABELS,
  type WeartryMode,
} from "@/lib/weartry/dictionaries"
import { OutfitForm } from "./outfit-form"
import { TryonForm } from "./tryon-form"
import { ColorForm } from "./color-form"
import { WeartryHistoryPanel } from "./weartry-history-panel"

const TAB_MODES: WeartryMode[] = ["outfit", "model", "accessory", "color"]

/** 各功能 tab 图标（TabsTrigger 自动将 svg 缩放为 size-4） */
const MODE_ICONS: Record<WeartryMode, LucideIcon> = {
  outfit: Images,
  model: User,
  accessory: Glasses,
  color: Palette,
}

/** 历史 tab 顶栏筛选下拉选项（全部 + 各功能类型） */
const HISTORY_FILTER_ITEMS: { value: "all" | WeartryMode; label: string }[] = [
  { value: "all", label: "全部" },
  ...TAB_MODES.map((m) => ({ value: m, label: WEARTRY_MODE_LABELS[m] })),
]

/** 批次任务 mode（templateInfo.mode）→ 所属功能 tab */
const TASK_MODE_TO_TAB: Record<string, WeartryMode> = {
  outfit: "outfit",
  model_image: "model",
  wear: "model",
  accessory: "accessory",
  color: "color",
}

interface WeartryClientProps {
  initialModels: WeartryModelRow[]
  /** 服装组图方向池（appliesTo="weartry"，超管可配） */
  directions: ProductDirectionRow[]
  /** 模特穿戴预置场景（超管可配，提示词注入） */
  scenes: WeartrySceneRow[]
  creditsBalance: number
}

export function WeartryClient({
  initialModels,
  directions,
  scenes,
  creditsBalance,
}: WeartryClientProps) {
  const router = useRouter()

  // ── tab（history 是第五个视图，不参与 WEARTRY_MODES）──
  const [tab, setTab] = useState<WeartryMode | "history">("outfit")

  // ── 提交 / 批次 / 重试 ──
  const [submitting, setSubmitting] = useState(false)
  const [activeBatchTag, setActiveBatchTag] = useState<string | null>(null)
  const [batchTasks, setBatchTasks] = useState<
    Awaited<ReturnType<typeof getWeartryBatchStatusAction>>
  >([])
  const [retryingId, setRetryingId] = useState<string | null>(null)

  // ── 历史 ──
  const [batches, setBatches] = useState<Awaited<ReturnType<typeof listWeartryBatchesAction>>>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyModeFilter, setHistoryModeFilter] = useState<
    "all" | WeartryMode
  >("all")
  const [historyDateRange, setHistoryDateRange] = useState<
    DateRange | undefined
  >()
  const historyFilterActive =
    historyModeFilter !== "all" || historyDateRange?.from !== undefined
  const filteredBatches = useMemo(() => {
    if (!historyFilterActive) return batches
    return batches.filter((b) => {
      if (historyModeFilter !== "all") {
        const batchTab = TASK_MODE_TO_TAB[b.mode]
        if (batchTab !== historyModeFilter) return false
      }
      const created = new Date(b.createdAt)
      const { from, to } = historyDateRange ?? {}
      if (from && created < startOfDay(from)) return false
      if (to && created > endOfDay(to)) return false
      return true
    })
  }, [batches, historyModeFilter, historyDateRange, historyFilterActive])

  const refreshHistory = async () => {
    setHistoryLoading(true)
    try {
      setBatches(await listWeartryBatchesAction())
    } finally {
      setHistoryLoading(false)
    }
  }

  const handleTabChange = (v: string) => {
    const next = v as WeartryMode | "history"
    setTab(next)
    if (next === "history") void refreshHistory()
  }

  /** 通用提交段：执行各 tab 的生成 action → 接管批次轮询 */
  const submit = async (run: () => Promise<GenerateWeartryResult>) => {
    setSubmitting(true)
    try {
      const res = await run()
      if (!res.ok || !res.batchTag) {
        toast.error(res.error ?? "提交失败")
        return
      }
      setActiveBatchTag(res.batchTag)
      setBatchTasks([])
      toast.success(
        `已提交 ${res.taskIds?.length ?? 0} 个任务，扣费 ${res.totalCost ?? 0} 积分`,
      )
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  // ── 批次轮询（5s；页面隐藏暂停；全部终态停止）──
  useEffect(() => {
    if (!activeBatchTag) return
    let stop = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const tasks = await getWeartryBatchStatusAction(activeBatchTag)
        if (stop) return
        setBatchTasks(tasks)
        const allDone = tasks.every(
          (t) => t.status === "completed" || t.status === "failed",
        )
        if (allDone) {
          router.refresh()
          if (tasks.some((t) => t.status === "failed")) {
            const refunded = tasks.reduce((s, t) => s + t.refunded, 0)
            toast.warning(
              `批次完成（失败已退 ${refunded} 积分，可单张重试）`,
            )
          } else {
            toast.success("生成完成")
          }
        }
        return allDone
      } catch {
        return false
      }
    }
    const timer = setInterval(async () => {
      const done = await tick()
      if (done) clearInterval(timer)
    }, 5000)
    void tick()
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [activeBatchTag, router])

  const retryTask = async (taskId: string) => {
    setRetryingId(taskId)
    try {
      const res = await retryWeartryTaskAction(taskId)
      if (!res.ok) {
        toast.error(res.error ?? "重试失败")
        return
      }
      toast.success("已重新入队")
      if (activeBatchTag) {
        setBatchTasks(await getWeartryBatchStatusAction(activeBatchTag))
      }
    } finally {
      setRetryingId(null)
    }
  }

  const intro = tab !== "history" ? WEARTRY_INTROS[tab] : null
  /** 各 tab 共享的提交入口（表单组件持有各自状态，父级接管批次轮询） */
  const formProps = {
    models: initialModels,
    creditsBalance,
    submitting,
    onSubmit: (run: () => Promise<GenerateWeartryResult>) => void submit(run),
  }

  return (
    /* 7rem = inset 侧栏上下 m-2(各8px) + 顶栏 h-16(64px) + 内容区 p-4(上下各16px)，改壳层高度需同步 */
    <div className="flex flex-col gap-4 lg:h-[calc(100svh-7rem)] lg:overflow-hidden">
      {/* 顶部行：左侧功能 tab（固定，不随面板滚动）+ 右侧生成历史入口 */}
      <div className="flex shrink-0 items-center justify-between gap-4">
        <Tabs
          value={tab}
          onValueChange={(v) => handleTabChange(v as string)}
          className="min-w-0"
        >
          <TabsList>
            {TAB_MODES.map((m) => {
              const Icon = MODE_ICONS[m]
              return (
                <TabsTrigger key={m} value={m} className="px-3">
                  <Icon />
                  {WEARTRY_MODE_LABELS[m]}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-2">
          {tab === "history" && (
            <>
              <HistoryDateRangePicker
                value={historyDateRange}
                onChange={setHistoryDateRange}
              />
              <Select
                value={historyModeFilter}
                onValueChange={(v) =>
                  setHistoryModeFilter((v as "all" | WeartryMode) ?? "all")
                }
              >
                <SelectTrigger aria-label="筛选生成类型" className="w-32">
                  <SelectValue>
                    {HISTORY_FILTER_ITEMS.find(
                      (i) => i.value === historyModeFilter,
                    )?.label ?? "全部"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-32">
                  {HISTORY_FILTER_ITEMS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={historyLoading}
                onClick={() => void refreshHistory()}
              >
                {historyLoading ? (
                  <MorphingInfinity className="mr-1 size-3.5" />
                ) : (
                  <RefreshCw className="mr-1 size-3.5" />
                )}
                刷新
              </Button>
            </>
          )}
          <Button
            type="button"
            variant={tab === "history" ? "default" : "outline"}
            size="default"
            className="shrink-0"
            onClick={() => handleTabChange("history")}
          >
            <History />
            生成历史
          </Button>
        </div>
      </div>

      {tab === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          <WeartryHistoryPanel
            batches={filteredBatches}
            onRetry={(id) => void retryTask(id)}
            retryingId={retryingId}
            loading={historyLoading}
            filterActive={historyFilterActive}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[380px_1fr] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
          {/* ── 左侧：功能输入面板（固定高度内滚动，隐藏滚动条）── */}
          <div className="space-y-4 rounded-xl border bg-card p-4 lg:min-h-0 lg:overflow-y-auto scrollbar-hide">
            {tab === "outfit" && (
              <OutfitForm {...formProps} directions={directions} />
            )}
            {(tab === "model" || tab === "accessory") && (
              <TryonForm
                {...formProps}
                key={tab}
                mode={tab}
                scenes={scenes}
              />
            )}
            {tab === "color" && <ColorForm {...formProps} />}
          </div>

          {/* ── 右侧：内容区（固定板块；结果网格内部滚动，隐藏滚动条）── */}
          <div className="rounded-xl border bg-card p-6 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
            {activeBatchTag ? (
              <BatchView
                tasks={batchTasks}
                onRetry={(id) => void retryTask(id)}
                retryingId={retryingId}
              />
            ) : (
              intro && <IntroPanel intro={intro} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 右侧介绍区（未提交时） */
function IntroPanel({
  intro,
}: {
  intro: { title: string; description: string; points: string[] }
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 py-10 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">{intro.title}</h2>
        <p className="text-sm text-muted-foreground">{intro.description}</p>
      </div>

      {/* 示例流程：原图 → 生成 */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <div className="flex size-24 items-center justify-center rounded-lg border-2 border-dashed border-border text-xs text-muted-foreground">
          原图
        </div>
        <span className="text-muted-foreground">→</span>
        {[null, null, null].map((_, i) => (
          <div
            key={i}
            className="flex size-24 items-center justify-center rounded-lg border bg-gradient-to-br from-primary/5 to-primary/15 text-xs text-muted-foreground"
          >
            生成图 {i + 1}
          </div>
        ))}
      </div>

      <ul className="space-y-1.5 text-left text-sm text-muted-foreground">
        {intro.points.map((b) => (
          <li key={b} className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-primary" />
            {b}
          </li>
        ))}
      </ul>
    </div>
  )
}
