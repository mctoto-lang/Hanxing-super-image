"use client"

import * as React from "react"
import { useActionState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { createGroupAction } from "@/server/actions/admin-groups"

const PAGE_OPTIONS = [
  { value: "create", label: "创作" },
  { value: "assets", label: "资产管理" },
  { value: "workspace", label: "批量生图" },
  { value: "product", label: "商品图片" },
  { value: "mockup", label: "样机渲染" },
  { value: "settings", label: "个人设置" },
] as const

export function GroupCreateDialog() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const allowedPages = PAGE_OPTIONS.filter(
        (o) => formData.get(`page_${o.value}`) === "on",
      ).map((o) => o.value) as never
      const res = await createGroupAction({
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? "") || undefined,
        allowedPages,
        maxConcurrent: Number(formData.get("maxConcurrent") ?? 2),
        priority: Number(formData.get("priority") ?? 0),
      })
      if (res.ok) {
        toast.success("权限组创建成功")
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "创建失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" />新建权限组</Button>} />
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>新建权限组</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="name">组名</Label>
            <Input id="name" name="name" required placeholder="如：设计组" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">描述（可选）</Label>
            <Textarea id="description" name="description" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="maxConcurrent">并发上限</Label>
              <Input
                id="maxConcurrent"
                name="maxConcurrent"
                type="number"
                min={1}
                defaultValue={2}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="priority">优先级</Label>
              <Input
                id="priority"
                name="priority"
                type="number"
                min={0}
                defaultValue={0}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>允许页面（不勾选默认放行企业全部已开通模块）</Label>
            <div className="grid grid-cols-3 gap-2">
              {PAGE_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox name={`page_${o.value}`} />
                  {o.label}
                </label>
              ))}
            </div>
          </div>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
