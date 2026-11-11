"use client"

import * as React from "react"
import { Pencil, Plus } from "lucide-react"
import { BadgeCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm, useWatch } from "react-hook-form"
import type { z } from "zod"
import { cn } from "@/lib/utils"
import { planFormSchema } from "@/lib/forms/schemas"
import {
  BADGE_ICON_KEYS,
  normalizeBadgeIconKey,
  type BadgeIconKey,
} from "@/lib/plans/badge"
import { BADGE_ICON_MAP, PlanBadge } from "@/components/shared/plan-badge"
import {
  createSubscriptionPlanAction,
  updateSubscriptionPlanAction,
} from "@/server/actions/platform-plans"

/** 勋章预设色板（补 hex 输入之外的一键选择） */
const PRESET_COLORS = [
  "#10b981", // 翡翠绿（Lite）
  "#8b5cf6", // 紫（Pro）
  "#f59e0b", // 琥珀（Max）
  "#3b82f6", // 蓝
  "#ef4444", // 红
  "#ec4899", // 粉
  "#14b8a6", // 青
  "#f97316", // 橙
  "#6366f1", // 靛
  "#64748b", // 石板灰
] as const

export interface PlanFormValues {
  id?: string
  name: string
  iconKey: string
  color: string
  creditsPerCycle: number
  cycleDays: number
  maxMembers: number | null
  sortOrder?: number
  isActive?: boolean
}

/** schema 的 maxMembers 带 transform（""/null → null）：input/output 分型 */
type PlanFormInput = z.input<typeof planFormSchema>
type PlanFormOutput = z.output<typeof planFormSchema>

function toDefaults(plan?: PlanFormValues): PlanFormInput {
  return {
    name: plan?.name ?? "",
    iconKey: plan ? normalizeBadgeIconKey(plan.iconKey) : "medal",
    color: plan?.color ?? "#8b5cf6",
    creditsPerCycle: plan?.creditsPerCycle ?? 10000,
    cycleDays: plan?.cycleDays ?? 30,
    maxMembers: plan?.maxMembers ?? null,
    isActive: plan?.isActive ?? true,
  }
}

/**
 * 套餐新建/编辑弹窗（超管）：
 * 名称 + 勋章（预设图标网格 + 颜色）+ 周期积分 + 周期天数 + 人数上限。
 * 顺序由套餐列表拖拽维护；顶部实时预览勋章药丸（侧边栏/弹窗中的实际观感）。
 */
export function PlanFormDialog({
  plan,
  trigger,
}: {
  /** 传入即编辑模式 */
  plan?: PlanFormValues
  /** 自定义触发器（缺省为「新建套餐」按钮） */
  trigger?: React.ReactElement
}) {
  const isEdit = !!plan
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<PlanFormInput, unknown, PlanFormOutput>({
    resolver: standardSchemaResolver(planFormSchema),
    defaultValues: toDefaults(plan),
  })
  const pending = form.formState.isSubmitting

  // 预览随表单实时联动（useWatch：hook 订阅，React Compiler 可记忆化）
  const iconKey = useWatch({ control: form.control, name: "iconKey" })
  const color = useWatch({ control: form.control, name: "color" })
  const name = useWatch({ control: form.control, name: "name" })

  // 每次打开重置为最新 props（编辑场景列表刷新后数据可能变化）
  React.useEffect(() => {
    if (open) {
      form.reset(toDefaults(plan))
      setServerError(null)
    }
  }, [open, form, plan])

  async function onSubmit(values: PlanFormOutput) {
    setServerError(null)
    const input = {
      name: values.name,
      iconKey: values.iconKey,
      color: values.color,
      creditsPerCycle: values.creditsPerCycle,
      cycleDays: values.cycleDays,
      maxMembers: values.maxMembers ?? null,
    }
    const res = isEdit
      ? await updateSubscriptionPlanAction({
          id: plan!.id,
          ...input,
          isActive: values.isActive ?? true,
        })
      : await createSubscriptionPlanAction(input)
    if (res.ok) {
      toast.success(isEdit ? "套餐已更新" : "套餐已创建")
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误：统一条内联展示，不再 toast
    setServerError(res.error ?? "保存失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button size="sm">
              <Plus className="size-4" />
              新建套餐
            </Button>
          )
        }
      />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑套餐" : "新建套餐"}</DialogTitle>
          <DialogDescription>
            勋章将展示在成员侧边栏用户名旁与账户弹窗中
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 实时预览 */}
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
              <span className="text-xs text-muted-foreground">勋章预览</span>
              <PlanBadge
                iconKey={iconKey}
                color={color}
                name={name.trim() || "套餐名"}
                size="md"
              />
              <PlanBadge
                iconKey={iconKey}
                color={color}
                name={name.trim() || "套餐名"}
                size="sm"
              />
            </div>

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>套餐名称</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="如 Lite / Pro / Max" maxLength={50} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="iconKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>勋章图标</FormLabel>
                  <FormControl>
                    <div className="grid grid-cols-6 gap-2">
                      {BADGE_ICON_KEYS.map((key: BadgeIconKey) => {
                        const Icon = BADGE_ICON_MAP[key]
                        const active = field.value === key
                        return (
                          <button
                            key={key}
                            type="button"
                            title={key}
                            onClick={() => field.onChange(key)}
                            className={cn(
                              "flex aspect-square items-center justify-center rounded-md border transition-colors",
                              active
                                ? "border-primary bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-accent",
                            )}
                          >
                            <Icon className="size-5" />
                          </button>
                        )
                      })}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="color"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>勋章颜色</FormLabel>
                  <FormControl>
                    <div className="flex flex-wrap items-center gap-2">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={c}
                          onClick={() => field.onChange(c)}
                          className={cn(
                            "flex size-7 items-center justify-center rounded-md border transition-transform hover:scale-110",
                            field.value.toUpperCase() === c.toUpperCase() &&
                              "ring-2 ring-primary ring-offset-1",
                          )}
                          style={{ backgroundColor: c }}
                        >
                          {field.value.toUpperCase() === c.toUpperCase() ? (
                            <BadgeCheck className="size-4 text-white/90" />
                          ) : null}
                        </button>
                      ))}
                      <Input
                        value={field.value}
                        onChange={(e) => field.onChange(e.target.value)}
                        className="ml-1 w-28 font-mono text-xs"
                        placeholder="#RRGGBB"
                        maxLength={7}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="creditsPerCycle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>每周期积分额度</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={1_000_000}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? undefined : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cycleDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>周期天数</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={3650}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? undefined : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maxMembers"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>人数上限（可选）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={10_000}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? null : Number(e.target.value),
                          )
                        }
                        placeholder="不限"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {isEdit ? (
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border px-4 py-3">
                    <div className="text-sm">
                      启用套餐
                      <span className="ml-2 text-xs text-muted-foreground">
                        停用后不可新分配，存量订阅履约至到期
                      </span>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                        disabled={pending}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}

            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "保存中…" : isEdit ? "保存修改" : "创建套餐"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

/** 编辑入口按钮（列表行内） */
export function PlanEditButton({ plan }: { plan: PlanFormValues }) {
  return (
    <PlanFormDialog
      plan={plan}
      trigger={
        <Button variant="ghost" size="icon-sm" title="编辑">
          <Pencil className="size-4" />
        </Button>
      }
    />
  )
}
