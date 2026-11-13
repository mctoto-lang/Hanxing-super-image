"use client"

import * as React from "react"
import { Pencil, Plus, Store, Trash2 } from "lucide-react"
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
import { temuAppSettingFormSchema } from "@/lib/forms/config-schemas"
import { MAX_STORES_PER_APP } from "@/lib/temu-api/constants"
import {
  deleteTemuAppAction,
  listTemuAppsAction,
  saveTemuAppAction,
  type TemuAppView,
} from "@/server/actions/platform"

interface TemuAppSettingFormValues {
  name: string
  appKey: string
  appSecret: string
  testMode: boolean
}

const blankDefaults: TemuAppSettingFormValues = {
  name: "",
  appKey: "",
  appSecret: "",
  testMode: false,
}



/**
 * 企业 TEMU 应用管理（多主体，超管）：一个企业可配置多个官方开放平台自研
 * 应用（各主体一套 app_key/secret，AES 加密落库、掩码回显、留空不修改），
 * 店铺挂到应用下（单应用最多 20 家）。单弹窗双态：列表态（编辑/删除/新增）
 * 与表单态（新建/编辑合一）。
 */
export function TemuAppManageDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  /** 表单态：editing=null 且 creating=true 为新建；两者皆空为列表态 */
  const [editing, setEditing] = React.useState<TemuAppView | null>(null)
  const [creating, setCreating] = React.useState(false)
  const formOpen = editing !== null || creating
  const [apps, setApps] = React.useState<TemuAppView[]>([])
  const [loading, setLoading] = React.useState(false)
  /** 加载失败：禁表单防覆盖（口径沿旧配置弹窗） */
  const [loadError, setLoadError] = React.useState(false)
  const [deleting, setDeleting] = React.useState<TemuAppView | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState(false)

  const form = useForm<TemuAppSettingFormValues>({
    resolver: standardSchemaResolver(temuAppSettingFormSchema),
    defaultValues: blankDefaults,
  })
  const pending = form.formState.isSubmitting

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      setApps(await listTemuAppsAction(enterpriseId))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [enterpriseId])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  function startEdit(app: TemuAppView | null) {
    setEditing(app)
    setCreating(app === null)
    form.reset(
      app
        ? { name: app.name, appKey: app.appKey, appSecret: app.appSecret, testMode: app.testMode }
        : blankDefaults,
    )
  }

  async function onSubmit(values: TemuAppSettingFormValues) {
    try {
      const res = await saveTemuAppAction({
        enterpriseId,
        appId: editing?.id ?? undefined,
        name: values.name,
        appKey: values.appKey,
        appSecret: values.appSecret,
        testMode: values.testMode,
      })
      if (!res.ok) {
        form.setError("root", { message: res.error ?? "保存失败" })
        return
      }
      toast.success(editing ? `应用「${values.name}」已更新` : `应用「${values.name}」已创建`)
      setEditing(null)
      setCreating(false)
      await refresh()
    } catch {
      form.setError("root", { message: "保存失败，请重试" })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setEditing(null)
          setCreating(false)
        }
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Store className="size-4" />
            TEMU应用
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>TEMU 应用管理</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」的官方开放平台自研应用（多主体）：每套应用一对
            app_key/secret，店铺挂到应用下（单应用最多 {MAX_STORES_PER_APP} 家）
          </DialogDescription>
        </DialogHeader>

        {formOpen ? (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>应用名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如 主体A / 华侨主账号" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="appKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>app_key</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="TEMU 开放平台自研应用的 app_key" />
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
                          editing && field.value
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
                        该应用调用时改用官方文档测试账号（全托），供正式应用审批下来前联调；店铺
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
              {form.formState.errors.root ? (
                <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
              ) : null}
            </form>
          </Form>
        ) : loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <DashRing className="mr-2 size-4" /> 加载中…
          </div>
        ) : loadError ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-destructive">
            应用列表加载失败，请关闭后重试。
          </div>
        ) : (
          <div className="space-y-2">
            {apps.map((app) => (
              <div
                key={app.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {app.name}
                    {app.testMode && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                        测试模式
                      </span>
                    )}
                    {!app.enabled && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        已停用
                      </span>
                    )}
                    <span className="text-xs font-normal text-muted-foreground">
                      店铺 {app.storeCount}/{MAX_STORES_PER_APP}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {app.appKey ? `app_key ${app.appKey}` : "未配置 app_key"}
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => startEdit(app)}>
                  <Pencil className="size-3.5" />
                  编辑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  disabled={app.storeCount > 0}
                  onClick={() => setDeleting(app)}
                >
                  <Trash2 className="size-3.5" />
                  删除
                </Button>
              </div>
            ))}
            {apps.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                尚未配置 TEMU 应用。企业 TEMU 页面将处于演示模式（官方沙箱数据）。
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => startEdit(null)}
            >
              <Plus className="size-3.5" />
              新增应用
            </Button>
            <p className="text-xs text-muted-foreground">
              凭证与店铺 token 均加密存储；删除应用前需先删除其下店铺。
            </p>
          </div>
        )}

        <DialogFooter>
          {formOpen ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(null)
                  setCreating(false)
                }}
              >
                返回列表
              </Button>
              <Button
                disabled={pending}
                onClick={() => void form.handleSubmit(onSubmit)()}
              >
                {pending ? <DashRing className="size-4" /> : null}
                {pending ? "保存中…" : "保存"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="删除 TEMU 应用"
        description={
          deleting
            ? `确认删除应用「${deleting.name}」？该操作不可恢复。`
            : ""
        }
        confirmText="删除"
        destructive
        pending={pendingDelete}
        onConfirm={() => {
          if (!deleting) return
          setPendingDelete(true)
          void (async () => {
            try {
              const res = await deleteTemuAppAction({ enterpriseId, appId: deleting.id })
              if (!res.ok) {
                toast.error(res.error ?? "删除失败")
                return
              }
              toast.success(`已删除应用「${deleting.name}」`)
              setDeleting(null)
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
