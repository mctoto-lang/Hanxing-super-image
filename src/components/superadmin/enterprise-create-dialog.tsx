"use client"

import * as React from "react"
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
import type { z } from "zod"
import { enterpriseCreateFormSchema } from "@/lib/forms/schemas"
import { createEnterpriseAction } from "@/server/actions/platform"
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"
import type { ModuleName } from "@/db/schema"

type EnterpriseCreateValues = z.infer<typeof enterpriseCreateFormSchema>

const FORM_DEFAULTS: EnterpriseCreateValues = {
  name: "",
  slug: "",
  initialCredits: 0,
  maxConcurrent: 5,
  chatMaxConcurrent: 5,
  ownerUsername: undefined,
  ownerPassword: undefined,
  ownerName: undefined,
}

/** 模块勾选默认值（create/assets/mockup 预勾，与改造前 defaultChecked 一致） */
const MODULE_DEFAULTS = ["create", "assets", "mockup"]

/** 数组元素增删（勾选矩阵 toggle） */
function toggleValue(current: string[], m: string, on: boolean): string[] {
  return on
    ? current.includes(m)
      ? current
      : [...current, m]
    : current.filter((x) => x !== m)
}

export function EnterpriseCreateDialog() {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()
  /**
   * 模块勾选矩阵（含 TEMU 总开关）：保持独立受控 state、不进 RHF，提交时合并。
   * TEMU 总开关 = 数组含 "temu"；未勾时 7 个 tab 子项禁用且不提交（子项选择保留）。
   */
  const [modules, setModules] = React.useState<string[]>(MODULE_DEFAULTS)
  const temuOn = modules.includes("temu")

  const form = useForm<EnterpriseCreateValues>({
    resolver: standardSchemaResolver(enterpriseCreateFormSchema),
    defaultValues: FORM_DEFAULTS,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(FORM_DEFAULTS)
      setModules(MODULE_DEFAULTS)
      setServerError(null)
    }
  }, [open, form])

  async function onSubmit(values: EnterpriseCreateValues) {
    setServerError(null)
    // 模块矩阵合并：基础勾选项 + TEMU 总开关开启时才带 temu 及其 tab 子项；settings 恒带
    const base = BASE_MODULE_OPTIONS.filter((o) => modules.includes(o.value)).map(
      (o) => o.value,
    )
    const tabs = TEMU_TAB_OPTIONS.filter((o) => modules.includes(o.value)).map(
      (o) => o.value,
    )
    const enabledModules: ModuleName[] = [
      ...base,
      ...(temuOn ? (["temu", ...tabs] as ModuleName[]) : []),
      "settings",
    ]
    const ownerUsername = values.ownerUsername?.trim()
    const res = await createEnterpriseAction({
      name: values.name,
      slug: values.slug,
      enabledModules,
      maxConcurrent: values.maxConcurrent,
      chatMaxConcurrent: values.chatMaxConcurrent,
      initialCredits: values.initialCredits,
      owner: ownerUsername
        ? {
            username: ownerUsername,
            password: values.ownerPassword ?? "",
            name: values.ownerName?.trim() || undefined,
          }
        : undefined,
    })
    if (res.ok) {
      toast.success("企业创建成功")
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误：统一条内联展示，不再 toast
    setServerError(res.error ?? "创建失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" />创建企业</Button>} />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>创建企业</DialogTitle>
          <DialogDescription>
            创建企业并预置默认权限组。可选同时创建首位企业管理员（owner）。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>企业名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如：星河设计" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug（URL标识）</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="如：xinghe-design"
                        title="只能含小写字母、数字、短横线"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="initialCredits"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>初始积分</FormLabel>
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
              <FormField
                control={form.control}
                name="maxConcurrent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>生图并发上限</FormLabel>
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
                name="chatMaxConcurrent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>对话并发上限</FormLabel>
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
            </div>
            <div className="grid gap-2">
              <Label>开通模块</Label>
              <div className="grid grid-cols-2 gap-2">
                {BASE_MODULE_OPTIONS.map((o) => (
                  <label
                    key={o.value}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={modules.includes(o.value)}
                      onCheckedChange={(v) =>
                        setModules((prev) => toggleValue(prev, o.value, v === true))
                      }
                    />
                    {o.label}
                  </label>
                ))}
                <label className="col-span-2 flex items-center gap-2 border-t pt-2 text-sm font-medium">
                  <Checkbox
                    checked={temuOn}
                    onCheckedChange={(v) =>
                      setModules((prev) => toggleValue(prev, "temu", v === true))
                    }
                  />
                  {MODULE_LABELS.temu}
                  <span className="text-xs font-normal text-muted-foreground">（总开关，勾选后可配置各页面权限）</span>
                </label>
                <div className="col-span-2 ml-6 grid grid-cols-2 gap-2 border-l pl-3">
                  {TEMU_TAB_OPTIONS.map((o) => (
                    <label key={o.value} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={modules.includes(o.value)}
                        disabled={!temuOn}
                        onCheckedChange={(v) =>
                          setModules((prev) => toggleValue(prev, o.value, v === true))
                        }
                      />
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
                <FormField
                  control={form.control}
                  name="ownerUsername"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="sr-only">用户名</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(e.target.value === "" ? undefined : e.target.value)
                          }
                          placeholder="用户名"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ownerPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="sr-only">密码</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(e.target.value === "" ? undefined : e.target.value)
                          }
                          placeholder="密码"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ownerName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="sr-only">昵称（可选）</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(e.target.value === "" ? undefined : e.target.value)
                          }
                          placeholder="昵称（可选）"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
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
        </Form>
      </DialogContent>
    </Dialog>
  )
}
