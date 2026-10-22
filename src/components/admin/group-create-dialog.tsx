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
import {
  GroupModelPicker,
  type GroupModelOption,
} from "@/components/admin/group-model-picker"
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"

export function GroupCreateDialog({
  imageModels,
  chatModels,
}: {
  imageModels: GroupModelOption[]
  chatModels: GroupModelOption[]
}) {
  const [open, setOpen] = React.useState(false)
  const [imageSelected, setImageSelected] = React.useState<Set<string>>(new Set())
  const [chatSelected, setChatSelected] = React.useState<Set<string>>(new Set())
  /** TEMU 总开关（未勾时 tab 子项禁用且不提交；不勾默认放行企业全部已开通模块） */
  const [temuOn, setTemuOn] = React.useState(false)
  /** DialogContent 仅 open 时挂载，非受控项自动复位；外层受控状态需手动复位（对齐 modules-dialog） */
  React.useEffect(() => {
    if (open) {
      setTemuOn(false)
      setImageSelected(new Set())
      setChatSelected(new Set())
    }
  }, [open])
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const allowedPages = [
        ...BASE_MODULE_OPTIONS.filter((o) => formData.get(`page_${o.value}`) === "on").map((o) => o.value),
        ...(formData.get("page_temu") === "on"
          ? [
              "temu",
              ...TEMU_TAB_OPTIONS.filter((o) => formData.get(`page_${o.value}`) === "on").map((o) => o.value),
            ]
          : []),
        ...(formData.get("page_settings") === "on" ? ["settings"] : []),
      ] as never
      const res = await createGroupAction({
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? "") || undefined,
        allowedPages,
        allowedModels: [...imageSelected],
        allowedChatModels: [...chatSelected],
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
      <DialogContent className="sm:max-w-[560px]">
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
                max={9999}
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
            <div className="grid grid-cols-4 gap-2">
              {BASE_MODULE_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox name={`page_${o.value}`} />
                  {o.label}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  name="page_temu"
                  checked={temuOn}
                  onCheckedChange={(v) => setTemuOn(v === true)}
                />
                {MODULE_LABELS.temu}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="page_settings" />
                {MODULE_LABELS.settings}
              </label>
            </div>
            <div className="ml-4 grid grid-cols-4 gap-2 border-l pl-3">
              {TEMU_TAB_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <Checkbox name={`page_${o.value}`} disabled={!temuOn} />
                  {o.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              TEMU 子页面按勾选放行（须企业已开通 TEMU 且对应页面已授权）；店铺页面不设权限项，仅企业管理员可见
            </p>
          </div>
          <GroupModelPicker
            label="可用生图模型"
            options={imageModels}
            selected={imageSelected}
            onChange={setImageSelected}
          />
          <GroupModelPicker
            label="可用对话模型"
            options={chatModels}
            selected={chatSelected}
            onChange={setChatSelected}
          />
          {state?.error ? (
            <p role="alert" className="text-sm text-destructive">{state.error}</p>
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
