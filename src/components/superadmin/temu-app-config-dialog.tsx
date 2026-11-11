"use client"

import * as React from "react"
import { Loader2, Store } from "lucide-react"
import { toast } from "sonner"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm } from "react-hook-form"
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { temuAppSettingFormSchema } from "@/lib/forms/config-schemas"
import {
  getTemuAppSettingAction,
  saveTemuAppSettingAction,
} from "@/server/actions/platform"

interface TemuAppSettingFormValues {
  appKey: string
  appSecret: string
  testMode: boolean
}

const blankDefaults: TemuAppSettingFormValues = {
  appKey: "",
  appSecret: "",
  testMode: false,
}

/**
 * 企业级 TEMU 官方开放平台应用配置（超管）
 *
 * 每个企业可对接各自的自研应用：app_key / app_secret（AES 加密落库，
 * 掩码回显、留空不修改）/ testMode（切官方文档测试账号，供正式应用
 * 审批下来前联调）。未配置的企业其店铺同步与 TEMU 工作台不可用。
 *
 * 远端回填：open 时 getTemuAppSettingAction 拉取 → form.reset(映射值)；
 * 加载失败时禁用整表（防假「未配置」态诱导覆盖既有凭证）。
 */
export function TemuAppConfigDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  /** 加载失败：不渲染可保存的空表单，防止假「未配置」态诱导覆盖既有凭证 */
  const [loadError, setLoadError] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [hasSecret, setHasSecret] = React.useState(false)

  const form = useForm<TemuAppSettingFormValues>({
    resolver: standardSchemaResolver(temuAppSettingFormSchema),
    defaultValues: blankDefaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (!open) return
    let stop = false
    setLoading(true)
    setLoadError(false)
    setServerError(null)
    void getTemuAppSettingAction(enterpriseId)
      .then((cfg) => {
        if (stop) return
        setHasSecret(Boolean(cfg.appSecret))
        form.reset({
          appKey: cfg.appKey,
          appSecret: cfg.appSecret,
          testMode: cfg.testMode,
        })
      })
      .catch(() => {
        if (!stop) setLoadError(true)
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
    }
  }, [open, enterpriseId, form])

  async function onSubmit(values: TemuAppSettingFormValues) {
    setServerError(null)
    try {
      const res = await saveTemuAppSettingAction({
        enterpriseId,
        appKey: values.appKey,
        appSecret: values.appSecret,
        testMode: values.testMode,
      })
      if (!res.ok) {
        setServerError(res.error ?? "保存失败")
        return
      }
      toast.success("TEMU 应用配置已保存")
      setOpen(false)
    } catch {
      // server action 抛异常（网络/DB/会话失效）时兜底，避免 void handleSubmit 吞掉 rejection 无反馈
      setServerError("保存失败，请重试")
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Store className="size-4" />
            TEMU应用
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>TEMU 应用配置</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」对接的 TEMU 官方开放平台自研应用凭证（各企业可使用不同的应用接入）
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
          </div>
        ) : loadError ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-destructive">
            配置加载失败，请关闭后重试；为避免覆盖既有凭证，已停用编辑表单。
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="appKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>app_key</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="TEMU 开放平台自研应用的 app_key"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="appSecret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>app_secret</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        {...field}
                        placeholder={
                          hasSecret
                            ? "已配置（掩码提交=不修改，清空并保存=删除）"
                            : "app_secret（仅超管可见）"
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="testMode"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm font-medium">测试模式</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        调用时改用官方文档测试账号（全托），供正式应用审批下来前联调；店铺
                        access_token 也须用测试账号的
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(Boolean(v))}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <p className="text-xs text-muted-foreground">
                未配置凭证时，该企业的店铺同步与 TEMU 工作台不可用；凭证与店铺 token
                均加密存储。
              </p>

              {serverError ? (
                <p className="text-sm text-destructive">{serverError}</p>
              ) : null}
            </form>
          </Form>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={pending || loading || loadError}
            onClick={() => void form.handleSubmit(onSubmit)()}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
