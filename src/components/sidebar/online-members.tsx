"use client"

import * as React from "react"

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * 顶栏在线成员头像组（叠放视觉参考 21st.dev stacked-list）
 *
 * 每 30s GET /api/presence，请求本身即心跳：服务端以 Redis ZSET 记录
 * 活跃时间，90s 未见心跳视为离线。页面隐藏时暂停轮询（切走即离线，
 * 与常见 IM 行为一致），回到前台立即补一次心跳。
 * 会话过期（被代理重定向返回 HTML）静默停止，等待下次进入页面。
 */

interface OnlineMember {
  id: string
  name: string
  avatar: string | null
  roleLabel: string
}

/** 心跳间隔；需与 presence.ts 的在线窗口（30s × 3）联动调整 */
const HEARTBEAT_MS = 30_000

/** 头像组最多直接展示的人数，超出部分折叠为 +X */
const MAX_VISIBLE = 3

export function OnlineMembers({ enabled }: { enabled: boolean }) {
  const [members, setMembers] = React.useState<OnlineMember[]>([])

  React.useEffect(() => {
    if (!enabled) return
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null

    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }

    const beat = async () => {
      if (document.hidden) return
      try {
        const resp = await fetch("/api/presence")
        // 未登录被代理重定向到 /login 时返回 200 HTML
        const contentType = resp.headers.get("content-type") ?? ""
        if (contentType.includes("text/html")) {
          stop()
          return
        }
        if (!resp.ok) return
        const data = (await resp.json()) as { members?: OnlineMember[] }
        if (!stopped) setMembers(data.members ?? [])
      } catch {
        // 网络抖动忽略，等待下一轮心跳
      }
    }

    const onVisible = () => {
      if (!document.hidden) void beat()
    }

    void beat()
    timer = setInterval(beat, HEARTBEAT_MS)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      stopped = true
      stop()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [enabled])

  if (!enabled || members.length === 0) return null

  const visible = members.slice(0, MAX_VISIBLE)
  const overflow = members.length - visible.length

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`在线成员 ${members.length} 人`}
            className="ml-auto flex h-9 items-center rounded-full px-1 outline-hidden transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <AvatarGroup>
          {visible.map((m) => (
            <Avatar key={m.id} size="sm">
              <AvatarImage src={m.avatar ?? undefined} alt={m.name} />
              <AvatarFallback>{m.name.slice(0, 1).toUpperCase()}</AvatarFallback>
              <AvatarBadge className="bg-emerald-500" />
            </Avatar>
          ))}
          {overflow > 0 && (
            <AvatarGroupCount className="text-xs">+{overflow}</AvatarGroupCount>
          )}
        </AvatarGroup>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-0 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="text-sm font-medium">在线成员</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs leading-none text-muted-foreground tabular-nums">
            {members.length}
          </span>
        </div>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {members.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5"
            >
              <Avatar size="sm">
                <AvatarImage src={m.avatar ?? undefined} alt={m.name} />
                <AvatarFallback>
                  {m.name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
                <AvatarBadge className="bg-emerald-500" />
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-sm">
                {m.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {m.roleLabel}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
