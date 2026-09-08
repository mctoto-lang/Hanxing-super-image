"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Plus,
  Sparkles,
  Trash2,
  Check,
  X,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  MessageSquare,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  renameChatConversationAction,
  deleteChatConversationAction,
  togglePinChatConversationAction,
} from "@/server/actions/chat"
import type { ChatConversationListItem } from "@/components/chat/types"

/**
 * 左侧对话历史栏（复刻创作会话列表）
 *
 * - 顶部「新对话」按钮；
 * - 置顶组（无标签）+「最近」标签分组；
 * - 卡片 hover 菜单：置顶 / 重命名 / 删除；双击标题快捷改名；
 * - 隐藏滚动条。
 */
export function ChatConversationList({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: ChatConversationListItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const pinned = conversations.filter((c) => c.pinnedAt !== null)
  const recent = conversations.filter((c) => c.pinnedAt === null)

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md pr-1 transition-colors",
            selectedId === null ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md transition-colors",
              selectedId === null
                ? "bg-primary text-primary-foreground"
                : "bg-primary/10 text-primary",
            )}
          >
            <Plus className="size-5" />
          </span>
          <span className="text-sm font-medium">新对话</span>
        </button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-2 scrollbar-hide">
        {conversations.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-4 text-center">
            <Sparkles className="size-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              点击「新对话」开始与 AI 交流
            </p>
          </div>
        ) : (
          <>
            {pinned.map((c) => (
              <ConversationCard
                key={c.id}
                conversation={c}
                active={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {recent.length > 0 && (
              <p className="px-1 pb-0.5 pt-1 text-xs text-muted-foreground">最近</p>
            )}
            {recent.map((c) => (
              <ConversationCard
                key={c.id}
                conversation={c}
                active={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function ConversationCard({
  conversation,
  active,
  onSelect,
}: {
  conversation: ChatConversationListItem
  active: boolean
  onSelect: () => void
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [title, setTitle] = React.useState(conversation.title)
  const [saving, setSaving] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  React.useEffect(() => {
    if (!editing) setTitle(conversation.title)
  }, [conversation.title, editing])

  async function saveEdit() {
    const trimmed = title.trim()
    if (!trimmed || trimmed === conversation.title) {
      setEditing(false)
      setTitle(conversation.title)
      return
    }
    setSaving(true)
    const res = await renameChatConversationAction({
      id: conversation.id,
      title: trimmed,
    })
    setSaving(false)
    if (res.ok) {
      toast.success("已重命名")
      router.refresh()
    } else {
      toast.error(res.error ?? "重命名失败")
      setTitle(conversation.title)
    }
    setEditing(false)
  }

  async function handleTogglePin() {
    const res = await togglePinChatConversationAction(conversation.id)
    if (res.ok) {
      toast.success(res.pinned ? "已置顶" : "已取消置顶")
      router.refresh()
    } else {
      toast.error(res.error ?? "操作失败")
    }
  }

  async function handleDelete() {
    const res = await deleteChatConversationAction(conversation.id)
    setConfirmDelete(false)
    if (res.ok) {
      toast.success("已删除会话")
      onSelect()
      router.refresh()
    } else {
      toast.error(res.error ?? "删除失败")
    }
  }

  const pinned = conversation.pinnedAt !== null

  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 rounded-md pr-1 transition-colors",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <MessageSquare className="size-4 text-muted-foreground/60" />
      </div>

      {editing ? (
        <div className="flex flex-1 items-center gap-1">
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                setEditing(false)
                setTitle(conversation.title)
              } else if (e.key === "Enter") {
                e.preventDefault()
                void saveEdit()
              }
            }}
            onBlur={() => void saveEdit()}
            disabled={saving}
            maxLength={60}
            className="w-full rounded border bg-background px-1.5 py-0.5 text-sm focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : (
        <div
          className="flex min-w-0 flex-1 items-center"
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate text-sm" />}>
                {conversation.title}
              </TooltipTrigger>
              <TooltipContent side="right" align="center" sideOffset={8}>
                {conversation.title}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      {editing ? (
        <div className="flex shrink-0 gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void saveEdit()
            }}
            className="rounded p-1 hover:bg-accent"
          >
            <Check className="size-3.5 text-primary" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setEditing(false)
              setTitle(conversation.title)
            }}
            className="rounded p-1 hover:bg-accent"
          >
            <X className="size-3.5 text-muted-foreground" />
          </button>
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
            title="更多操作"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-32"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem onClick={() => void handleTogglePin()}>
              {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              {pinned ? "取消置顶" : "置顶"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>删除会话「{conversation.title}」？</DialogTitle>
            <DialogDescription>
              将永久删除该会话及其所有消息记录。已消耗积分不退还。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDelete(false)
              }}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation()
                void handleDelete()
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
