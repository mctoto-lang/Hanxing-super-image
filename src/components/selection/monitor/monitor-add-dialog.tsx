"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useWatch, useForm } from "react-hook-form"
import { z } from "zod"
import { Crosshair } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { DashRing } from "@/components/ui/dash-ring"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CountryFlag, PlatformInlineIcon } from "@/components/selection/platform-badges"
import { platformLabel } from "@/components/selection/labels"
import {
  SELECTION_PLATFORM_CONFIGS,
  estimateCredits,
  hasInlineReviews,
  isSelectionPlatform,
} from "@/lib/selection/platforms"
import { resolveMonitorTarget } from "@/lib/selection/monitor-target"
import { countryLabel } from "@/lib/selection/platforms"
import { addSelectionMonitorByUrlAction } from "@/server/actions/selection-monitor"

/**
 * 添加监控（粘贴链接）：不必先在数据池里找到——粘贴 Amazon / Etsy / TEMU 商品链接或
 * 社媒帖子链接，实时解析出平台与国家，提交后立即发起首轮抓取。
 * 表单走全站统一的 RHF + zod 口径；首轮费用 = 指标重抓（按平台费率）+ 评论抓取。
 */

const addMonitorSchema = z.object({
  url: z.string().trim().min(1, "请输入商品 / 帖子链接"),
  intervalHours: z.number().int(),
  trackReviews: z.boolean(),
})
type AddMonitorValues = z.input<typeof addMonitorSchema>

const INTERVAL_OPTIONS = [
  { value: "24", label: "每天" },
  { value: "48", label: "每 2 天" },
  { value: "72", label: "每 3 天" },
  { value: "168", label: "每周" },
]

export function MonitorAddDialog() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<AddMonitorValues>({
    resolver: standardSchemaResolver(addMonitorSchema),
    defaultValues: { url: "", intervalHours: 24, trackReviews: true },
  })
  const pending = form.formState.isSubmitting
  // useWatch 而非内联 form.watch（react-compiler 兼容，见 react-hooks/incompatible-library）
  const url = useWatch({ control: form.control, name: "url" })
  const trackReviews = useWatch({ control: form.control, name: "trackReviews" })

  React.useEffect(() => {
    if (open) {
      form.reset({ url: "", intervalHours: 24, trackReviews: true })
      setServerError(null)
    }
  }, [open, form])

  // 实时解析：识别出平台后展示平台 / 国家与首轮费用
  const parsed = url?.trim() ? resolveMonitorTarget(url) : null
  const target = parsed?.ok ? parsed.target : null
  const cfg = target && isSelectionPlatform(target.platform) ? SELECTION_PLATFORM_CONFIGS[target.platform] : null
  const canReviews = Boolean(cfg?.monitor?.reviewActorId)
  /** 有指标重抓任务（Etsy 无：仅评论追踪，服务端只建 review 任务） */
  const hasMetrics = Boolean(cfg?.monitor?.metricsActorId)
  /** 评论随指标任务一并带回（reddit）：不建独立评论任务、不单独计评论费 */
  const inlineReviews = target ? hasInlineReviews(target.platform) : false
  const creditsFor = (taskType: "monitor" | "review") =>
    target ? estimateCredits(target.platform, taskType, taskType === "review" ? cfg!.monitor!.reviewMaxPerTask : 1) : 0

  const onSubmit = async (v: AddMonitorValues) => {
    setServerError(null)
    const res = await addSelectionMonitorByUrlAction({
      url: v.url,
      intervalHours: v.intervalHours,
      trackReviews: canReviews && v.trackReviews,
    })
    if (res.ok) {
      toast.success("已添加监控，首轮抓取已发起（数据任务页可跟踪进度）")
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "添加失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Crosshair className="size-4" />
            添加监控
          </Button>
        }
      />
      {open ? (
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>添加监控目标</DialogTitle>
            <DialogDescription>
              粘贴商品或帖子链接即可加入竞品监控，按设定周期自动重抓；费用从你的个人配额扣除，积分不足会自动暂停。
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>商品 / 帖子链接</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="如 https://www.amazon.com/dp/B0BTYDLTM3"
                        autoComplete="off"
                        onChange={(e) => field.onChange(e.target.value)}
                      />
                    </FormControl>
                    {parsed && !parsed.ok && url?.trim() ? (
                      <p className="text-xs text-destructive">{parsed.error}</p>
                    ) : null}
                    {target ? (
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                          <PlatformInlineIcon platform={target.platform} size={12} />
                          {platformLabel(target.platform)}
                        </span>
                        {target.country ? (
                          <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                            <CountryFlag code={target.country} size={11} />
                            {countryLabel(target.country) || target.country}
                          </span>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger render={<span className="max-w-full truncate" />}>
                            {target.url}
                          </TooltipTrigger>
                          <TooltipContent className="max-w-md break-all">{target.url}</TooltipContent>
                        </Tooltip>
                      </p>
                    ) : null}
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="intervalHours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>重抓周期</FormLabel>
                      <Select
                        items={INTERVAL_OPTIONS}
                        value={String(field.value)}
                        onValueChange={(v) => field.onChange(Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {INTERVAL_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                {canReviews && hasMetrics ? (
                  <FormField
                    control={form.control}
                    name="trackReviews"
                    render={({ field }) => (
                      <FormItem className="space-y-2">
                        <FormLabel>评论追踪</FormLabel>
                        <label className="flex h-8 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                          <Switch checked={field.value} onCheckedChange={(v) => field.onChange(v)} />
                          随重抓一起抓评论并生成 AI 洞察
                        </label>
                      </FormItem>
                    )}
                  />
                ) : (
                  <div />
                )}
              </div>

              {target && cfg ? (
                <div className="space-y-1 rounded-lg border px-3 py-2 text-xs">
                  <p className="text-muted-foreground">
                    首轮预扣：
                    {/* 按平台能力与「评论追踪」开关给出与服务端建任务口径一致的预估：
                        无指标重抓（如 Etsy）只计评论费；评论随指标任务带回的平台
                        （reddit）不另计评论费 */}
                    {hasMetrics ? `指标重抓 ${creditsFor("monitor")} 积分` : `评论抓取 ${creditsFor("review")} 积分`}
                    {hasMetrics && canReviews && trackReviews
                      ? inlineReviews
                        ? "（评论随指标重抓一并带回，不另计评论费）"
                        : ` + 评论抓取 ${creditsFor("review")} 积分`
                      : ""}
                    <span className="ml-1">（按实际抓到的条数结算，多退少不补）</span>
                  </p>
                  {cfg.monitor?.metricsNote ? <p className="text-muted-foreground">{cfg.monitor.metricsNote}</p> : null}
                </div>
              ) : null}

              {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={pending || !target}>
                  {pending ? <DashRing className="size-4" /> : <Crosshair className="size-4" />}
                  添加并抓取
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
