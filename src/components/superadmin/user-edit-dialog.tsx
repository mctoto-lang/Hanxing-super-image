"use client"

import * as React from "react"
import { Pencil } from "lucide-react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { useForm, useWatch } from "react-hook-form"
import type { z } from "zod"
import { userEditFormSchema } from "@/lib/forms/schemas"
import { updatePlatformUserAction } from "@/server/actions/platform"

type UserEditValues = z.infer<typeof userEditFormSchema>

export interface EditablePlatformUser {
  id: string
  username: string
  name: string | null
  isSuperAdmin: boolean
  enterpriseId: string | null
  enterpriseRole: "owner" | "admin" | "member"
}

const ROLE_OPTIONS = [
  { value: "owner", label: "企业管理员" },
  { value: "admin", label: "成员管理员" },
  { value: "member", label: "成员" },
] as const

/**
 * 超管编辑平台用户弹窗（用户名/昵称/类型/归属企业/角色）。
 *
 * 联动：类型=超管时「归属企业/角色」禁用置空（超管不归属企业、角色无
 * 语义，服务端同样强制回落）；owner 变动与最后一个 owner 保护由服务端
 * 兜底（错误内联展示）。
 */
export function UserEditDialog({
  user,
  enterprises,
}: {
  user: EditablePlatformUser
  enterprises: { id: string; name: string }[]
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const defaultValues: UserEditValues = {
    username: user.username,
    name: user.name ?? "",
    isSuperAdmin: user.isSuperAdmin,
    enterpriseId: user.isSuperAdmin ? "" : (user.enterpriseId ?? ""),
    role: user.enterpriseRole,
  }

  const form = useForm<UserEditValues>({
    resolver: standardSchemaResolver(userEditFormSchema),
    defaultValues,
  })
  const pending = form.formState.isSubmitting
  // useWatch 替代 form.watch：后者返回不可安全 memoize 的函数，会使 React Compiler 跳过本组件记忆化
  const isSuperAdmin = useWatch({ control: form.control, name: "isSuperAdmin" })

  React.useEffect(() => {
    if (open) {
      form.reset(defaultValues)
      setServerError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 切换为超管时清空企业（提交口径：超管不归属企业）
  React.useEffect(() => {
    if (isSuperAdmin && form.getValues("enterpriseId") !== "") {
      form.setValue("enterpriseId", "")
    }
  }, [isSuperAdmin, form])

  async function onSubmit(values: UserEditValues) {
    setServerError(null)
    const res = await updatePlatformUserAction({
      userId: user.id,
      username: values.username.trim(),
      name: values.name?.trim() || undefined,
      isSuperAdmin: values.isSuperAdmin,
      enterpriseId: values.enterpriseId,
      enterpriseRole: values.role,
    })
    if (res.ok) {
      toast.success("用户信息已更新")
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
          <Button variant="ghost" size="sm" aria-label={`编辑用户 ${user.username}`}>
            <Pencil className="size-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>编辑用户</DialogTitle>
          <DialogDescription>
            修改用户名（全局唯一）、昵称、类型、归属企业与角色；企业用户转企业后权限组回落目标企业默认组
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>用户名</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="登录账号（全局唯一）" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>昵称（可选）</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如：张三" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="isSuperAdmin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>类型</FormLabel>
                    <Select
                      value={field.value ? "superadmin" : "enterprise"}
                      onValueChange={(v) => field.onChange(v === "superadmin")}
                      items={[
                        { value: "enterprise", label: "企业用户" },
                        { value: "superadmin", label: "超管" },
                      ]}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {field.value ? "超管" : "企业用户"}
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="enterprise">企业用户</SelectItem>
                        <SelectItem value="superadmin">超管</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>角色</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v ?? "member")}
                      items={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      disabled={isSuperAdmin}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {ROLE_OPTIONS.find((o) => o.value === field.value)?.label ?? "成员"}
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROLE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                    {isSuperAdmin ? (
                      <p className="text-xs text-muted-foreground">超管无企业角色语义</p>
                    ) : null}
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="enterpriseId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>归属企业</FormLabel>
                  <Select
                    value={field.value || "__none__"}
                    onValueChange={(v) => field.onChange(v === "__none__" ? "" : (v ?? ""))}
                    items={[
                      { value: "__none__", label: "未归属（仅超管）" },
                      ...enterprises.map((e) => ({ value: e.id, label: e.name })),
                    ]}
                    disabled={isSuperAdmin}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {isSuperAdmin
                            ? "超管不归属企业"
                            : field.value
                              ? (enterprises.find((e) => e.id === field.value)?.name ?? "选择企业")
                              : "选择企业"}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {enterprises.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
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
    </Dialog>
  )
}
