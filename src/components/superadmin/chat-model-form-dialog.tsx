"use client"

import * as React from "react"
import { Pencil, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import {
  createPresetChatModelAction,
  updatePresetChatModelAction,
  togglePresetChatModelActiveAction,
  type PresetChatModelRow,
} from "@/server/actions/platform-chat-models"
import {
  ChatModelFields,
  chatModelFormFromRow,
  emptyChatModelState,
  buildChatModelInput,
  type ChatModelFormState,
} from "@/components/model-form/chat-model-fields"

/**
 * 平台预置对话模型表单（OpenAI 兼容）
 *
 * 字段组件与企业管理员对话模型表单共用（model-form/chat-model-fields），
 * 此处仅包装超管 Action（enterpriseId=NULL）。
 */

export function ChatModelFormDialog({
  model,
  trigger,
}: {
  model?: PresetChatModelRow
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [state, setState] = React.useState<ChatModelFormState>(
    model ? chatModelFormFromRow(model) : emptyChatModelState(),
  )
  const router = useRouter()
  const isEdit = Boolean(model)

  React.useEffect(() => {
    if (open) setState(model ? chatModelFormFromRow(model) : emptyChatModelState())
  }, [open, model])

  function up<K extends keyof ChatModelFormState>(
    key: K,
    val: ChatModelFormState[K],
  ) {
    setState((s) => ({ ...s, [key]: val }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input = buildChatModelInput(state)
    startTransition(async () => {
      const res = isEdit
        ? await updatePresetChatModelAction(model!.id, input)
        : await createPresetChatModelAction(input)
      if (res.ok) {
        toast.success(isEdit ? "平台对话模型已更新" : "平台对话模型已创建")
        setOpen(false)
        router.refresh()
      } else {
        toast.error(res.error ?? "操作失败")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button>
              <Plus className="size-4" />
              {isEdit ? "编辑" : "新建对话模型"}
            </Button>
          )
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "编辑平台预置对话模型" : "新建平台预置对话模型"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <ChatModelFields state={state} up={up} isEdit={isEdit} />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "保存中..." : isEdit ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 表格行内的编辑触发按钮 */
export function ChatModelEditButton({ model }: { model: PresetChatModelRow }) {
  return (
    <ChatModelFormDialog
      model={model}
      trigger={
        <Button variant="ghost" size="sm">
          <Pencil className="size-4" />
          编辑
        </Button>
      }
    />
  )
}

/** 启停按钮 */
export function ChatModelToggleActiveButton({
  model,
}: {
  model: PresetChatModelRow
}) {
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const res = await togglePresetChatModelActiveAction(
            model.id,
            !model.isActive,
          )
          if (res.ok) {
            toast.success(model.isActive ? "已停用" : "已启用")
            router.refresh()
          } else {
            toast.error(res.error ?? "操作失败")
          }
        })
      }}
    >
      {pending ? "处理中" : model.isActive ? "停用" : "启用"}
    </Button>
  )
}
