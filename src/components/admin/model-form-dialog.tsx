"use client"

import * as React from "react"
import { Plus, Pencil } from "lucide-react"
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
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm, type Resolver } from "react-hook-form"
import { modelFormSchema, type ModelFormValues } from "@/lib/forms/model-schemas"
import {
  createModelAction,
  updateModelAction,
  toggleModelActiveAction,
} from "@/server/actions/admin-models"
import {
  ImageModelFields,
  buildModelSubmitInput,
  emptyModelState,
  fromModelToForm,
  type ImageModelFormRow,
} from "@/components/model-form/image-model-fields"

/** 列表项类型（与 listModelsAction 返回一致；表单回填字段共享 ImageModelFormRow） */
export type ModelRow = ImageModelFormRow & { enterpriseId: string | null }

/**
 * 企业私有生图模型 新建/编辑弹窗（薄壳：字段渲染与提交组装全部复用
 * @/components/model-form/image-model-fields，本文件只持有 Dialog 外壳、
 * 表单实例与企业侧 action 调用）。
 *
 * 统一设计语言（范式：recharge-dialog）：useForm + standardSchemaResolver
 * （client-safe zod 镜像 @/lib/forms/model-schemas）→ 字段级内联校验；
 * 成功才 toast，服务端兜底错误统一显示在 footer 上方一条。
 */
export function ModelFormDialog({
  model,
  trigger,
}: {
  model?: ModelRow
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()
  const isEdit = Boolean(model)

  // raw: true —— 校验走 schema，但提交回调拿原始表单值（apiKey 不在 schema 的
  // 输入类型内，由 ModelFormValues 单独声明；故此处对 resolver 做类型桥接）
  const form = useForm<ModelFormValues>({
    resolver: standardSchemaResolver(modelFormSchema, undefined, {
      raw: true,
    }) as unknown as Resolver<ModelFormValues>,
    defaultValues: model ? fromModelToForm(model) : emptyModelState(),
  })
  const pending = form.formState.isSubmitting

  // 每次打开时重置表单
  React.useEffect(() => {
    if (open) {
      form.reset(model ? fromModelToForm(model) : emptyModelState())
      setServerError(null)
    }
  }, [open, model, form])

  async function onSubmit(values: ModelFormValues) {
    setServerError(null)

    // apiKey 不进 schema：创建必填、编辑留空=不修改（保持原行为，错误落字段）
    if (!isEdit && !values.apiKey) {
      form.setError("apiKey", { message: "请输入 API Key" })
      return
    }

    const input = buildModelSubmitInput(values)
    const res = isEdit
      ? await updateModelAction(model!.id, input)
      : await createModelAction(input)
    if (res.ok) {
      toast.success(isEdit ? "模型已更新" : "模型已创建")
      setOpen(false)
      router.refresh()
    } else {
      // 服务端兜底错误（业务错误）：统一条内联展示，不再 toast
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
              {isEdit ? "编辑" : "新建模型"}
            </Button>
          )
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑模型" : "新建模型"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ImageModelFields
              form={form}
              scope="enterprise"
              isEdit={isEdit}
              modelId={model?.id}
            />
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

/** 表格行内的编辑触发按钮（受控打开） */
export function ModelEditButton({ model }: { model: ModelRow }) {
  return (
    <ModelFormDialog
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

/** 启停按钮（仅企业私有模型可用，平台生图模型由父组件控制不渲染） */
export function ModelToggleActiveButton({ model }: { model: ModelRow }) {
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const res = await toggleModelActiveAction(model.id, !model.isActive)
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
