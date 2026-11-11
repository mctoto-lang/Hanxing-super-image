"use client"

import * as React from "react"
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
import { useForm, useWatch } from "react-hook-form"
import { updateModulesAction } from "@/server/actions/platform"
import { BASE_MODULE_OPTIONS, MODULE_LABELS, TEMU_TAB_OPTIONS } from "@/lib/modules"
import type { ModuleName } from "@/db/schema"

/** 模块勾选矩阵（无 zod schema：宽松 string[]，严格枚举由服务端兜底） */
type ModulesFormValues = {
  modules: string[]
}

/** settings 恒选：默认值兜底带上 */
function withSettings(modules: ModuleName[]): string[] {
  return modules.includes("settings") ? [...modules] : [...modules, "settings"]
}

/** 数组元素增删（勾选 toggle） */
function toggleValue(current: string[], m: string, on: boolean): string[] {
  return on
    ? current.includes(m)
      ? current
      : [...current, m]
    : current.filter((x) => x !== m)
}

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
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<ModulesFormValues>({
    defaultValues: { modules: withSettings(currentModules) },
  })
  const pending = form.formState.isSubmitting
  /** TEMU 总开关（未勾时 7 个 tab 子项禁用且不提交）；useWatch 供 React Compiler 记忆化 */
  const selected = useWatch({ control: form.control, name: "modules" })
  const temuOn = selected.includes("temu")

  React.useEffect(() => {
    if (open) {
      form.reset({ modules: withSettings(currentModules) })
      setServerError(null)
    }
  }, [open, form, currentModules])

  async function onSubmit(values: ModulesFormValues) {
    setServerError(null)
    // 提交口径与改造前一致：基础勾选项 + 总开关开启才带 temu 及其 tab 子项；settings 恒带
    const base = BASE_MODULE_OPTIONS.filter((o) => values.modules.includes(o.value)).map(
      (o) => o.value,
    )
    const includeTemu = values.modules.includes("temu")
    const tabs = TEMU_TAB_OPTIONS.filter((o) => values.modules.includes(o.value)).map(
      (o) => o.value,
    )
    const modules: ModuleName[] = [
      ...base,
      ...(includeTemu ? (["temu", ...tabs] as ModuleName[]) : []),
      "settings",
    ]
    const res = await updateModulesAction({ enterpriseId, modules })
    if (res.ok) {
      toast.success("模块配置已更新")
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误：统一条内联展示，不再 toast
    setServerError(res.error ?? "更新失败")
  }

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
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <div className="space-y-2">
              {BASE_MODULE_OPTIONS.map((o) => (
                <FormField
                  key={o.value}
                  control={form.control}
                  name="modules"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 text-sm">
                      <FormControl>
                        <Checkbox
                          checked={field.value.includes(o.value)}
                          onCheckedChange={(checked) =>
                            field.onChange(toggleValue(field.value, o.value, checked === true))
                          }
                        />
                      </FormControl>
                      <FormLabel className="font-normal">{o.label}</FormLabel>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}

              <FormField
                control={form.control}
                name="modules"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 border-t pt-2 text-sm font-medium">
                    <FormControl>
                      <Checkbox
                        checked={field.value.includes("temu")}
                        onCheckedChange={(checked) =>
                          field.onChange(toggleValue(field.value, "temu", checked === true))
                        }
                      />
                    </FormControl>
                    <FormLabel>{MODULE_LABELS.temu}</FormLabel>
                    <span className="text-xs font-normal text-muted-foreground">（总开关，勾选后可配置各页面权限）</span>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="ml-6 space-y-2 border-l pl-3">
                {TEMU_TAB_OPTIONS.map((o) => (
                  <FormField
                    key={o.value}
                    control={form.control}
                    name="modules"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2 text-sm">
                        <FormControl>
                          <Checkbox
                            checked={field.value.includes(o.value)}
                            disabled={!temuOn}
                            onCheckedChange={(checked) =>
                              field.onChange(toggleValue(field.value, o.value, checked === true))
                            }
                          />
                        </FormControl>
                        <FormLabel className="font-normal">{o.label}</FormLabel>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
                <p className="text-xs text-muted-foreground">店铺页面不设权限项，仅企业管理员可见</p>
              </div>

              <FormField
                control={form.control}
                name="modules"
                render={() => (
                  <FormItem className="flex items-center gap-2 border-t pt-2 text-sm">
                    <FormControl>
                      {/* settings 始终开启：恒选 + disabled（提交口径里也恒带） */}
                      <Checkbox checked disabled />
                    </FormControl>
                    <FormLabel className="font-normal">{MODULE_LABELS.settings}</FormLabel>
                    <span className="text-xs text-muted-foreground">（始终开启）</span>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "更新中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
