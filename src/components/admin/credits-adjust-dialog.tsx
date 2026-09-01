"use client"

import * as React from "react"
import { Scale } from "lucide-react"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { adjustUserCreditsAction } from "@/server/actions/admin-users"

/**
 * 调整成员当前积分（直接设为新余额）
 *
 * 与「分配积分」（企业池 → 个人）互补：此处不经过企业池，
 * 由后端按差额记账（credit_transaction type=adjustment）。
 */
export function CreditsAdjustDialog({
  targetUserId,
  targetUsername,
  targetName,
  currentBalance,
}: {
  targetUserId: string
  targetUsername: string
  targetName: string | null
  currentBalance: number
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [value, setValue] = React.useState("")
  const [remark, setRemark] = React.useState("")
  const router = useRouter()

  React.useEffect(() => {
    if (open) {
      setValue(String(currentBalance))
      setRemark("")
    }
  }, [open, currentBalance])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const n = Math.floor(Number(value))
    if (!Number.isFinite(n) || n < 0) {
      toast.error("新余额必须是不小于 0 的整数")
      return
    }
    if (n === currentBalance) {
      toast.info("新余额与当前一致，无需调整")
      return
    }
    startTransition(async () => {
      const res = await adjustUserCreditsAction({
        targetUserId,
        newBalance: n,
        remark: remark || undefined,
      })
      if (res.ok) {
        const sign = res.delta > 0 ? "+" : ""
        toast.success(
          `已调整 ${targetName ?? targetUsername} 积分：${currentBalance.toLocaleString("zh-CN")} → ${n.toLocaleString("zh-CN")}（${sign}${res.delta.toLocaleString("zh-CN")}）`,
        )
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "调整失败")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Scale className="size-3.5" />
            调整积分
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>调整积分</DialogTitle>
          <DialogDescription>
            直接设置「{targetName ?? targetUsername}
            」的个人配额新余额（不经企业池，按差额记入流水）
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
            当前余额
            <div className="text-sm font-semibold tabular-nums text-foreground">
              {currentBalance.toLocaleString("zh-CN")}
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adjust-balance">新余额</Label>
            <Input
              id="adjust-balance"
              type="number"
              min={0}
              max={100_000_000}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="adjust-remark">备注（可选）</Label>
            <Textarea
              id="adjust-remark"
              rows={2}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="如：纠错补回 / 清零回收"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "调整中..." : "确认调整"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
