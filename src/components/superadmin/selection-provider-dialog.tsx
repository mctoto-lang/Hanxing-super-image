"use client"

import * as React from "react"
import { Crosshair, Trash2 } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
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
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { selectionProviderFormSchema } from "@/lib/forms/config-schemas"
import {
  deleteSelectionProviderAction,
  listSelectionProvidersAction,
  saveSelectionProviderAction,
  type SelectionProviderView,
} from "@/server/actions/platform"

interface SelectionProviderFormValues {
  name: string
  token: string
  enabled: boolean
}

const blankDefaults: SelectionProviderFormValues = {
  name: "",
  token: "",
  enabled: true,
}

/**
 * 企业选品抓取凭证管理（超管）：每企业一行 Apify API Token（AES 加密落库、
 * 掩码回显、留空不修改）。未配置的企业提交任务时回退平台级
 * APIFY_API_TOKEN 兜底（若也未配置则报错指引配置）。
 */
export function SelectionProviderDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [provider, setProvider] = React.useState<SelectionProviderView | null>(null)
  const [loading, setLoading] = React.useState(false)
  /** 加载失败：禁表单防覆盖 */
  const [loadError, setLoadError] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState(false)

  const form = useForm<SelectionProviderFormValues>({
    resolver: standardSchemaResolver(selectionProviderFormSchema),
    defaultValues: blankDefaults,
  })
  const pending = form.formState.isSubmitting

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const rows = await listSelectionProvidersAction(enterpriseId)
      const row = rows[0] ?? null
      setProvider(row)
      form.reset(
        row
          ? { name: row.name, token: row.token, enabled: row.enabled }
          : blankDefaults,
      )
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [enterpriseId, form])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  async function onSubmit(values: SelectionProviderFormValues) {
    try {
      const res = await saveSelectionProviderAction({
        enterpriseId,
        name: values.name,
        token: values.token,
        enabled: values.enabled,
      })
      if (!res.ok) {
        form.setError("root", { message: res.error ?? "保存失败" })
        return
      }
      toast.success(`「${enterpriseName}」选品抓取凭证已保存`)
      await refresh()
    } catch {
      form.setError("root", { message: "保存失败，请重试" })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Crosshair className="size-4" />
            选品抓取
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>选品抓取凭证</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」的 Apify API Token（加密存储）：选品任务用企业
            Token 计费抓取；未配置或停用时回退平台级 APIFY_API_TOKEN 兜底
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <DashRing className="mr-2 size-4" /> 加载中…
          </div>
        ) : loadError ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-destructive">
            凭证加载失败，请关闭后重试。
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>凭证名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如 主账号 Apify" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="token"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Apify API Token</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        {...field}
                        placeholder={
                          provider
                            ? "已配置（掩码提交=不修改，清空并保存=删除）"
                            : "apify_api_xxx（console.apify.com → Settings → API）"
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
                      <FormLabel className="text-sm font-medium">启用</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        停用后该企业任务回退平台兜底 Token（或报错指引配置）
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
              {form.formState.errors.root ? (
                <p className="text-sm text-destructive">
                  {form.formState.errors.root.message}
                </p>
              ) : null}
              {provider ? (
                <p className="text-xs text-muted-foreground">
                  历史任务 {provider.taskCount} 个引用该凭证（含已完成）——引用中
                  的任务收割依赖同账号读取 dataset，删除前请确认无进行中任务。
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  尚未配置企业凭证：该企业任务将使用平台级兜底 Token。
                </p>
              )}
            </form>
          </Form>
        )}

        <DialogFooter>
          {provider && !loading && !loadError ? (
            <Button
              variant="outline"
              size="sm"
              className="mr-auto text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" />
              删除凭证
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setOpen(false)}>
            关闭
          </Button>
          <Button
            disabled={pending || loading || loadError}
            onClick={() => void form.handleSubmit(onSubmit)()}
          >
            {pending ? <DashRing className="size-4" /> : null}
            {pending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(false)}
        title="删除选品抓取凭证"
        description={`确认删除「${enterpriseName}」的企业级 Apify Token？该企业任务将回退平台兜底 Token。`}
        confirmText="删除"
        destructive
        pending={pendingDelete}
        onConfirm={() => {
          setPendingDelete(true)
          void (async () => {
            try {
              const res = await deleteSelectionProviderAction({ enterpriseId })
              if (!res.ok) {
                toast.error(res.error ?? "删除失败")
                return
              }
              toast.success("已删除企业选品凭证")
              setConfirmDelete(false)
              await refresh()
            } catch {
              toast.error("删除失败，请重试")
            } finally {
              setPendingDelete(false)
            }
          })()
        }}
      />
    </Dialog>
  )
}
