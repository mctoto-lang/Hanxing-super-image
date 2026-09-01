"use client"

import * as React from "react"
import { useActionState } from "react"
import { Settings2 } from "lucide-react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { updateModulesAction } from "@/server/actions/platform"
import type { ModuleName } from "@/db/schema"

const MODULE_OPTIONS: { value: ModuleName; label: string }[] = [
  { value: "create", label: "创作" },
  { value: "chat", label: "AI 对话" },
  { value: "assets", label: "资产管理" },
  { value: "workspace", label: "批量生图" },
  { value: "product", label: "商品图片" },
  { value: "weartry", label: "穿戴图片" },
  { value: "mockup", label: "样机渲染" },
  { value: "settings", label: "个人设置" },
]

export function ModulesDialog({
  enterpriseId,
  enterpriseName,
  currentModules,
}: {
  enterpriseId: string
  enterpriseName: string
  currentModules: ModuleName[]
}) {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const modules = MODULE_OPTIONS.filter(
        (o) => formData.get(`mod_${o.value}`) === "on",
      ).map((o) => o.value)
      const res = await updateModulesAction({ enterpriseId, modules })
      if (res.ok) {
        toast.success("模块配置已更新")
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
      <DialogTrigger render={<Button variant="outline" size="sm"><Settings2 className="size-4" />模块</Button>} />
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>配置模块开关</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」可见的模块（D22）
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <div className="space-y-2">
            {MODULE_OPTIONS.map((o) => (
              <label
                key={o.value}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  name={`mod_${o.value}`}
                  defaultChecked={currentModules.includes(o.value)}
                  disabled={o.value === "settings"}
                />
                {o.label}
                {o.value === "settings" ? (
                  <span className="text-xs text-muted-foreground">（始终开启）</span>
                ) : null}
              </label>
            ))}
          </div>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
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
