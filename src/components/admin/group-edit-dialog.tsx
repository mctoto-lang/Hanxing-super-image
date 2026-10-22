"use client"

import * as React from "react"
import { Pencil } from "lucide-react"
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
import { updateGroupAction } from "@/server/actions/admin-groups"
import {
  GroupModelPicker,
  type GroupModelOption,
} from "@/components/admin/group-model-picker"
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"

export interface EditableGroup {
  id: string
  name: string
  description: string | null
  allowedModels: string[]
  allowedChatModels: string[]
  allowedPages: string[]
  maxConcurrent: number
  priority: number
  isDefault: boolean
}

/**
 * 编辑权限组：模型白名单 / 页面白名单 / 并发 / 优先级。
 * 默认组不可改名（后端约束），其余可编辑。
 */
export function GroupEditDialog({
  group,
  imageModels,
  chatModels,
}: {
  group: EditableGroup
  imageModels: GroupModelOption[]
  chatModels: GroupModelOption[]
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const router = useRouter()

  // DialogContent 仅在 open 时挂载，保证每次打开以组当前配置初始化
  const [pages, setPages] = React.useState<ReadonlySet<string>>(
    () => new Set(group.allowedPages),
  )
  const [imageSelected, setImageSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(group.allowedModels),
  )
  const [chatSelected, setChatSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(group.allowedChatModels),
  )

  const togglePage = (value: string, checked: boolean) => {
    const next = new Set(pages)
    if (checked) next.add(value)
    else {
      next.delete(value)
      // 关闭 TEMU 总开关时连带清掉 tab 子项（子项单独存在无意义）
      if (value === "temu") {
        for (const o of TEMU_TAB_OPTIONS) next.delete(o.value)
      }
    }
    setPages(next)
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    try {
      const res = await updateGroupAction(group.id, {
        name: String(form.get("name") ?? group.name),
        description: String(form.get("description") ?? "") || undefined,
        allowedPages: [...pages] as never,
        allowedModels: [...imageSelected],
        allowedChatModels: [...chatSelected],
        maxConcurrent: Number(form.get("maxConcurrent") ?? group.maxConcurrent),
        priority: Number(form.get("priority") ?? group.priority),
      })
      if (res.ok) {
        toast.success("权限组已更新")
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "更新失败")
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <Pencil className="size-3.5" />
            编辑
          </Button>
        }
      />
      {open ? (
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              编辑权限组{group.isDefault ? "（默认组）" : ""}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor={`name-${group.id}`}>组名</Label>
              <Input
                id={`name-${group.id}`}
                name="name"
                required
                defaultValue={group.name}
                disabled={group.isDefault}
              />
              {group.isDefault ? (
                <p className="text-xs text-muted-foreground">默认权限组不可改名</p>
              ) : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`description-${group.id}`}>描述（可选）</Label>
              <Textarea
                id={`description-${group.id}`}
                name="description"
                rows={2}
                defaultValue={group.description ?? ""}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor={`maxConcurrent-${group.id}`}>并发上限</Label>
                <Input
                  id={`maxConcurrent-${group.id}`}
                  name="maxConcurrent"
                  type="number"
                  min={1}
                  max={9999}
                  defaultValue={group.maxConcurrent}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`priority-${group.id}`}>优先级</Label>
                <Input
                  id={`priority-${group.id}`}
                  name="priority"
                  type="number"
                  min={0}
                  defaultValue={group.priority}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>允许页面（不勾选默认放行企业全部已开通模块）</Label>
              <div className="grid grid-cols-4 gap-2">
                {BASE_MODULE_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={pages.has(o.value)}
                      onCheckedChange={(checked) =>
                        togglePage(o.value, checked)
                      }
                    />
                    {o.label}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={pages.has("temu")}
                    onCheckedChange={(checked) => togglePage("temu", checked)}
                  />
                  {MODULE_LABELS.temu}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={pages.has("settings")}
                    onCheckedChange={(checked) => togglePage("settings", checked)}
                  />
                  {MODULE_LABELS.settings}
                </label>
              </div>
              <div className="ml-4 grid grid-cols-4 gap-2 border-l pl-3">
                {TEMU_TAB_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={pages.has(o.value)}
                      disabled={!pages.has("temu")}
                      onCheckedChange={(checked) =>
                        togglePage(o.value, checked)
                      }
                    />
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
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
