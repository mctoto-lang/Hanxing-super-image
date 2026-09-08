"use client"

import * as React from "react"
import { CalendarClock, Crown } from "lucide-react"
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
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import { PlanBadge } from "@/components/shared/plan-badge"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import {
  assignEnterprisePlanAction,
  clearEnterprisePlanAction,
  renewEnterprisePlanAction,
} from "@/server/actions/platform-plans"

/** 可分配的套餐（由 /platform/plans 列表传入，仅启用中 + 企业当前套餐） */
export interface AssignablePlan {
  id: string
  name: string
  iconKey: string
  color: string
  creditsPerCycle: number
  cycleDays: number
  maxMembers: number | null
  isActive: boolean
}

/** 企业当前订阅（无则 null） */
export interface CurrentPlanInfo {
  planId: string
  planName: string
  iconKey: string
  color: string
  /** ISO */
  expiresAt: string
  isExpired: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Date → datetime-local 输入值（本地时区） */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 给企业分配 / 更换 / 续期套餐（超管，/platform/enterprises 行内操作）：
 *
 * - 未分配 → 分配：重置周期锚点，立即发放首期积分到企业池；
 * - 选当前套餐 → 续期：仅延长到期时间（断档续期会重算周期并发放首期）；
 * - 选其它套餐 → 换套餐：重置周期锚点并立即发放新套餐首期；
 * - 取消套餐：停止后续发放，发放台账保留审计。
 */
export function PlanAssignDialog({
  enterpriseId,
  enterpriseName,
  current,
  plans,
}: {
  enterpriseId: string
  enterpriseName: string
  current: CurrentPlanInfo | null
  plans: AssignablePlan[]
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [clearOpen, setClearOpen] = React.useState(false)
  const router = useRouter()

  // 默认选中当前套餐（续期场景），否则第一个可分配套餐
  const [planId, setPlanId] = React.useState(
    current?.planId ?? plans.find((p) => p.isActive)?.id ?? plans[0]?.id ?? "",
  )
  const [expiresAt, setExpiresAt] = React.useState("")

  const selected = plans.find((p) => p.id === planId) ?? null
  const isRenew = !!current && current.planId === planId

  // 打开或切换套餐时重算默认到期：续期 = 当前到期(+或 now 取晚者) + 周期天数；分配 = now + 周期天数
  React.useEffect(() => {
    if (!open) return
    const plan = plans.find((p) => p.id === planId)
    if (!plan) return
    const now = new Date()
    let base = now
    if (current && current.planId === plan.id && !current.isExpired) {
      base = new Date(Math.max(now.getTime(), new Date(current.expiresAt).getTime()))
    }
    setExpiresAt(toLocalInput(new Date(base.getTime() + plan.cycleDays * DAY_MS)))
  }, [open, planId, plans, current])

  async function handleSubmit() {
    if (!selected || !expiresAt) return
    setPending(true)
    try {
      const expiresIso = new Date(expiresAt).toISOString()
      let ok = false
      let message = ""
      if (isRenew) {
        const res = await renewEnterprisePlanAction({
          enterpriseId,
          expiresAt: expiresIso,
        })
        ok = res.ok
        message = res.ok
          ? `${res.restarted ? "已重新开通并发放首期" : "续期成功"}` +
            (res.grantedCredits > 0
              ? `，本期发放 ${res.grantedCredits.toLocaleString("zh-CN")} 积分`
              : "")
          : res.error ?? "续期失败"
      } else {
        const res = await assignEnterprisePlanAction({
          enterpriseId,
          planId,
          expiresAt: expiresIso,
        })
        ok = res.ok
        message = res.ok
          ? `已分配套餐「${res.planName}」` +
            (res.grantedCredits > 0
              ? `，本期发放 ${res.grantedCredits.toLocaleString("zh-CN")} 积分`
              : "")
          : res.error ?? "分配失败"
      }
      if (ok) {
        toast.success(message)
        setOpen(false)
        router.refresh()
      } else {
        toast.error(message)
      }
    } finally {
      setPending(false)
    }
  }

  async function handleClear() {
    setPending(true)
    try {
      const res = await clearEnterprisePlanAction({ enterpriseId })
      if (res.ok) {
        toast.success("已取消企业套餐")
        setClearOpen(false)
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "取消失败")
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button variant="outline" size="sm">
              <Crown className="size-4" />
              {current ? "套餐续期" : "分配套餐"}
            </Button>
          }
        />
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{current ? "套餐续期 / 更换" : "分配套餐"}</DialogTitle>
            <DialogDescription>
              企业「{enterpriseName}」· 分配 / 更换后立即发放本期积分到企业积分池
            </DialogDescription>
          </DialogHeader>

          {current ? (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-xs text-muted-foreground">当前</span>
              <PlanBadge
                iconKey={current.iconKey}
                color={current.color}
                name={current.planName}
                isExpired={current.isExpired}
                size="sm"
              />
              <span className="ml-auto text-xs text-muted-foreground">
                到期 {new Date(current.expiresAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}
                {current.isExpired ? " · 已过期" : ""}
              </span>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label>选择套餐</Label>
            {plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                暂无可分配套餐，请先到「订阅套餐」页创建并启用
              </p>
            ) : (
              <div className="grid gap-2">
                {plans.map((p) => {
                  const active = p.id === planId
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlanId(p.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        active
                          ? "border-primary bg-primary/5"
                          : "hover:bg-accent",
                      )}
                    >
                      <PlanBadge
                        iconKey={p.iconKey}
                        color={p.color}
                        name={p.name}
                        size="md"
                      />
                      <span className="text-xs text-muted-foreground">
                        每 {p.cycleDays} 天 {p.creditsPerCycle.toLocaleString("zh-CN")} 积分
                        {p.maxMembers ? ` · 最多 ${p.maxMembers} 人` : ""}
                      </span>
                      {!p.isActive ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          已停用（仅续期可用）
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="plan-expires">
              <CalendarClock className="mr-1 inline size-3.5" />
              到期时间{isRenew ? "（续期需晚于当前到期时间）" : ""}
            </Label>
            <Input
              id="plan-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            {current ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setClearOpen(true)}
                disabled={pending}
              >
                取消套餐
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
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
                disabled={pending || !planId || !expiresAt}
              >
                {pending
                  ? "处理中..."
                  : isRenew
                    ? "确认续期"
                    : current
                      ? "确认更换"
                      : "确认分配"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="取消企业套餐"
        description={`确定取消「${enterpriseName}」的套餐吗？取消后停止周期发放，企业保留现有积分池余额，发放记录保留审计。`}
        confirmText="确认取消套餐"
        destructive
        pending={pending}
        onConfirm={handleClear}
      />
    </>
  )
}
