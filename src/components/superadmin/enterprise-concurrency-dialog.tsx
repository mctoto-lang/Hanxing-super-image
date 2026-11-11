"use client"

import * as React from "react"
import { Gauge } from "lucide-react"
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
import type { z } from "zod"
import { enterpriseConcurrencyFormSchema } from "@/lib/forms/schemas"
import { updateEnterpriseConcurrencyAction } from "@/server/actions/platform"

/**
 * 企业级并发设置弹窗（企业管理行内操作）
 *
 * - 生图并发：生图任务企业级并发上限（Redis 槽位跨副本强制，图片级计数）
 * - 对话并发：AI 对话同时在途流数上限（超出返回「已达并发上限」）
 * 两项均 1-9999；与模型级「最大并发」、权限组并发叠加生效（取最小）。
 */
type ConcurrencyFormValues = z.infer<typeof enterpriseConcurrencyFormSchema>

export function EnterpriseConcurrencyDialog({
  enterpriseId,
  enterpriseName,
  maxConcurrent,
  chatMaxConcurrent,
}: {
  enterpriseId: string
  enterpriseName: string
  maxConcurrent: number
  chatMaxConcurrent: number
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<ConcurrencyFormValues>({
    resolver: standardSchemaResolver(enterpriseConcurrencyFormSchema),
    defaultValues: { maxConcurrent, chatMaxConcurrent },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ maxConcurrent, chatMaxConcurrent })
      setServerError(null)
    }
  }, [open, form, maxConcurrent, chatMaxConcurrent])

  async function onSubmit(values: ConcurrencyFormValues) {
    setServerError(null)
    const res = await updateEnterpriseConcurrencyAction({
      enterpriseId,
      maxConcurrent: values.maxConcurrent,
      chatMaxConcurrent: values.chatMaxConcurrent,
    })
    if (res.ok) {
      toast.success("并发配置已更新")
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误：统一条内联展示，不再 toast
    setServerError(res.error ?? "更新失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm"><Gauge className="size-4" />并发</Button>} />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>企业并发设置</DialogTitle>
          <DialogDescription>「{enterpriseName}」的企业级并发上限</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="maxConcurrent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>生图并发上限</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={9999}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? undefined : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      企业内生图任务的同时处理上限
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="chatMaxConcurrent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>对话并发上限</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={9999}
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? undefined : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      企业内 AI 对话的同时在途流数
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "更新中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
