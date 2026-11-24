"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useForm, useWatch, type FieldErrors } from "react-hook-form"
import { Plus, Search } from "lucide-react"
import { toast } from "sonner"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { PlatformLogo } from "@/components/selection/platform-badges"
import { compactNumber } from "@/components/selection/labels"
import {
  SELECTION_DAILY_TASK_LIMIT,
  SELECTION_KEYWORD_MAX_LEN,
  SELECTION_PLATFORM_CONFIGS,
  estimateCredits,
  getFormFields,
  isSelectionPlatform,
  platformsForCategory,
  resultLimitsFor,
  type PlatformField,
  type SelectionPlatform,
} from "@/lib/selection/platforms"
import { createSelectionTaskAction } from "@/server/actions/selection"
import { trackSelectionTask } from "@/lib/selection/notifier-store"
import { cn } from "@/lib/utils"

/**
 * 新建抓取任务弹窗（数据任务页唯一抓取入口）
 *
 * 类型（发现 / 市场）+ 平台 → 注册表字段声明驱动动态表单 → 实时积分预估 →
 * 提交（预扣积分）→ 全局通知登记 + toast。表单走全站统一的 RHF + zod 口径：
 * 字段级内联校验（必填 / 数字范围 / 选项条件 showWhen），平台切换时字段与
 * 默认值整组重置。支持从其它页面带平台 / 类型预置并直接打开
 * （?new=1&platform=amazon&type=discover）。
 */

type TaskType = "discover" | "market"

interface FormValues {
  taskType: TaskType
  platform: SelectionPlatform
  /** 动态字段值（键 = 注册表字段 key） */
  params: Record<string, string | number>
  maxResults: number
}

/** 当前字段集下可见的选项（showWhen：仅当引用字段当前值在 in 里时可选） */
function visibleOptions(f: PlatformField, params: Record<string, string | number>): NonNullable<PlatformField["options"]> {
  const opts = f.options ?? []
  return opts.filter((o) => {
    if (!o.showWhen) return true
    const ref = params[o.showWhen.field]
    return ref != null && ref !== "" && o.showWhen.in.includes(String(ref))
  })
}

/**
 * 动态表单校验：按注册表字段声明逐项校验（与服务端 sanitizeParams 同口径，绕过
 * 前端的不支持组合同样会被服务端拒绝）。字段集随平台 / 类型变化，zod schema 无法
 * 静态表达，故直接产出 RHF 的 FieldErrors（项目内「原生 resolver 桥接」同款做法）。
 */
function validateTaskForm(platform: SelectionPlatform, taskType: TaskType, v: FormValues): FieldErrors<FormValues> {
  const fields = getFormFields(platform, taskType)
  const limits = resultLimitsFor(platform, taskType)
  const paramsErrors: Record<string, { type: "custom"; message: string }> = {}
  const fail = (key: string, message: string) => {
    if (!paramsErrors[key]) paramsErrors[key] = { type: "custom", message }
  }
  for (const f of fields) {
    const raw = v.params[f.key]
    const val = typeof raw === "number" ? String(raw) : (raw ?? "").trim()
    if (val === "") {
      if (f.required) fail(f.key, `请填写「${f.label}」`)
      continue
    }
    if (f.type === "number") {
      const n = Number(val)
      if (!Number.isFinite(n)) {
        fail(f.key, `「${f.label}」须为数字`)
        continue
      }
      if (f.min != null && n < f.min) fail(f.key, `不得小于 ${f.min}`)
      if (f.max != null && n > f.max) fail(f.key, `不得大于 ${f.max}`)
      continue
    }
    // 文本长度上限与服务端 sanitizeParams 同口径（此前只判空，超长提交后才被拒）
    if (f.type === "text" && val.length > SELECTION_KEYWORD_MAX_LEN) {
      fail(f.key, `「${f.label}」过长（≤${SELECTION_KEYWORD_MAX_LEN} 字符）`)
    }
    if (f.type === "select" && f.options) {
      const opt = f.options.find((o) => o.value === val)
      if (!opt) {
        fail(f.key, `「${f.label}」取值无效`)
      } else if (opt.showWhen) {
        const refRaw = v.params[opt.showWhen.field]
        const refField = fields.find((x) => x.key === opt.showWhen!.field)
        const ref =
          refRaw != null && refRaw !== "" ? String(refRaw) : String(refField?.defaultValue ?? "")
        if (!opt.showWhen.in.includes(ref)) {
          fail(f.key, `「${f.label}」在当前选择下暂不支持，请更换`)
        }
      }
    }
  }
  const errors: FieldErrors<FormValues> = {}
  if (Object.keys(paramsErrors).length > 0) errors.params = paramsErrors
  if (!Number.isFinite(v.maxResults) || v.maxResults < limits.min || v.maxResults > limits.max) {
    errors.maxResults = { type: "custom", message: `结果数量须在 ${limits.min}~${limits.max} 之间` }
  }
  return errors
}

function defaultsFor(platform: SelectionPlatform, taskType: TaskType): FormValues {
  const out: Record<string, string | number> = {}
  for (const f of getFormFields(platform, taskType)) {
    if (f.defaultValue != null) out[f.key] = String(f.defaultValue)
  }
  return {
    taskType,
    platform,
    params: out,
    maxResults: resultLimitsFor(platform, taskType).default,
  }
}

export function TaskCreateDialog({
  userCredits,
  apifyReady,
  initialPlatform,
  initialTaskType,
  autoOpen = false,
  todayUsed,
}: {
  userCredits: number
  apifyReady: boolean
  /** 预置平台 / 类型（其它页面「抓取该平台数据」入口带入） */
  initialPlatform?: string
  initialTaskType?: string
  /** 带预置参数进入时直接打开弹窗（?new=1） */
  autoOpen?: boolean
  /** 当前用户今日已提交任务数（展示每日剩余额度） */
  todayUsed: number
}) {
  const router = useRouter()
  const startPlatform: SelectionPlatform =
    initialPlatform && isSelectionPlatform(initialPlatform) ? initialPlatform : "amazon"
  const startType: TaskType = initialTaskType === "discover" ? "discover" : "market"
  const [open, setOpen] = React.useState(autoOpen)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<FormValues>({
    // schema 随平台 / 类型变化：按当前值动态校验（缺省回落初始平台）
    resolver: async (values) => {
      const p = isSelectionPlatform(values?.platform) ? values.platform : startPlatform
      const t: TaskType = values?.taskType === "discover" ? "discover" : "market"
      const errors = validateTaskForm(p, t, values)
      return Object.keys(errors).length > 0 ? { values: {}, errors } : { values, errors: {} }
    },
    defaultValues: defaultsFor(startPlatform, startType),
  })
  const pending = form.formState.isSubmitting
  // useWatch 而非内联 form.watch（react-compiler 兼容）
  const platform = useWatch({ control: form.control, name: "platform" })
  const taskType = useWatch({ control: form.control, name: "taskType" })
  const params = useWatch({ control: form.control, name: "params" })
  const maxResults = useWatch({ control: form.control, name: "maxResults" })

  React.useEffect(() => {
    if (open) {
      form.reset(defaultsFor(startPlatform, startType))
      setServerError(null)
    }
    // 仅在打开时复位（startPlatform / startType 由页面传入，变化即重新打开）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form])

  const curPlatform: SelectionPlatform = platform && isSelectionPlatform(platform) ? platform : startPlatform
  const curType: TaskType = taskType === "discover" ? "discover" : "market"
  const fields = getFormFields(curPlatform, curType)
  const limits = resultLimitsFor(curPlatform, curType)
  const safeMax = Math.max(limits.min, Math.min(Number.isFinite(maxResults) ? maxResults : limits.default, limits.max))
  const estimate = estimateCredits(curPlatform, curType, safeMax)
  const insufficient = userCredits < estimate
  const remaining = Math.max(0, SELECTION_DAILY_TASK_LIMIT - todayUsed)
  const cfg = SELECTION_PLATFORM_CONFIGS[curPlatform]
  const discoverMeta = curType === "discover" ? cfg.discover : undefined
  const curParams = params ?? {}

  /** 切换平台 / 类型：字段与默认值整组重置（不同平台字段集不同，旧值无意义） */
  const reconfigure = (nextPlatform: SelectionPlatform, nextType: TaskType) => {
    const keep = { ...defaultsFor(nextPlatform, nextType) }
    // 关键词在平台间通用：用户已输入则保留
    const kw = (curParams.keyword ?? "").toString()
    if (kw && getFormFields(nextPlatform, nextType).some((f) => f.key === "keyword")) {
      keep.params.keyword = kw
    }
    form.reset(keep)
  }

  /** 关闭弹窗：带预置参数（?new=1）进入时同步清掉 URL，否则刷新会再次自动弹出 */
  const closeDialog = () => {
    setOpen(false)
    if (autoOpen) router.replace("/selection/tasks")
  }

  const onSubmit = async (v: FormValues) => {
    setServerError(null)
    // 只提交当前字段集内的键（服务端同样按字段声明清洗，越权键丢弃）
    const cleanParams: Record<string, string | number> = {}
    for (const f of fields) {
      const raw = v.params[f.key]
      if (raw == null || raw === "") continue
      cleanParams[f.key] = raw
    }
    let res: Awaited<ReturnType<typeof createSelectionTaskAction>>
    try {
      res = await createSelectionTaskAction({
        platform: v.platform,
        taskType: v.taskType,
        maxResults: safeMax,
        params: cleanParams,
      })
    } catch (err) {
      // action 抛出的服务端异常（生产环境消息会被 Next 遮蔽）在此兜底提示，
      // 避免按钮转圈结束后无任何反馈
      toast.error(err instanceof Error ? err.message : "提交失败")
      return
    }
    if (!res.ok) {
      setServerError(res.error)
      return
    }
    const label = `${cfg.label}${discoverMeta ? `·${discoverMeta.label}` : ""}「${primaryLabel(v.params, fields)}」`
    trackSelectionTask({ taskId: res.taskId, label })
    toast.success(`任务已提交（预扣 ${res.estimatedCredits} 积分），抓取完成后将通知你`, {
      duration: 8000,
      action: {
        label: "查看任务",
        onClick: () => router.push("/selection/tasks?status=active"),
      },
    })
    closeDialog()
    router.refresh()
  }

  const ecommerce = platformsForCategory("ecommerce")
  const social = platformsForCategory("social")

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setOpen(true)
        else closeDialog()
      }}
    >
      {/* 凭证未配置时按钮禁用：Trigger 挂 span（Button disabled 带
          pointer-events-none，悬浮事件挂按钮上永不触发），提示原因 */}
      {!apifyReady ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
            <DialogTrigger
              render={
                <Button size="sm" disabled>
                  <Plus className="size-4" />
                  新建抓取任务
                </Button>
              }
            />
          </TooltipTrigger>
          <TooltipContent>企业未配置选品抓取凭证（Apify Token）</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger
          render={
            <Button size="sm">
              <Plus className="size-4" />
              新建抓取任务
            </Button>
          }
        />
      )}
      {open ? (
        <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden p-0 sm:max-w-[640px]">
          <DialogHeader className="px-6 pt-6 pb-2">
            <DialogTitle>新建抓取任务</DialogTitle>
            <DialogDescription>
              按实际抓取条数结算：完成后自动退还（预扣 − 实际）差额；失败 / 取消全额退还。
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-2">
                {!apifyReady ? (
                  <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                    企业未配置选品抓取凭证（Apify Token），请联系超管在「平台管理 → 企业 →
                    选品抓取」配置，或由平台配置全局兜底 Token。
                  </div>
                ) : (
                  <>
                    {/* 任务类型 + 平台 */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Tabs
                        value={curType}
                        onValueChange={(v) => reconfigure(curPlatform, v === "discover" ? "discover" : "market")}
                      >
                        <TabsList>
                          <TabsTrigger value="market">市场分析</TabsTrigger>
                          <TabsTrigger value="discover">选品发现</TabsTrigger>
                        </TabsList>
                      </Tabs>
                      <FormField
                        control={form.control}
                        name="platform"
                        render={({ field }) => (
                          <FormItem className="min-w-0">
                            <Select
                              items={[...ecommerce, ...social].map((p) => ({
                                value: p,
                                label: SELECTION_PLATFORM_CONFIGS[p].label,
                              }))}
                              value={field.value}
                              onValueChange={(v) => {
                                if (v != null && isSelectionPlatform(v)) {
                                  field.onChange(v)
                                  reconfigure(v, curType)
                                }
                              }}
                            >
                              <FormControl>
                                <SelectTrigger size="sm" aria-label="平台" className="w-44 text-xs">
                                  <PlatformLogo platform={field.value} size={14} />
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectLabel>电商平台</SelectLabel>
                                  {ecommerce.map((p) => (
                                    <SelectItem key={p} value={p}>
                                      <PlatformLogo platform={p} size={14} />
                                      {SELECTION_PLATFORM_CONFIGS[p].label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                                <SelectGroup>
                                  <SelectLabel>社媒平台</SelectLabel>
                                  {social.map((p) => (
                                    <SelectItem key={p} value={p}>
                                      <PlatformLogo platform={p} size={14} />
                                      {SELECTION_PLATFORM_CONFIGS[p].label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                    </div>

                    {/* 模式说明（发现模式） */}
                    {discoverMeta ? (
                      <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs">
                        <span className="font-medium">{discoverMeta.label}</span>
                        <span className="ml-2 text-muted-foreground">{discoverMeta.description}</span>
                      </div>
                    ) : null}

                    {/* 动态表单 */}
                    <div className="grid gap-4 sm:grid-cols-2">
                      {fields.map((f) => (
                        <FormField
                          key={f.key}
                          control={form.control}
                          name={`params.${f.key}` as `params.${string}`}
                          render={({ field }) => (
                            <FormItem className={cn(f.type === "text" && "sm:col-span-2")}>
                              <FormLabel>
                                {f.label}
                                {f.required ? <span className="ml-0.5 text-red-500">*</span> : null}
                              </FormLabel>
                              {f.type === "select" && f.options ? (
                                <Select
                                  items={visibleOptions(f, curParams)}
                                  value={field.value != null && field.value !== "" ? String(field.value) : null}
                                  onValueChange={(v) => field.onChange(v ?? "")}
                                >
                                  <FormControl>
                                    <SelectTrigger className="w-full">
                                      <SelectValue />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {visibleOptions(f, curParams).map((o) => (
                                      <SelectItem key={o.value} value={o.value}>
                                        {o.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <FormControl>
                                  <Input
                                    type={f.type === "number" ? "number" : "text"}
                                    inputMode={f.type === "number" ? "numeric" : undefined}
                                    placeholder={f.placeholder}
                                    min={f.min}
                                    max={f.max}
                                    maxLength={f.type === "text" ? SELECTION_KEYWORD_MAX_LEN : undefined}
                                    value={field.value ?? ""}
                                    onChange={(e) =>
                                      field.onChange(
                                        f.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value,
                                      )
                                    }
                                  />
                                </FormControl>
                              )}
                              {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      ))}

                      {/* 结果条数 */}
                      <FormField
                        control={form.control}
                        name="maxResults"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              结果数量
                              <span className="ml-1 text-xs text-muted-foreground">
                                （{limits.min}~{limits.max}）
                              </span>
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={limits.min}
                                max={limits.max}
                                value={Number.isFinite(field.value) ? field.value : ""}
                                onChange={(e) => field.onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </>
                )}
              </div>

              {/* 计费预估 + 操作（固定在弹窗底部，不随内容滚走） */}
              <div className="space-y-3 border-t px-6 py-4">
                {apifyReady ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="font-medium">{safeMax} 条</span>
                    <span className="text-muted-foreground">×</span>
                    <span className="font-medium">{estimateCredits(curPlatform, curType, 1)} 积分/条</span>
                    <span className="text-muted-foreground">≈</span>
                    <span className={cn("font-semibold", insufficient && "text-red-500")}>{estimate} 积分</span>
                    <span className="ml-auto flex items-center gap-3 text-muted-foreground">
                      <span>余额 {compactNumber(userCredits)}</span>
                      <span className={cn(remaining <= 3 && "text-amber-600 dark:text-amber-400")}>
                        今日剩余 {remaining} 次
                      </span>
                    </span>
                    {insufficient ? <span className="w-full text-red-500">积分不足，请先找管理员分配</span> : null}
                    {remaining <= 0 ? <span className="w-full text-red-500">今日任务数已达上限，请明天再试</span> : null}
                  </div>
                ) : null}
                {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={closeDialog}>
                    取消
                  </Button>
                  {apifyReady ? (
                    <Button type="submit" disabled={pending || insufficient || remaining <= 0}>
                      {pending ? <DashRing className="size-4" /> : <Search className="size-4" />}
                      开始抓取
                    </Button>
                  ) : null}
                </DialogFooter>
              </div>
            </form>
          </Form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

/** 任务展示名的主输入（关键词 / 域名 / 版块 / 榜单品类…） */
function primaryLabel(params: Record<string, string | number>, fields: PlatformField[]): string {
  for (const key of ["keyword", "domain", "subreddit", "category"]) {
    const v = params[key]
    if (v != null && String(v).trim() !== "") {
      if (key === "category") {
        const opt = fields.find((f) => f.key === "category")?.options?.find((o) => o.value === String(v))
        if (opt) return opt.label
      }
      return String(v)
    }
  }
  return ""
}
