"use client"

import * as React from "react"
import { Coins } from "lucide-react"
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
import { allocateCreditsToUserAction } from "@/server/actions/admin-users"

/**
 * 企业管理员分配积分给成员（需求 3：企业池 → 成员个人配额）
 *
 * 从企业共享积分池扣减 amount，累加到成员个人配额。
 * 企业池余额不足时由后端事务拒绝。
 */
export function AllocateCreditsDialog({
  targetUserId,
  targetUsername,
  targetName,
  currentBalance,
  enterpriseBalance,
}: {
  targetUserId: string
  targetUsername: string
  targetName: string | null
  currentBalance: number
  enterpriseBalance: number
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [amount, setAmount] = React.useState("")
  const [remark, setRemark] = React.useState("")
  const router = useRouter()

  React.useEffect(() => {
    if (open) {
      setAmount("")
      setRemark("")
    }
  }, [open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const n = Math.floor(Number(amount))
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("分配数量必须为正整数")
      return
    }
    startTransition(async () => {
      const res = await allocateCreditsToUserAction({
        targetUserId,
        amount: n,
        remark: remark || undefined,
      })
      if (res.ok) {
        toast.success(`已分配 ${n} 积分给 ${targetName ?? targetUsername}`)
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "分配失败")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Coins className="size-4" />
            分配积分
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>分配积分</DialogTitle>
          <DialogDescription>
            从企业积分池下发到「{targetName ?? targetUsername}
           」的个人配额（生图扣个人配额）
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div className="rounded-md border bg-muted/30 p-2">
              成员当前配额
              <div className="text-sm font-semibold tabular-nums text-foreground">
                {currentBalance.toLocaleString("zh-CN")}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-2">
              企业池余额
              <div className="text-sm font-semibold tabular-nums text-foreground">
                {enterpriseBalance.toLocaleString("zh-CN")}
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="alloc-amount">分配数量</Label>
            <Input
              id="alloc-amount"
              type="number"
              min={1}
              max={1_000_000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="alloc-remark">备注（可选）</Label>
            <Textarea
              id="alloc-remark"
              rows={2}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="如：本月设计组配额"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "分配中..." : "确认分配"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
