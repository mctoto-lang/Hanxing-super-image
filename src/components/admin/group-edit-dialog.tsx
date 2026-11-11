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
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
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
import { permissionGroupFormSchema } from "@/lib/forms/schemas"
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
 *
 * 表单口径：4 个文本/数字字段（name/description/maxConcurrent/priority）走
 * useForm + standardSchemaResolver（permissionGroupFormSchema），open 时以组
 * 当前配置 form.reset 回填；页面 Checkbox 矩阵与 GroupModelPicker 为受控
 * state（不进 RHF），提交时从 state 取。
 */
interface GroupEditFormValues {
  name: string
  description?: string
  maxConcurrent: number
  priority: number
}

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
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<GroupEditFormValues>({
    resolver: standardSchemaResolver(permissionGroupFormSchema),
    defaultValues: {
      name: group.name,
      description: group.description ?? "",
      maxConcurrent: group.maxConcurrent,
      priority: group.priority,
    },
  })
  const pending = form.formState.isSubmitting

  // 页面勾选 / 模型勾选为受控 state；open 时以组当前配置统一回填复位
  const [pages, setPages] = React.useState<ReadonlySet<string>>(
    () => new Set(group.allowedPages),
  )
  const [imageSelected, setImageSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(group.allowedModels),
  )
  const [chatSelected, setChatSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(group.allowedChatModels),
  )

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: group.name,
        description: group.description ?? "",
        maxConcurrent: group.maxConcurrent,
        priority: group.priority,
      })
      setPages(new Set(group.allowedPages))
      setImageSelected(new Set(group.allowedModels))
      setChatSelected(new Set(group.allowedChatModels))
      setServerError(null)
    }
  }, [open, form, group])

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

  async function onSubmit(values: GroupEditFormValues) {
    setServerError(null)
    const res = await updateGroupAction(group.id, {
      name: values.name,
      description: values.description || undefined,
      allowedPages: [...pages] as never,
      allowedModels: [...imageSelected],
      allowedChatModels: [...chatSelected],
      maxConcurrent: values.maxConcurrent,
      priority: values.priority,
    })
    if (res.ok) {
      toast.success("权限组已更新")
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "更新失败")
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
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              编辑权限组{group.isDefault ? "（默认组）" : ""}
            </DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>组名</FormLabel>
                    <FormControl>
                      <Input {...field} disabled={group.isDefault} />
                    </FormControl>
                    {group.isDefault ? (
                      <p className="text-xs text-muted-foreground">默认权限组不可改名</p>
                    ) : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>描述（可选）</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="maxConcurrent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>并发上限</FormLabel>
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
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>优先级</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
              </div>
              <div className="grid gap-2">
                <FormLabel>允许页面（不勾选默认放行企业全部已开通模块）</FormLabel>
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
              {serverError ? (
                <p className="text-sm text-destructive">{serverError}</p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "保存中…" : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
