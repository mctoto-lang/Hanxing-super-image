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
import { rechargeFormSchema } from "@/lib/forms/schemas"
import { rechargeCreditsAction } from "@/server/actions/platform"

/**
 * 企业充值弹窗（企业管理双侧表单统一设计语言的范式样例 / golden sample）。
 *
 * 统一口径：Form + useForm + standardSchemaResolver（client-safe zod 镜像）
 * → FormField/FormItem/FormLabel/FormControl/FormMessage 字段级内联校验
 * （标签变红 + 控件红边 + 字段下方红字）；成功才 toast，服务端兜底错误
 * 显示在 footer 上方统一一条。
 */
interface RechargeFormValues {
  amount: number
  remark?: string
}

export function RechargeDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<RechargeFormValues>({
    resolver: standardSchemaResolver(rechargeFormSchema),
    defaultValues: { amount: 0 as unknown as number, remark: "" },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ amount: undefined as unknown as number, remark: "" })
      setServerError(null)
    }
  }, [open, form])

  async function onSubmit(values: RechargeFormValues) {
    setServerError(null)
    const res = await rechargeCreditsAction({
      enterpriseId,
      amount: values.amount,
      remark: values.remark?.trim() || undefined,
    })
    if (res.ok) {
      toast.success(
        `充值成功，当前余额 ${res.balanceAfter?.toLocaleString("zh-CN")}`,
      )
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误（slug 冲突类业务错误）：统一条内联展示，不再 toast
    setServerError(res.error ?? "充值失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm"><Coins className="size-4" />充值</Button>} />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>充值积分</DialogTitle>
          <DialogDescription>为「{enterpriseName}」充值积分</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>充值数量</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      placeholder="如：10000"
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
                    <Textarea rows={2} placeholder="如：季度充值" {...field} />
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
                {pending ? "充值中…" : "确认充值"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
