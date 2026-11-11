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
import { Textarea } from "@/components/ui/textarea"
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
import { useForm } from "react-hook-form"
import { allocateCreditsFormSchema } from "@/lib/forms/schemas"
import { allocateCreditsToUserAction } from "@/server/actions/admin-users"

/**
 * 企业管理员分配积分给成员（需求 3：企业池 → 成员个人配额）
 *
 * 从企业共享积分池扣减 amount，累加到成员个人配额。
 * 企业池余额不足时由后端事务拒绝。
 *
 * 表单口径：useForm + standardSchemaResolver（allocateCreditsFormSchema），
 * 字段级内联校验；服务端兜底错误显示在 footer 上方。
 */
interface AllocateCreditsFormValues {
  amount: number
  remark?: string
}

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
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<AllocateCreditsFormValues>({
    resolver: standardSchemaResolver(allocateCreditsFormSchema),
    defaultValues: { amount: 0 as unknown as number, remark: "" },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ amount: undefined as unknown as number, remark: "" })
      setServerError(null)
    }
  }, [open, form])

  async function onSubmit(values: AllocateCreditsFormValues) {
    setServerError(null)
    const res = await allocateCreditsToUserAction({
      targetUserId,
      amount: values.amount,
      remark: values.remark || undefined,
    })
    if (res.ok) {
      toast.success(`已分配 ${values.amount} 积分给 ${targetName ?? targetUsername}`)
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "分配失败")
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
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>分配积分</DialogTitle>
          <DialogDescription>
            从企业积分池下发到「{targetName ?? targetUsername}
           」的个人配额（生图扣个人配额）
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>分配数量</FormLabel>
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
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注（可选）</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="如：本月设计组配额"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "分配中…" : "确认分配"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
