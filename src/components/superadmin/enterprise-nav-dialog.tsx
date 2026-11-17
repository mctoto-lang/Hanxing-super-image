"use client"

import * as React from "react"
import { Navigation } from "lucide-react"
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
import { Switch } from "@/components/ui/switch"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"
import { updateEnterpriseNavAction } from "@/server/actions/platform"
import {
  NAV_DEFAULT_TITLES,
  NAV_TITLE_ORDER,
  TEST_NAV_TEMU_TITLE,
  resolveNavTitle,
} from "@/lib/modules"
import type { NavTitleKey } from "@/lib/modules"

/** 表单值（宽松 record：键枚举与长度由服务端 zod 兜底） */
type NavFormValues = {
  isTest: boolean
  titles: Record<string, string>
}

/**
 * 导航名称自定义映射 + 测试企业开关（超管；迁移 0100）
 *
 * - 测试开关仅改名：开启后侧边栏 TEMU 预设显示为「数据中心」；
 * - 各名称留空 = 恢复默认名（提交时空白剔除）。
 */
export function EnterpriseNavDialog({
  enterpriseId,
  enterpriseName,
  isTest,
  navTitleOverrides,
}: {
  enterpriseId: string
  enterpriseName: string
  isTest: boolean
  navTitleOverrides: Partial<Record<NavTitleKey, string>>
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<NavFormValues>({
    defaultValues: {
      isTest,
      titles: { ...navTitleOverrides },
    },
  })
  const pending = form.formState.isSubmitting
  // useWatch 供 React Compiler 记忆化（form.watch 会触发 lint incompatible-library）
  const isTestOn = useWatch({ control: form.control, name: "isTest" })
  const temuTitle = useWatch({ control: form.control, name: "titles.temu" })

  React.useEffect(() => {
    if (open) {
      form.reset({ isTest, titles: { ...navTitleOverrides } })
      setServerError(null)
    }
  }, [open, form, isTest, navTitleOverrides])

  async function onSubmit(values: NavFormValues) {
    setServerError(null)
    const res = await updateEnterpriseNavAction({
      enterpriseId,
      isTest: values.isTest,
      navTitleOverrides: values.titles,
    })
    if (res.ok) {
      toast.success("导航名称已更新")
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
          <Button variant="outline" size="sm">
            <Navigation className="size-4" />
            导航名称
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>导航名称自定义</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」侧边栏与命令面板的导航命名；留空 = 默认名
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="isTest"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-2 rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel className="text-sm">测试企业</FormLabel>
                    <FormDescription className="text-xs">
                      开启后 TEMU 显示为「{TEST_NAV_TEMU_TITLE}」（仅改名，显式映射优先）
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="space-y-2">
              {NAV_TITLE_ORDER.map((key) => {
                const defaultTitle = NAV_DEFAULT_TITLES[key]
                // 测试开关预设只作用于 temu：placeholder 随开关切换提示预设名
                const placeholder =
                  key === "temu" && isTestOn && !temuTitle
                    ? `${TEST_NAV_TEMU_TITLE}（测试开关预设）`
                    : defaultTitle
                return (
                  <FormField
                    key={key}
                    control={form.control}
                    name={`titles.${key}`}
                    render={({ field }) => (
                      <FormItem className="grid grid-cols-[88px_1fr] items-center gap-2">
                        <FormLabel className="truncate text-xs font-normal text-muted-foreground">
                          {defaultTitle}
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            placeholder={placeholder}
                            maxLength={20}
                            className="h-8 text-xs"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                )
              })}
            </div>

            <p className="text-xs text-muted-foreground">
              当前 TEMU 显示名：
              <Badge className="ml-1 rounded-[4px] bg-muted px-1.5 text-[10px] text-foreground">
                {resolveNavTitle({ temu: temuTitle ?? "" }, isTestOn, "temu")}
              </Badge>
              （「{NAV_DEFAULT_TITLES.temu}刊登模板」子项同步跟随）
            </p>

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
