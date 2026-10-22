"use client"

import * as React from "react"
import { useActionState } from "react"
import { Plus } from "lucide-react"
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
import { Checkbox } from "@/components/ui/checkbox"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { createEnterpriseAction } from "@/server/actions/platform"
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"

export function EnterpriseCreateDialog() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  /** TEMU 总开关（未勾时 7 个 tab 子项禁用且不提交） */
  const [temuOn, setTemuOn] = React.useState(false)
  /** DialogContent 仅 open 时挂载，非受控项自动复位；受控 temuOn 需手动复位（对齐 modules-dialog） */
  React.useEffect(() => {
    if (open) setTemuOn(false)
  }, [open])

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const modules = [
        ...BASE_MODULE_OPTIONS.filter((o) => formData.get(`mod_${o.value}`) === "on").map((o) => o.value),
        ...(formData.get("mod_temu") === "on"
          ? [
              "temu",
              ...TEMU_TAB_OPTIONS.filter((o) => formData.get(`mod_${o.value}`) === "on").map((o) => o.value),
            ]
          : []),
      ] as string[]
      // settings 默认带
      modules.push("settings")

      const res = await createEnterpriseAction({
        name: String(formData.get("name") ?? ""),
        slug: String(formData.get("slug") ?? ""),
        enabledModules: modules as never,
        maxConcurrent: Number(formData.get("maxConcurrent") ?? 5),
        chatMaxConcurrent: Number(formData.get("chatMaxConcurrent") ?? 5),
        initialCredits: Number(formData.get("initialCredits") ?? 0),
        owner: formData.get("owner_username")
          ? {
              username: String(formData.get("owner_username") ?? ""),
              password: String(formData.get("owner_password") ?? ""),
              name: String(formData.get("owner_name") ?? "") || undefined,
            }
          : undefined,
      })
      if (res.ok) {
        toast.success("企业创建成功")
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
      <DialogTrigger render={<Button><Plus className="size-4" />创建企业</Button>} />
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>创建企业</DialogTitle>
          <DialogDescription>
            创建企业并预置默认权限组。可选同时创建首位企业管理员（owner）。
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="name">企业名称</Label>
              <Input id="name" name="name" required placeholder="如：星河设计" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">Slug（URL标识）</Label>
              <Input
                id="slug"
                name="slug"
                required
                placeholder="如：xinghe-design"
                pattern="[a-z0-9-]+"
                title="只能含小写字母、数字、短横线"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="initialCredits">初始积分</Label>
              <Input
                id="initialCredits"
                name="initialCredits"
                type="number"
                min={0}
                defaultValue={0}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maxConcurrent">生图并发上限</Label>
              <Input
                id="maxConcurrent"
                name="maxConcurrent"
                type="number"
                min={1}
                max={9999}
                defaultValue={5}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="chatMaxConcurrent">对话并发上限</Label>
              <Input
                id="chatMaxConcurrent"
                name="chatMaxConcurrent"
                type="number"
                min={1}
                max={9999}
                defaultValue={5}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>开通模块</Label>
            <div className="grid grid-cols-2 gap-2">
              {BASE_MODULE_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox name={`mod_${o.value}`} defaultChecked={o.value === "create" || o.value === "assets" || o.value === "mockup"} />
                  {o.label}
                </label>
              ))}
              <label className="col-span-2 flex items-center gap-2 border-t pt-2 text-sm font-medium">
                <Checkbox
                  name="mod_temu"
                  checked={temuOn}
                  onCheckedChange={(v) => setTemuOn(v === true)}
                />
                {MODULE_LABELS.temu}
                <span className="text-xs font-normal text-muted-foreground">（总开关，勾选后可配置各页面权限）</span>
              </label>
              <div className="col-span-2 ml-6 grid grid-cols-2 gap-2 border-l pl-3">
                {TEMU_TAB_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <Checkbox name={`mod_${o.value}`} disabled={!temuOn} />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-2 text-sm font-medium">
              首位企业管理员（可选）
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Input name="owner_username" placeholder="用户名" />
              <Input name="owner_password" type="password" placeholder="密码" />
              <Input name="owner_name" placeholder="昵称（可选）" />
            </div>
          </div>
          {state?.error ? (
            <p role="alert" className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
