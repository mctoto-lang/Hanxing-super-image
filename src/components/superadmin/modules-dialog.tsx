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
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"
import type { ModuleName } from "@/db/schema"

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
  /** TEMU 总开关（未勾时 7 个 tab 子项禁用且不提交） */
  const [temuOn, setTemuOn] = React.useState(currentModules.includes("temu"))
  React.useEffect(() => {
    if (open) setTemuOn(currentModules.includes("temu"))
  }, [open, currentModules])

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const plain = BASE_MODULE_OPTIONS.filter(
        (o) => formData.get(`mod_${o.value}`) === "on",
      ).map((o) => o.value)
      const modules: ModuleName[] = [
        ...plain,
        ...(formData.get("mod_temu") === "on" ? (["temu"] as ModuleName[]) : []),
        ...((formData.get("mod_temu") === "on"
          ? TEMU_TAB_OPTIONS.filter((o) => formData.get(`mod_${o.value}`) === "on").map((o) => o.value)
          : []) as ModuleName[]),
        "settings",
      ]
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
            {BASE_MODULE_OPTIONS.map((o) => (
              <label
                key={o.value}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  name={`mod_${o.value}`}
                  defaultChecked={currentModules.includes(o.value)}
                />
                {o.label}
              </label>
            ))}

            <label className="flex items-center gap-2 border-t pt-2 text-sm font-medium">
              <Checkbox
                name="mod_temu"
                checked={temuOn}
                onCheckedChange={(v) => setTemuOn(v === true)}
              />
              {MODULE_LABELS.temu}
              <span className="text-xs font-normal text-muted-foreground">（总开关，勾选后可配置各页面权限）</span>
            </label>
            <div className="ml-6 space-y-2 border-l pl-3">
              {TEMU_TAB_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    name={`mod_${o.value}`}
                    defaultChecked={currentModules.includes(o.value)}
                    disabled={!temuOn}
                  />
                  {o.label}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">店铺页面不设权限项，仅企业管理员可见</p>
            </div>

            <label className="flex items-center gap-2 border-t pt-2 text-sm">
              <Checkbox name="mod_settings" defaultChecked disabled />
              {MODULE_LABELS.settings}
              <span className="text-xs text-muted-foreground">（始终开启）</span>
            </label>
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
