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
import { cn, toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import { toast } from "sonner"
import {
  renameConversationAction,
  deleteConversationAction,
  togglePinConversationAction,
} from "@/server/actions/conversations"

/**
 * 左侧会话列表（自由创作页 §6）
 *
 * - 顶部：「新对话」行按钮（与历史卡片同高同样式）。
 * - 列表：置顶会话在前（无标签），「最近」标签下为其余会话。
 * - 卡片 hover 出现「更多」菜单：置顶 / 重命名 / 删除。
 * - 双击标题可快捷改名；隐藏滚动条。
 */

export interface ConversationListItem {
  id: string
  title: string
  lastImageThumb: string | null
  pinnedAt: Date | null
  updatedAt: Date
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: ConversationListItem[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  // 置顶组在前（上方无标签），「最近」标签下为其余会话
  const pinned = conversations.filter((c) => c.pinnedAt !== null)
  const recent = conversations.filter((c) => c.pinnedAt === null)

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：新对话按钮（与历史卡片同高同样式，与上方留出间隔） */}
      <div className="px-3 pt-2 pb-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-md pr-1 transition-colors",
            selectedId === null
              ? "bg-accent"
              : "hover:bg-accent/60",
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

      {/* 会话列表：置顶组 + 「最近」 */}
      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-2 scrollbar-hide">
        {conversations.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 px-4 text-center">
            <Sparkles className="size-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              点击「新对话」开始创作
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
              <p className="px-1 pt-1 pb-0.5 text-xs text-muted-foreground">
                最近
              </p>
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

/** 单个会话卡片（缩略图 + 单行标题，更多菜单：置顶/重命名/删除） */
function ConversationCard({
  conversation,
  active,
  onSelect,
}: {
  conversation: ConversationListItem
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

  // 编辑过程中保持 title 与外部同步（重命名成功后父组件刷新）
  React.useEffect(() => {
    if (!editing) setTitle(conversation.title)
  }, [conversation.title, editing])

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation()
    setEditing(true)
  }

  async function saveEdit() {
    const trimmed = title.trim()
    if (!trimmed || trimmed === conversation.title) {
      setEditing(false)
      setTitle(conversation.title)
      return
    }
    setSaving(true)
    const res = await renameConversationAction({
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

  function cancelEdit(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      setEditing(false)
      setTitle(conversation.title)
    } else if (e.key === "Enter") {
      e.preventDefault()
      void saveEdit()
    }
  }

  async function handleTogglePin() {
    const res = await togglePinConversationAction(conversation.id)
    if (res.ok) {
      toast.success(res.pinned ? "已置顶" : "已取消置顶")
      router.refresh()
    } else {
      toast.error(res.error ?? "操作失败")
    }
  }

  async function handleDelete() {
    const res = await deleteConversationAction(conversation.id)
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
      {/* 左侧正方形缩略图（决定卡片与 hover 背景高度） */}
      {conversation.lastImageThumb ? (
        <SmartImage
          src={toImageSrc(conversation.lastImageThumb, { width: 96 })}
          alt=""
          className="size-9 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <MessageSquare className="size-4 text-muted-foreground/60" />
        </div>
      )}

      {/* 标题（单行截断，悬停 Tooltip 显示完整标题，双击改名） */}
      {editing ? (
        <div className="flex flex-1 items-center gap-1">
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={cancelEdit}
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
          onDoubleClick={startEdit}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={<span className="min-w-0 truncate text-sm" />}
              >
                {conversation.title}
              </TooltipTrigger>
              <TooltipContent side="right" align="center" sideOffset={8}>
                {conversation.title}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      {/* 编辑中的确认/取消 */}
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
        /* hover 出现的「更多」菜单 */
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
              {pinned ? (
                <PinOff className="size-4" />
              ) : (
                <Pin className="size-4" />
              )}
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

      {/* 删除确认弹窗 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>删除会话「{conversation.title}」？</DialogTitle>
            <DialogDescription>
              将永久删除该会话及其下所有生成记录。积分不退还。
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
