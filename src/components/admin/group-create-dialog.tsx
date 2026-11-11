"use client"

import * as React from "react"
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
import { createGroupAction } from "@/server/actions/admin-groups"
import {
  GroupModelPicker,
  type GroupModelOption,
} from "@/components/admin/group-model-picker"
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"

/**
 * 新建权限组。
 *
 * 表单口径：4 个文本/数字字段（name/description/maxConcurrent/priority）走
 * useForm + standardSchemaResolver（permissionGroupFormSchema）；页面 Checkbox
 * 矩阵与 GroupModelPicker 为受控 state（不进 RHF），提交时从 state 取。
 */
interface GroupCreateFormValues {
  name: string
  description?: string
  maxConcurrent: number
  priority: number
}

export function GroupCreateDialog({
  imageModels,
  chatModels,
}: {
  imageModels: GroupModelOption[]
  chatModels: GroupModelOption[]
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  /** 允许页面勾选集（TEMU 总开关 = 集合含 "temu"；未勾选默认放行企业全部已开通模块） */
  const [pages, setPages] = React.useState<Set<string>>(new Set())
  const [imageSelected, setImageSelected] = React.useState<Set<string>>(new Set())
  const [chatSelected, setChatSelected] = React.useState<Set<string>>(new Set())
  const router = useRouter()

  const form = useForm<GroupCreateFormValues>({
    resolver: standardSchemaResolver(permissionGroupFormSchema),
    defaultValues: { name: "", description: "", maxConcurrent: 2, priority: 0 },
  })
  const pending = form.formState.isSubmitting

  // DialogContent 仅 open 时挂载，非受控项自动复位；受控状态与表单需手动复位
  React.useEffect(() => {
    if (open) {
      form.reset({ name: "", description: "", maxConcurrent: 2, priority: 0 })
      setPages(new Set())
      setImageSelected(new Set())
      setChatSelected(new Set())
      setServerError(null)
    }
  }, [open, form])

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

  async function onSubmit(values: GroupCreateFormValues) {
    setServerError(null)
    const allowedPages = [
      ...BASE_MODULE_OPTIONS.filter((o) => pages.has(o.value)).map((o) => o.value),
      ...(pages.has("temu")
        ? [
            "temu",
            ...TEMU_TAB_OPTIONS.filter((o) => pages.has(o.value)).map((o) => o.value),
          ]
        : []),
      ...(pages.has("settings") ? ["settings"] : []),
    ] as never
    const res = await createGroupAction({
      name: values.name,
      description: values.description || undefined,
      allowedPages,
      allowedModels: [...imageSelected],
      allowedChatModels: [...chatSelected],
      maxConcurrent: values.maxConcurrent,
      priority: values.priority,
    })
    if (res.ok) {
      toast.success("权限组创建成功")
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "创建失败")
  }

  const temuOn = pages.has("temu")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" />新建权限组</Button>} />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>新建权限组</DialogTitle>
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
                    <Input placeholder="如：设计组" {...field} />
                  </FormControl>
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
                  <label
                    key={o.value}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={pages.has(o.value)}
                      onCheckedChange={(checked) =>
                        togglePage(o.value, checked === true)
                      }
                    />
                    {o.label}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={temuOn}
                    onCheckedChange={(checked) => togglePage("temu", checked === true)}
                  />
                  {MODULE_LABELS.temu}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={pages.has("settings")}
                    onCheckedChange={(checked) =>
                      togglePage("settings", checked === true)
                    }
                  />
                  {MODULE_LABELS.settings}
                </label>
              </div>
              <div className="ml-4 grid grid-cols-4 gap-2 border-l pl-3">
                {TEMU_TAB_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={pages.has(o.value)}
                      disabled={!temuOn}
                      onCheckedChange={(checked) =>
                        togglePage(o.value, checked === true)
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
                {pending ? "创建中…" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
