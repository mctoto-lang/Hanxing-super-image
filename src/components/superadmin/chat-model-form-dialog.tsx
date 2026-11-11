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
import { Form } from "@/components/ui/form"
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
  useChatModelForm,
} from "@/components/model-form/chat-model-fields"

/**
 * 平台预置对话模型表单（OpenAI 兼容）
 *
 * 字段组件与企业管理员对话模型表单共用（model-form/chat-model-fields，
 * RHF 统一设计语言），此处仅包装超管 Action（enterpriseId=NULL）。
 */

export function ChatModelFormDialog({
  model,
  trigger,
}: {
  model?: PresetChatModelRow
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const form = useChatModelForm()
  const router = useRouter()
  const isEdit = Boolean(model)
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(model ? chatModelFormFromRow(model) : emptyChatModelState())
      setServerError(null)
    }
  }, [open, model, form])

  async function onSubmit(values: ReturnType<typeof emptyChatModelState>) {
    if (!isEdit && !values.apiKey.trim()) {
      form.setError("apiKey", { message: "请输入 API Key" })
      return
    }
    setServerError(null)
    const input = buildChatModelInput(values)
    const res = isEdit
      ? await updatePresetChatModelAction(model!.id, input)
      : await createPresetChatModelAction(input)
    if (res.ok) {
      toast.success(isEdit ? "平台对话模型已更新" : "平台对话模型已创建")
      setOpen(false)
      router.refresh()
    } else {
      setServerError(res.error ?? "操作失败")
    }
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
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ChatModelFields form={form} isEdit={isEdit} />
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "保存中…" : isEdit ? "保存" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
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
