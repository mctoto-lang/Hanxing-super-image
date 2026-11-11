"use client"

import * as React from "react"
import { Boxes, Loader2 } from "lucide-react"
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
import { mockupSettingFormSchema } from "@/lib/forms/config-schemas"
import {
  getMockupSettingAction,
  saveMockupSettingAction,
} from "@/server/actions/platform"

interface MockupSettingFormValues {
  apiBaseUrl: string
  apiKey?: string
  webhookSecret?: string
  costPerRender: number
  enabled: boolean
}

const blankDefaults: MockupSettingFormValues = {
  apiBaseUrl: "",
  apiKey: "",
  webhookSecret: "",
  costPerRender: 1,
  enabled: false,
}

/**
 * 企业级样机渲染服务配置（超管）
 *
 * 每个企业对接各自的 psd-render-api 实例：服务地址 / API Key（AES 加密落库，
 * 留空不修改）/ Webhook 签名密钥（与 PS-API 该 API Key 的 webhookSecret 配对，
 * 配对后渲染终态主动推送）/ 渲染单价（积分/样机）/ 启用开关。
 *
 * 远端回填：open 时 getMockupSettingAction 拉取 → form.reset(映射值)；
 * 密钥明文不出库，仅以 hasApiKey/hasWebhookSecret 掩码回显。
 */
export function MockupConfigDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [hasApiKey, setHasApiKey] = React.useState(false)
  const [hasWebhookSecret, setHasWebhookSecret] = React.useState(false)

  const form = useForm<MockupSettingFormValues>({
    resolver: standardSchemaResolver(mockupSettingFormSchema),
    defaultValues: blankDefaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (!open) return
    let stop = false
    setLoading(true)
    setServerError(null)
    void getMockupSettingAction(enterpriseId)
      .then((cfg) => {
        if (stop) return
        setHasApiKey(cfg.hasApiKey)
        setHasWebhookSecret(cfg.hasWebhookSecret)
        form.reset({
          apiBaseUrl: cfg.apiBaseUrl,
          apiKey: "",
          webhookSecret: "",
          costPerRender: cfg.costPerRender,
          enabled: cfg.enabled,
        })
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
    }
  }, [open, enterpriseId, form])

  async function onSubmit(values: MockupSettingFormValues) {
    setServerError(null)
    const res = await saveMockupSettingAction({
      enterpriseId,
      apiBaseUrl: values.apiBaseUrl,
      apiKey: values.apiKey || undefined,
      webhookSecret: values.webhookSecret ? values.webhookSecret : undefined,
      costPerRender: values.costPerRender,
      enabled: values.enabled,
    })
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success("样机渲染配置已保存")
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Boxes className="size-4" />
            样机渲染
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>样机渲染配置</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」对接的 PSD 渲染服务（各企业可对接独立实例，模板目录相互隔离）
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="apiBaseUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>渲染服务地址</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="https://psd-render.example.com"
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      psd-render-api 的根地址（如 http://127.0.0.1:3000）
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Key</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        {...field}
                        placeholder={hasApiKey ? "已配置（留空不修改）" : "sk_live_…"}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="webhookSecret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Webhook 签名密钥</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        {...field}
                        placeholder={
                          hasWebhookSecret
                            ? "已配置（留空不修改，输入 - 清除）"
                            : "选填；填入后启用渲染终态主动推送"
                        }
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      与 PS-API 该 API Key 的 webhookSecret 保持一致；配置后渲染
                      完成/失败即时推送回调（仍需应用配置外部可达地址
                      NEXT_PUBLIC_APP_URL），未配置则纯轮询收敛
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="costPerRender"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>渲染单价（积分/样机）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
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
                name="enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm font-medium">
                        启用样机渲染
                      </FormLabel>
                      <p className="text-xs text-muted-foreground">
                        关闭后企业内样机页显示「未开通」，在途任务按失败退款
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
            disabled={pending || loading}
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
