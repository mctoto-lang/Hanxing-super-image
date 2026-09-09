"use client"

import * as React from "react"
import { useActionState } from "react"
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
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { updateEnterpriseConcurrencyAction } from "@/server/actions/platform"

/**
 * 企业级并发设置弹窗（企业管理行内操作）
 *
 * - 生图并发：生图任务企业级并发上限（Redis 槽位跨副本强制，图片级计数）
 * - 对话并发：AI 对话同时在途流数上限（超出返回「已达并发上限」）
 * 两项均 1-100；与模型级「最大并发」、权限组并发叠加生效（取最小）。
 */
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
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await updateEnterpriseConcurrencyAction({
        enterpriseId,
        maxConcurrent: Number(formData.get("maxConcurrent") ?? 5),
        chatMaxConcurrent: Number(formData.get("chatMaxConcurrent") ?? 5),
      })
      if (res.ok) {
        toast.success("并发配置已更新")
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "更新失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm"><Gauge className="size-4" />并发</Button>} />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>企业并发设置</DialogTitle>
          <DialogDescription>「{enterpriseName}」的企业级并发上限</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="conc-image">生图并发上限</Label>
              <Input
                id="conc-image"
                name="maxConcurrent"
                type="number"
                min={1}
                max={100}
                defaultValue={maxConcurrent}
              />
              <p className="text-xs text-muted-foreground">
                企业内生图任务的同时处理上限
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="conc-chat">对话并发上限</Label>
              <Input
                id="conc-chat"
                name="chatMaxConcurrent"
                type="number"
                min={1}
                max={100}
                defaultValue={chatMaxConcurrent}
              />
              <p className="text-xs text-muted-foreground">
                企业内 AI 对话的同时在途流数
              </p>
            </div>
          </div>
          {state?.error ? (
            <p role="alert" className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "更新中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
