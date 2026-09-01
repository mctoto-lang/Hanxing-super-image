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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { AvatarUpload } from "@/components/shared/avatar-upload"
import {
  assignGroupAction,
  changeRoleAction,
  setMemberAvatarAction,
} from "@/server/actions/admin-users"
import type { EnterpriseRole } from "@/db/schema"

export interface EditableMember {
  id: string
  username: string
  name: string | null
  image: string | null
  enterpriseRole: EnterpriseRole
  groupId: string | null
}

/**
 * 成员编辑对话框：头像 + 角色 + 权限组统一编辑。
 *
 * - 头像：上传走 /api/upload/avatar，保存时调 setMemberAvatarAction 落库；
 * - 角色：复用 changeRoleAction（成员↔管理员）；owner 角色由平台超管指定，
 *   企业管理员不可修改（弹窗内只读展示）；
 * - 权限组：复用 assignGroupAction，所有成员（含 owner 行）均可由企业管理员分配；
 *   权限组同样会限制 owner 的业务模块可见范围，故附提示。
 * 仅保存有变更的字段，任一步失败即提示并保留弹窗。
 */
export function MemberEditDialog({
  member,
  groups,
}: {
  member: EditableMember
  groups: { id: string; name: string }[]
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(member.image)
  const [role, setRole] = React.useState<EnterpriseRole>(member.enterpriseRole)
  const [groupId, setGroupId] = React.useState(member.groupId ?? "")
  const router = useRouter()

  const isOwner = member.enterpriseRole === "owner"

  React.useEffect(() => {
    if (open) {
      setAvatarUrl(member.image)
      setRole(member.enterpriseRole)
      setGroupId(member.groupId ?? "")
    }
  }, [open, member])

  function handleSave() {
    startTransition(async () => {
      const tasks: { label: string; run: () => Promise<{ ok: boolean; error?: string }> }[] = []

      if (avatarUrl !== member.image) {
        tasks.push({
          label: "头像",
          run: async () => {
            const res = await setMemberAvatarAction({
              userId: member.id,
              imageUrl: avatarUrl,
            })
            return res.ok ? { ok: true } : { ok: false, error: res.error }
          },
        })
      }
      if (!isOwner && role !== member.enterpriseRole) {
        tasks.push({
          label: "角色",
          run: async () => {
            const res = await changeRoleAction({ userId: member.id, role })
            return res.ok ? { ok: true } : { ok: false, error: res.error }
          },
        })
      }
      if (groupId && groupId !== member.groupId) {
        tasks.push({
          label: "权限组",
          run: async () => {
            const res = await assignGroupAction({ userId: member.id, groupId })
            return res.ok ? { ok: true } : { ok: false, error: res.error }
          },
        })
      }

      if (tasks.length === 0) {
        toast.info("没有需要保存的变更")
        setOpen(false)
        return
      }

      for (const task of tasks) {
        const res = await task.run()
        if (!res.ok) {
          toast.error(`${task.label}保存失败：${res.error ?? "未知错误"}`)
          return
        }
      }
      toast.success("成员信息已更新")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Settings2 className="size-3.5" />
            编辑
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>编辑成员</DialogTitle>
          <DialogDescription>
            {member.name ?? member.username}（@{member.username}）
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">头像</p>
            <AvatarUpload
              imageUrl={avatarUrl}
              onChange={setAvatarUrl}
              fallbackText={member.name ?? member.username}
              disabled={pending}
            />
          </div>
          {isOwner ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">角色</p>
              <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                当前角色：企业管理员（owner）· 该角色由平台超管指定，此处不可修改
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">角色</p>
              <Select
                value={role}
                onValueChange={(v) => setRole((v ?? "member") as EnterpriseRole)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{role === "admin" ? "管理员" : "成员"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">成员</SelectItem>
                  <SelectItem value="admin">管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">权限组</p>
            <Select value={groupId} onValueChange={(v) => setGroupId(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择权限组">
                    {groupId
                      ? (groups.find((g) => g.id === groupId)?.name ?? "选择权限组")
                      : "选择权限组"}
                  </SelectValue>
                </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!member.groupId && !groupId ? (
              <p className="text-xs text-muted-foreground">
                当前未分配权限组，选择后保存生效
              </p>
            ) : null}
            {isOwner ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                注意：权限组会限制该成员可见的业务模块（含最高账号），请谨慎分配
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={pending}>
            {pending ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
