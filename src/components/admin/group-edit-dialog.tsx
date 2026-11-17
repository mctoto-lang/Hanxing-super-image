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
import { MODULE_LABELS, type ModuleOption } from "@/lib/modules"
import { Badge } from "@/components/ui/badge"
import type { ModuleName } from "@/db/schema"

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
 * state（不进 RHF），提交时从 state 取。回填不滤掉已不在企业开通范围的
 * 残留 id——渲染为「已失效」徽章行（StalePickRow）供手动移除，保留勾选时
 * 由服务端保存链路的白名单裁剪兜底。
 */
interface GroupEditFormValues {
  name: string
  description?: string
  maxConcurrent: number
  priority: number
}

/**
 * 「已失效」勾选徽章行：组配置里残留的、已不在企业开通范围的模块/模型 id
 * （历史数据或平台侧收紧后遗留）。回填不再静默滤掉这些 id，显式标注出来并
 * 支持点击移除；用户保留勾选时由服务端保存链路的白名单裁剪兜底。
 */
function StalePickRow({
  items,
  onRemove,
}: {
  items: { id: string; label: string }[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">
        已失效（不在企业开通范围，点击移除）：
      </span>
      {items.map((it) => (
        <Badge
          key={it.id}
          variant="outline"
          title={it.id}
          className="max-w-48 cursor-pointer truncate font-mono text-[10px] text-muted-foreground hover:text-foreground"
          render={
            <button type="button" onClick={() => onRemove(it.id)} />
          }
        >
          {it.label}
        </Badge>
      ))}
    </div>
  )
}

export function GroupEditDialog({
  group,
  imageModels,
  chatModels,
  baseOptions,
  temuOptions,
  temuEnabled,
}: {
  group: EditableGroup
  imageModels: GroupModelOption[]
  chatModels: GroupModelOption[]
  /** 模块勾选项（企业已开通范围内，由页面按 enabledModules 预过滤） */
  baseOptions: ModuleOption[]
  temuOptions: ModuleOption[]
  temuEnabled: boolean
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

  // 残留勾选 = 已不在企业开通范围（勾选矩阵渲染不出来）的模块/模型 id：
  // 不静默隐藏，渲染为「已失效」徽章行并可手动移除（服务端裁剪仍兜底）
  const validPageKeys = new Set<string>([
    ...baseOptions.map((o) => o.value),
    ...(temuEnabled ? ["temu", ...temuOptions.map((o) => o.value)] : []),
    "settings",
  ])
  const stalePages = [...pages].filter((p) => !validPageKeys.has(p))
  const staleImageIds = [...imageSelected].filter(
    (id) => !imageModels.some((m) => m.id === id),
  )
  const staleChatIds = [...chatSelected].filter(
    (id) => !chatModels.some((m) => m.id === id),
  )
  const removeStale = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  ) => (id: string) =>
    setter((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })

  const togglePage = (value: string, checked: boolean) => {
    const next = new Set(pages)
    if (checked) next.add(value)
    else {
      next.delete(value)
      // 关闭 TEMU 总开关时连带清掉 tab 子项（子项单独存在无意义）
      if (value === "temu") {
        for (const o of temuOptions) next.delete(o.value)
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
                  {baseOptions.map((o) => (
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
                  {temuEnabled ? (
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <Checkbox
                        checked={pages.has("temu")}
                        onCheckedChange={(checked) => togglePage("temu", checked)}
                      />
                      {MODULE_LABELS.temu}
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={pages.has("settings")}
                      onCheckedChange={(checked) => togglePage("settings", checked)}
                    />
                    {MODULE_LABELS.settings}
                  </label>
                </div>
                {temuEnabled && temuOptions.length > 0 ? (
                  <div className="ml-4 grid grid-cols-4 gap-2 border-l pl-3">
                    {temuOptions.map((o) => (
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
                ) : null}
                <p className="text-xs text-muted-foreground">
                  TEMU 子页面按勾选放行（须企业已开通 TEMU 且对应页面已授权）；店铺页面不设权限项，仅企业管理员可见
                </p>
                <StalePickRow
                  items={stalePages.map((p) => ({
                    id: p,
                    label: MODULE_LABELS[p as ModuleName] ?? p,
                  }))}
                  onRemove={removeStale(setPages)}
                />
              </div>
              <GroupModelPicker
                label="可用生图模型"
                options={imageModels}
                selected={imageSelected}
                onChange={setImageSelected}
              />
              <StalePickRow
                items={staleImageIds.map((id) => ({ id, label: id }))}
                onRemove={removeStale(setImageSelected)}
              />
              <GroupModelPicker
                label="可用对话模型"
                options={chatModels}
                selected={chatSelected}
                onChange={setChatSelected}
              />
              <StalePickRow
                items={staleChatIds.map((id) => ({ id, label: id }))}
                onRemove={removeStale(setChatSelected)}
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
