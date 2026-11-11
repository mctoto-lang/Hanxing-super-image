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
import { adjustCreditsFormSchema } from "@/lib/forms/schemas"
import { adjustUserCreditsAction } from "@/server/actions/admin-users"

/**
 * 调整成员当前积分（直接设为新余额）
 *
 * 与「分配积分」（企业池 → 个人）互补：此处不经过企业池，
 * 由后端按差额记账（credit_transaction type=adjustment）。
 *
 * 表单口径：useForm + standardSchemaResolver（adjustCreditsFormSchema），
 * 打开时以当前余额回填；服务端兜底错误显示在 footer 上方。
 */
interface AdjustCreditsFormValues {
  newBalance: number
  remark?: string
}

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
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<AdjustCreditsFormValues>({
    resolver: standardSchemaResolver(adjustCreditsFormSchema),
    defaultValues: { newBalance: currentBalance, remark: "" },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ newBalance: currentBalance, remark: "" })
      setServerError(null)
    }
  }, [open, form, currentBalance])

  async function onSubmit(values: AdjustCreditsFormValues) {
    setServerError(null)
    if (values.newBalance === currentBalance) {
      toast.info("新余额与当前一致，无需调整")
      return
    }
    const res = await adjustUserCreditsAction({
      targetUserId,
      newBalance: values.newBalance,
      remark: values.remark || undefined,
    })
    if (res.ok) {
      const sign = res.delta > 0 ? "+" : ""
      toast.success(
        `已调整 ${targetName ?? targetUsername} 积分：${currentBalance.toLocaleString("zh-CN")} → ${values.newBalance.toLocaleString("zh-CN")}（${sign}${res.delta.toLocaleString("zh-CN")}）`,
      )
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "调整失败")
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
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>调整积分</DialogTitle>
          <DialogDescription>
            直接设置「{targetName ?? targetUsername}
            」的个人配额新余额（不经企业池，按差额记入流水）
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
              当前余额
              <div className="text-sm font-semibold tabular-nums text-foreground">
                {currentBalance.toLocaleString("zh-CN")}
              </div>
            </div>
            <FormField
              control={form.control}
              name="newBalance"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>新余额</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={100_000_000}
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
                      placeholder="如：纠错补回 / 清零回收"
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
                {pending ? "调整中…" : "确认调整"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
