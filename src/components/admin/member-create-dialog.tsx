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
import { useForm } from "react-hook-form"
import { memberCreateFormSchema } from "@/lib/forms/schemas"
import { createMemberAction } from "@/server/actions/admin-users"

interface MemberCreateValues {
  username: string
  password: string
  name?: string
  email?: string
  // 与 memberCreateFormSchema 的枚举保持一致（企业侧 Select 只提供 member/admin）
  role: "member" | "admin" | "owner"
  groupId?: string
}

export function MemberCreateDialog({
  groups,
}: {
  groups: Array<{ id: string; name: string; isDefault: boolean }>
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<MemberCreateValues>({
    resolver: standardSchemaResolver(memberCreateFormSchema),
    defaultValues: { username: "", password: "", name: "", email: "", role: "member", groupId: "" },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ username: "", password: "", name: "", email: "", role: "member", groupId: "" })
      setServerError(null)
    }
  }, [open, form])

  async function onSubmit(values: MemberCreateValues) {
    setServerError(null)
    const res = await createMemberAction({
      username: values.username,
      password: values.password,
      name: values.name?.trim() || undefined,
      email: values.email?.trim() || undefined,
      role: values.role,
      // 未选择时走后端默认逻辑：自动进入企业默认权限组
      groupId: values.groupId || undefined,
    })
    if (res.ok) {
      toast.success("成员创建成功")
      setOpen(false)
      router.refresh()
      return
    }
    setServerError(res.error ?? "创建失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" />添加成员</Button>} />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
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
                      <Input {...field} />
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
                    <FormLabel>昵称</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>密码</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>邮箱（可选）</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>角色</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => field.onChange(v ?? "member")}
                    items={[
                      { value: "member", label: "成员" },
                      { value: "admin", label: "成员管理员" },
                    ]}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {field.value === "admin" ? "成员管理员" : "成员"}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="member">成员</SelectItem>
                      <SelectItem value="admin">成员管理员</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="groupId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>权限组</FormLabel>
                  <Select
                    value={field.value || "__default__"}
                    onValueChange={(v) => field.onChange(v && v !== "__default__" ? v : "")}
                    items={[
                      { value: "__default__", label: "默认权限组（自动分配）" },
                      ...groups.map((g) => ({
                        value: g.id,
                        label: g.isDefault ? `${g.name}（默认）` : g.name,
                      })),
                    ]}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {field.value
                            ? (groups.find((g) => g.id === field.value)?.name ?? "选择权限组")
                            : "默认权限组（自动分配）"}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__default__">默认权限组（自动分配）</SelectItem>
                      {groups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.isDefault ? `${g.name}（默认）` : g.name}
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
                {pending ? "创建中…" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
