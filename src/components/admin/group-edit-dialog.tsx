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

const PAGE_OPTIONS = [
  { value: "create", label: "自由创作" },
  { value: "chat", label: "AI 对话" },
  { value: "assets", label: "资产管理" },
  { value: "workspace", label: "批量生图" },
  { value: "product", label: "商品图片" },
  { value: "weartry", label: "穿戴图片" },
  { value: "mockup", label: "样机渲染" },
  { value: "settings", label: "个人设置" },
] as const

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
    else next.delete(value)
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
                {PAGE_OPTIONS.map((o) => (
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
              </div>
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
