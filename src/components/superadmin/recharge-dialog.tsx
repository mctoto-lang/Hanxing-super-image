"use client"

import * as React from "react"
import { useActionState } from "react"
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
import { rechargeCreditsAction } from "@/server/actions/platform"

export function RechargeDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await rechargeCreditsAction({
        enterpriseId,
        amount: Number(formData.get("amount") ?? 0),
        remark: String(formData.get("remark") ?? "") || undefined,
      })
      if (res.ok) {
        toast.success(
          `充值成功，当前余额 ${res.balanceAfter?.toLocaleString("zh-CN")}`,
        )
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "充值失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm"><Coins className="size-4" />充值</Button>} />
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>充值积分</DialogTitle>
          <DialogDescription>为「{enterpriseName}」充值积分</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="amount">充值数量</Label>
            <Input
              id="amount"
              name="amount"
              type="number"
              min={1}
              required
              placeholder="如：10000"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="remark">备注（可选）</Label>
            <Textarea
              id="remark"
              name="remark"
              rows={2}
              placeholder="如：季度充值"
            />
          </div>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "充值中..." : "确认充值"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
