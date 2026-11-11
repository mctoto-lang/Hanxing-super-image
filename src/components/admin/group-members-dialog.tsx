"use client"

import * as React from "react"
import { Users } from "lucide-react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
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
import { roleLabel } from "@/lib/auth/permissions"
import { groupMembersFormSchema } from "@/lib/forms/config-schemas"
import { groupMembersDescription } from "@/components/admin/group-members-description"
import {
  listGroupMembersAction,
  moveGroupMembersAction,
} from "@/server/actions/admin-groups"

interface GroupMember {
  id: string
  username: string
  name: string | null
  enterpriseRole: "owner" | "admin" | "member"
  status: "active" | "disabled"
}

interface GroupMembersFormValues {
  toGroupId: string
}

/** 未选择占位项（onValueChange 映射回空串以触发必填校验） */
const GROUP_NONE = "__none__"
const GROUP_NONE_LABEL = "选择目标权限组"

/**
 * 权限组成员弹窗：查看组内成员 + 整组转移到目标组。
 *
 * 删除权限组要求组内无成员（deleteGroupAction 既有校验），此前只能
 * 逐个到成员编辑里改组；此弹窗支持「全部转移至」一键清空，为删除
 * 组铺路。空组同样可打开（成员列表为空）。
 */
export function GroupMembersDialog({
  group,
  groups,
}: {
  group: { id: string; name: string; memberCount: number }
  /** 本企业全部权限组（目标组下拉，排除自身） */
  groups: Array<{ id: string; name: string; isDefault: boolean }>
}) {
  const [open, setOpen] = React.useState(false)
  const [members, setMembers] = React.useState<GroupMember[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()

  const otherGroups = groups.filter((g) => g.id !== group.id)

  const form = useForm<GroupMembersFormValues>({
    resolver: standardSchemaResolver(groupMembersFormSchema),
    defaultValues: { toGroupId: "" },
  })

  React.useEffect(() => {
    if (!open) return
    form.reset({ toGroupId: "" })
    setMembers(null)
    setLoading(true)
    listGroupMembersAction(group.id)
      .then((res) => {
        if (res.ok) setMembers(res.members)
        else toast.error(res.error ?? "加载成员失败")
      })
      .finally(() => setLoading(false))
  }, [open, group.id, form])

  function onSubmit(values: GroupMembersFormValues) {
    startTransition(async () => {
      const res = await moveGroupMembersAction({
        fromGroupId: group.id,
        toGroupId: values.toGroupId,
      })
      if (!res.ok) {
        toast.error(res.error ?? "转移失败")
        return
      }
      toast.success(`已转移 ${res.moved} 名成员`)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" className="tabular-nums">
            <Users className="size-3.5" />
            {group.memberCount}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>组成员 · {group.name}</DialogTitle>
          <DialogDescription>
            {groupMembersDescription(
              group.memberCount,
              members ? members.length : null,
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              加载中...
            </p>
          ) : null}
          {!loading && members && members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              组内暂无成员
            </p>
          ) : null}
          {members?.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5"
            >
              <div className="min-w-0">
                <span className="font-mono text-sm">{m.username}</span>
                {m.name ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {m.name}
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {m.status !== "active" ? (
                  <Badge variant="destructive" className="text-xs">
                    已禁用
                  </Badge>
                ) : null}
                <Badge variant="outline" className="text-xs">
                  {roleLabel(m.enterpriseRole)}
                </Badge>
              </div>
            </div>
          ))}
        </div>
        <Form {...form}>
          <form
            id="group-members-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-2 border-t pt-3"
          >
            <FormField
              control={form.control}
              name="toGroupId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>全部转移至</FormLabel>
                  <Select
                    value={field.value || GROUP_NONE}
                    onValueChange={(v) =>
                      field.onChange(v && v !== GROUP_NONE ? v : "")
                    }
                    items={[
                      { value: GROUP_NONE, label: GROUP_NONE_LABEL },
                      ...otherGroups.map((g) => ({
                        value: g.id,
                        label: g.isDefault ? `${g.name}（默认）` : g.name,
                      })),
                    ]}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {field.value
                            ? (otherGroups.find((g) => g.id === field.value)?.name ??
                              GROUP_NONE_LABEL)
                            : GROUP_NONE_LABEL}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={GROUP_NONE}>{GROUP_NONE_LABEL}</SelectItem>
                      {otherGroups.map((g) => (
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
          </form>
        </Form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            关闭
          </Button>
          <Button
            type="submit"
            form="group-members-form"
            disabled={pending || (members?.length ?? 0) === 0}
          >
            {pending ? "转移中..." : "全部转移"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
