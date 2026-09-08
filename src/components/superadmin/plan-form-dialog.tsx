"use client"

import * as React from "react"
import { Pencil, Plus } from "lucide-react"
import { BadgeCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import {
  BADGE_ICON_KEYS,
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
  sortOrder: number
  isActive?: boolean
}

const DEFAULT_VALUES: PlanFormValues = {
  name: "",
  iconKey: "medal",
  color: "#8b5cf6",
  creditsPerCycle: 10000,
  cycleDays: 30,
  maxMembers: null,
  sortOrder: 0,
}

/**
 * 套餐新建/编辑弹窗（超管）：
 * 名称 + 勋章（预设图标网格 + 颜色）+ 周期积分 + 周期天数 + 人数上限 + 排序。
 * 顶部实时预览勋章药丸（侧边栏/弹窗中的实际观感）。
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
  const [pending, setPending] = React.useState(false)
  const router = useRouter()

  const [values, setValues] = React.useState<PlanFormValues>(
    plan ?? DEFAULT_VALUES,
  )
  // 每次打开重置为最新 props（编辑场景列表刷新后数据可能变化）
  React.useEffect(() => {
    if (open) setValues(plan ?? DEFAULT_VALUES)
  }, [open, plan])

  const set = <K extends keyof PlanFormValues>(key: K, v: PlanFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }))

  async function handleSubmit() {
    setPending(true)
    try {
      const input = {
        name: values.name.trim(),
        iconKey: values.iconKey,
        color: values.color,
        creditsPerCycle: Number(values.creditsPerCycle),
        cycleDays: Number(values.cycleDays),
        maxMembers:
          values.maxMembers == null || Number.isNaN(Number(values.maxMembers))
            ? null
            : Number(values.maxMembers),
        sortOrder: Number(values.sortOrder) || 0,
      }
      const res = isEdit
        ? await updateSubscriptionPlanAction({ id: plan!.id, ...input })
        : await createSubscriptionPlanAction(input)
      if (res.ok) {
        toast.success(isEdit ? "套餐已更新" : "套餐已创建")
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "保存失败")
      }
    } finally {
      setPending(false)
    }
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

        <div className="space-y-4">
          {/* 实时预览 */}
          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3">
            <span className="text-xs text-muted-foreground">勋章预览</span>
            <PlanBadge
              iconKey={values.iconKey}
              color={values.color}
              name={values.name.trim() || "套餐名"}
              size="md"
            />
            <PlanBadge
              iconKey={values.iconKey}
              color={values.color}
              name={values.name.trim() || "套餐名"}
              size="sm"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="plan-name">套餐名称</Label>
            <Input
              id="plan-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="如 Lite / Pro / Max"
              maxLength={50}
            />
          </div>

          <div className="grid gap-2">
            <Label>勋章图标</Label>
            <div className="grid grid-cols-6 gap-2">
              {BADGE_ICON_KEYS.map((key: BadgeIconKey) => {
                const Icon = BADGE_ICON_MAP[key]
                const active = values.iconKey === key
                return (
                  <button
                    key={key}
                    type="button"
                    title={key}
                    onClick={() => set("iconKey", key)}
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
          </div>

          <div className="grid gap-2">
            <Label htmlFor="plan-color">勋章颜色</Label>
            <div className="flex flex-wrap items-center gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => set("color", c)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md border transition-transform hover:scale-110",
                    values.color.toUpperCase() === c.toUpperCase() &&
                      "ring-2 ring-primary ring-offset-1",
                  )}
                  style={{ backgroundColor: c }}
                >
                  {values.color.toUpperCase() === c.toUpperCase() ? (
                    <BadgeCheck className="size-4 text-white/90" />
                  ) : null}
                </button>
              ))}
              <Input
                id="plan-color"
                value={values.color}
                onChange={(e) => set("color", e.target.value)}
                className="ml-1 w-28 font-mono text-xs"
                placeholder="#RRGGBB"
                maxLength={7}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="plan-credits">每周期积分额度</Label>
              <Input
                id="plan-credits"
                type="number"
                min={1}
                max={1_000_000}
                value={values.creditsPerCycle}
                onChange={(e) => set("creditsPerCycle", Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="plan-cycle">周期天数</Label>
              <Input
                id="plan-cycle"
                type="number"
                min={1}
                max={3650}
                value={values.cycleDays}
                onChange={(e) => set("cycleDays", Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="plan-members">人数上限（可选）</Label>
              <Input
                id="plan-members"
                type="number"
                min={1}
                max={10_000}
                value={values.maxMembers ?? ""}
                onChange={(e) =>
                  set(
                    "maxMembers",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                placeholder="不限"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="plan-sort">排序（小在前）</Label>
              <Input
                id="plan-sort"
                type="number"
                min={0}
                max={9999}
                value={values.sortOrder}
                onChange={(e) => set("sortOrder", Number(e.target.value))}
              />
            </div>
          </div>

          {isEdit ? (
            <div className="flex items-center justify-between rounded-lg border px-4 py-3">
              <div className="text-sm">
                启用套餐
                <span className="ml-2 text-xs text-muted-foreground">
                  停用后不可新分配，存量订阅履约至到期
                </span>
              </div>
              <Switch
                checked={values.isActive ?? true}
                onCheckedChange={(v) => set("isActive", v)}
                disabled={pending}
              />
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={
                pending ||
                !values.name.trim() ||
                !/^#[0-9a-fA-F]{6}$/.test(values.color) ||
                Number(values.creditsPerCycle) < 1 ||
                Number(values.cycleDays) < 1
              }
            >
              {pending ? "保存中..." : isEdit ? "保存修改" : "创建套餐"}
            </Button>
          </div>
        </div>
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
