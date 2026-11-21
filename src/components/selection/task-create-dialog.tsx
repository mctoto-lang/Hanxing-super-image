"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plus, Search } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SELECTION_PLATFORMS,
  SELECTION_PLATFORM_CONFIGS,
  estimateCredits,
  getFormFields,
  type SelectionPlatform,
} from "@/lib/selection/platforms"
import { trackSelectionTask } from "@/lib/selection/notifier-store"
import { createSelectionTaskAction } from "@/server/actions/selection"

/**
 * 新建抓取任务弹窗（数据任务页唯一抓取入口）
 *
 * 类型（发现/市场）+ 平台 → 注册表字段声明驱动动态表单 → 实时积分预估 →
 * 提交（预扣积分）→ 全局通知登记 + toast。
 */

const ECOMMERCE = SELECTION_PLATFORMS.filter(
  (p) => SELECTION_PLATFORM_CONFIGS[p].category === "ecommerce",
)
const SOCIAL = SELECTION_PLATFORMS.filter(
  (p) => SELECTION_PLATFORM_CONFIGS[p].category === "social",
)

function defaultsFor(fields: ReturnType<typeof getFormFields>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (f.defaultValue != null) out[f.key] = String(f.defaultValue)
  }
  return out
}

export function TaskCreateDialog({
  userCredits,
  apifyReady,
}: {
  userCredits: number
  apifyReady: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [taskType, setTaskType] = React.useState<"discover" | "market">("market")
  const [platform, setPlatform] = React.useState<SelectionPlatform>(ECOMMERCE[0])
  const cfg = SELECTION_PLATFORM_CONFIGS[platform]
  const fields = React.useMemo(() => getFormFields(platform, taskType), [platform, taskType])
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    defaultsFor(getFormFields(ECOMMERCE[0], "market")),
  )
  const [maxResults, setMaxResults] = React.useState(
    SELECTION_PLATFORM_CONFIGS[ECOMMERCE[0]].defaultResults,
  )
  const [pending, setPending] = React.useState(false)

  const switchPlatform = (next: SelectionPlatform) => {
    setPlatform(next)
    setValues(defaultsFor(getFormFields(next, taskType)))
    setMaxResults(SELECTION_PLATFORM_CONFIGS[next].defaultResults)
  }
  const switchTaskType = (next: "discover" | "market") => {
    setTaskType(next)
    setValues(defaultsFor(getFormFields(platform, next)))
  }

  const rate =
    taskType === "discover" && cfg.discover?.creditsPerResult != null
      ? cfg.discover.creditsPerResult
      : cfg.creditsPerResult
  const safeMax = Math.max(
    cfg.minResults,
    Math.min(Number.isFinite(maxResults) ? maxResults : cfg.defaultResults, cfg.maxResultsPerTask),
  )
  const estimate = estimateCredits(platform, taskType, safeMax)
  const insufficient = userCredits < estimate
  const discoverMeta = taskType === "discover" ? cfg.discover : undefined

  const submit = async () => {
    setPending(true)
    try {
      const res = await createSelectionTaskAction({
        platform,
        taskType,
        maxResults: safeMax,
        params: values,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      const label = `${cfg.label}${discoverMeta ? `·${discoverMeta.label}` : ""}「${values.keyword ?? values.domain ?? values.subreddit ?? values.categoryUrl ?? ""}」`
      trackSelectionTask({ taskId: res.taskId, label })
      toast.success(`任务已提交（预扣 ${res.estimatedCredits} 积分），抓取完成后将通知你`, {
        duration: 8000,
        action: {
          label: "查看任务",
          onClick: () => router.push("/selection/tasks"),
        },
      })
      setOpen(false)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" />
            新建抓取任务
          </Button>
        }
      />
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>新建抓取任务</DialogTitle>
          <DialogDescription>
            按实际抓取条数结算：完成后自动退还（预扣 − 实际）差额；失败/取消全额退还。
          </DialogDescription>
        </DialogHeader>

        {!apifyReady ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            企业未配置选品抓取凭证（Apify Token），请联系超管在「平台管理 → 企业 →
            选品抓取」配置，或由平台配置全局兜底 Token。
          </div>
        ) : (
          <div className="space-y-4">
            {/* 任务类型 + 平台 */}
            <div className="flex flex-wrap items-center gap-2">
              <Tabs
                value={taskType}
                onValueChange={(v) => switchTaskType(v as "discover" | "market")}
              >
                <TabsList>
                  <TabsTrigger value="market">市场分析</TabsTrigger>
                  <TabsTrigger value="discover">选品发现</TabsTrigger>
                </TabsList>
              </Tabs>
              <Select
                items={[...ECOMMERCE, ...SOCIAL].map((p) => ({
                  value: p,
                  label: SELECTION_PLATFORM_CONFIGS[p].label,
                }))}
                value={platform}
                onValueChange={(v) => {
                  if (v != null) switchPlatform(v as SelectionPlatform)
                }}
              >
                <SelectTrigger size="sm" aria-label="平台" className="w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="amazon">Amazon</SelectItem>
                  <SelectItem value="etsy">Etsy</SelectItem>
                  <SelectItem value="temu">TEMU</SelectItem>
                  <SelectItem value="shopify">Shopify 独立站</SelectItem>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="tiktok">TikTok</SelectItem>
                  <SelectItem value="pinterest">Pinterest</SelectItem>
                  <SelectItem value="reddit">Reddit</SelectItem>
                  <SelectItem value="x">X（Twitter）</SelectItem>
                  <SelectItem value="facebook">Facebook</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 模式说明（发现模式） */}
            {discoverMeta ? (
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="font-medium">{discoverMeta.label}</span>
                <span className="ml-2 text-muted-foreground">{discoverMeta.description}</span>
              </div>
            ) : null}

            {/* 动态表单 */}
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`sel-${f.key}`}>
                    {f.label}
                    {f.required ? <span className="ml-0.5 text-red-500">*</span> : null}
                  </Label>
                  {f.type === "select" && f.options ? (
                    <Select
                      items={f.options}
                      value={values[f.key] ?? f.defaultValue ?? null}
                      onValueChange={(v) => {
                        if (v != null) setValues((s) => ({ ...s, [f.key]: String(v) }))
                      }}
                    >
                      <SelectTrigger id={`sel-${f.key}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {f.options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={`sel-${f.key}`}
                      type={f.type === "number" ? "number" : "text"}
                      inputMode={f.type === "number" ? "numeric" : undefined}
                      placeholder={f.placeholder}
                      min={f.min}
                      max={f.max}
                      value={values[f.key] ?? ""}
                      onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  )}
                  {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
                </div>
              ))}

              {/* 结果条数 */}
              <div className="space-y-1.5">
                <Label htmlFor="sel-max">
                  结果数量
                  <span className="ml-1 text-xs text-muted-foreground">
                    （{cfg.minResults}~{cfg.maxResultsPerTask}）
                  </span>
                </Label>
                <Input
                  id="sel-max"
                  type="number"
                  min={cfg.minResults}
                  max={cfg.maxResultsPerTask}
                  value={maxResults}
                  onChange={(e) => setMaxResults(Number(e.target.value))}
                />
              </div>
            </div>

            {/* 计费预估 */}
            <div className="rounded-lg border px-3 py-2.5 text-sm">
              <span className="font-medium">{safeMax} 条</span>
              <span className="mx-1 text-muted-foreground">×</span>
              <span className="font-medium">{rate} 积分/条</span>
              <span className="mx-1 text-muted-foreground">≈</span>
              <span className={insufficient ? "font-semibold text-red-500" : "font-semibold"}>
                {estimate} 积分
              </span>
              <span className="ml-3 text-xs text-muted-foreground">
                个人配额余额 {userCredits}
              </span>
              {insufficient ? (
                <span className="ml-2 text-xs text-red-500">积分不足，请先找管理员分配</span>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          {apifyReady ? (
            <Button onClick={submit} disabled={pending || insufficient}>
              {pending ? <DashRing className="size-4" /> : <Search className="size-4" />}
              开始抓取
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
