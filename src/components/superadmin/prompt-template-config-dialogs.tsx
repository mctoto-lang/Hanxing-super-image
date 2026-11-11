"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm, useWatch } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { TemplateVarChips } from "@/components/superadmin/template-var-chips"
import { promptTemplateFormSchema } from "@/lib/forms/config-schemas"
import {
  createPromptTemplateConfigAction,
  togglePromptTemplateConfigActiveAction,
  updatePromptTemplateConfigAction,
} from "@/server/actions/platform-product-config"
import { PRODUCT_PROMPT_SCENES } from "@/db/schema"
import { SCENE_TEMPLATE_VARS, type TemplateVarDef } from "@/lib/product/prompt-vars"
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_SCENE_LABELS,
  PROMPT_SCENE_NOTES,
} from "@/lib/product/prompt-defaults"
import {
  PRODUCT_ONLY_PROMPT_SCENES,
  WEARTRY_DEFAULT_PROMPT_TEMPLATES,
  WEARTRY_PROMPT_SCENE_LABELS,
  WEARTRY_PROMPT_SCENE_NOTES,
  WEARTRY_PROMPT_SCENES,
} from "@/lib/weartry/prompt-defaults"
import {
  MOCKUP_DEFAULT_PROMPT_TEMPLATES,
  MOCKUP_PROMPT_SCENE_LABELS,
  MOCKUP_PROMPT_SCENE_NOTES,
  MOCKUP_PROMPT_SCENES,
} from "@/lib/mockup/prompt-defaults"
import { WEARTRY_SCENE_TEMPLATE_VARS } from "@/lib/weartry/prompt-vars"

/** 配置中心归属：商品图片 / 穿戴图片 / 样机渲染（场景清单与默认值按端隔离，互不可见） */
export type PromptConfigVariant = "product" | "weartry" | "mockup"

/** 按端取场景清单 / 标签 / 默认模板 / 说明 / 变量注册表 */
function getVariantMaps(variant: PromptConfigVariant) {
  if (variant === "weartry") {
    return {
      scenes: WEARTRY_PROMPT_SCENES,
      labels: WEARTRY_PROMPT_SCENE_LABELS,
      defaults: WEARTRY_DEFAULT_PROMPT_TEMPLATES,
      notes: WEARTRY_PROMPT_SCENE_NOTES,
      vars: WEARTRY_SCENE_TEMPLATE_VARS,
    }
  }
  if (variant === "mockup") {
    return {
      scenes: MOCKUP_PROMPT_SCENES,
      labels: MOCKUP_PROMPT_SCENE_LABELS,
      defaults: MOCKUP_DEFAULT_PROMPT_TEMPLATES,
      notes: MOCKUP_PROMPT_SCENE_NOTES,
      vars: {} as Record<string, TemplateVarDef[]>,
    }
  }
  return {
    scenes: PRODUCT_ONLY_PROMPT_SCENES,
    labels: PROMPT_SCENE_LABELS,
    defaults: DEFAULT_PROMPT_TEMPLATES,
    notes: PROMPT_SCENE_NOTES,
    vars: SCENE_TEMPLATE_VARS,
  }
}

/** 提示词模板行（编辑回填用） */
export interface PromptTemplateConfigRow {
  id: string
  scene: string
  name: string
  template: string
  note: string | null
  sortOrder: number
  isActive: boolean
}

interface PromptTemplateFormValues {
  scene: string
  name: string
  template: string
  note?: string
}

/** 新增弹窗「未选择场景」占位项（onValueChange 映射回空串以触发必填校验） */
const SCENE_NONE = "__none__"
const SCENE_NONE_LABEL = "选择场景…"

function PromptTemplateForm({
  row,
  onDone,
  open,
  variant = "product",
}: {
  row: PromptTemplateConfigRow | null
  onDone: () => void
  /** 父级弹窗开合（open 时重置为行数据 defaults） */
  open: boolean
  variant?: PromptConfigVariant
}) {
  const maps = getVariantMaps(variant)
  const router = useRouter()
  const [serverError, setServerError] = React.useState<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  const defaults = React.useMemo<PromptTemplateFormValues>(
    () => ({
      scene: row?.scene ?? "",
      name: row?.name ?? "",
      template: row?.template ?? "",
      note: row?.note ?? "",
    }),
    [row],
  )

  const form = useForm<PromptTemplateFormValues>({
    resolver: standardSchemaResolver(promptTemplateFormSchema),
    defaultValues: defaults,
  })
  const pending = form.formState.isSubmitting
  // useWatch 替代 form.watch：后者返回不可安全 memoize 的函数，会使 React Compiler 跳过本组件记忆化
  const scene = useWatch({ control: form.control, name: "scene" })

  const sceneNote = scene ? row?.note || maps.notes[scene] || "" : ""
  const sceneVars = scene ? (maps.vars[scene] ?? []) : []
  const isCustomScene = row !== null

  React.useEffect(() => {
    if (open) {
      form.reset(defaults)
      setServerError(null)
    }
  }, [open, form, defaults])

  async function onSubmit(values: PromptTemplateFormValues) {
    setServerError(null)
    const base = {
      name: values.name,
      template: values.template,
      note: values.note || undefined,
    }
    const res = row
      ? await updatePromptTemplateConfigAction(row.id, base)
      : await createPromptTemplateConfigAction({
          ...base,
          scene: values.scene as (typeof PRODUCT_PROMPT_SCENES)[number],
        })
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success(row ? "模板已更新" : "模板已创建")
    onDone()
    router.refresh()
  }

  /** 恢复内置默认模板（seed 同源） */
  const resetToDefault = () => {
    if (scene && maps.defaults[scene]) {
      form.setValue("template", maps.defaults[scene]!, { shouldValidate: true })
      toast.info("已填入内置默认模板，保存后生效")
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="scene"
            render={({ field }) => (
              <FormItem>
                <FormLabel>场景（scene）</FormLabel>
                {isCustomScene ? (
                  <Input value={maps.labels[field.value] ?? field.value} disabled />
                ) : (
                  <Select
                    value={field.value || SCENE_NONE}
                    onValueChange={(v) => {
                      const next = v && v !== SCENE_NONE ? v : ""
                      field.onChange(next)
                      if (next) {
                        form.setValue("name", maps.labels[next] ?? next, {
                          shouldValidate: true,
                        })
                        if (maps.defaults[next]) {
                          form.setValue("template", maps.defaults[next]!, {
                            shouldValidate: true,
                          })
                        }
                      }
                    }}
                    items={[
                      { value: SCENE_NONE, label: SCENE_NONE_LABEL },
                      ...maps.scenes.map((s) => ({
                        value: s,
                        label: maps.labels[s] ?? s,
                      })),
                    ]}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {field.value
                            ? (maps.labels[field.value] ?? field.value)
                            : SCENE_NONE_LABEL}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={SCENE_NONE}>{SCENE_NONE_LABEL}</SelectItem>
                      {maps.scenes.map((s) => (
                        <SelectItem key={s} value={s}>
                          {maps.labels[s] ?? s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>模板名称</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="套图 AI 帮写" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="template"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>提示词模板</FormLabel>
                {scene && maps.defaults[scene] && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={resetToDefault}
                  >
                    <RotateCcw className="mr-1 size-3" />
                    恢复默认
                  </Button>
                )}
              </div>
              <FormControl>
                <Textarea
                  rows={10}
                  className="field-sizing-fixed font-mono text-xs"
                  placeholder="模板正文，支持 {{platformLabel}} 等变量；未引用的变量不注入"
                  ref={(el: HTMLTextAreaElement | null) => {
                    textareaRef.current = el
                    field.ref(el)
                  }}
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FormControl>
              <TemplateVarChips
                vars={sceneVars}
                template={field.value}
                textareaRef={textareaRef}
                onTemplateChange={(next) => field.onChange(next)}
              />
              <p className="text-xs text-muted-foreground">
                {sceneNote || "选择场景后显示可用变量说明"}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="note"
            render={({ field }) => (
              <FormItem>
                <FormLabel>变量说明（note）</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="留空使用内置说明" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        {serverError ? (
          <p className="text-sm text-destructive">{serverError}</p>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button type="submit" disabled={pending || !scene}>
            {pending && <MorphingInfinity className="mr-1 size-4" />}
            {pending ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </Form>
  )
}

/** 新增模板（补建缺失场景） */
export function PromptTemplateFormDialog({
  variant = "product",
}: {
  variant?: PromptConfigVariant
} = {}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增模板
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogTitle>新增提示词模板</DialogTitle>
          <DialogDescription>
            为缺失场景补建模板（内置默认已覆盖全部场景，通常只需编辑现有行）
          </DialogDescription>
          <PromptTemplateForm
            row={null}
            open={open}
            onDone={() => setOpen(false)}
            variant={variant}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑模板 */
export function PromptTemplateEditButton({
  row,
  variant = "product",
}: {
  row: PromptTemplateConfigRow
  variant?: PromptConfigVariant
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogTitle>编辑模板：{row.name}</DialogTitle>
          <DialogDescription>scene: {row.scene}</DialogDescription>
          <PromptTemplateForm
            row={row}
            open={open}
            onDone={() => setOpen(false)}
            variant={variant}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用模板（停用后运行时回退内置默认） */
export function PromptTemplateToggleActiveButton({
  id,
  isActive,
}: {
  id: string
  isActive: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = React.useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={loading}
      onClick={async () => {
        setLoading(true)
        try {
          const res = await togglePromptTemplateConfigActiveAction(id)
          if (!res.ok) {
            toast.error(res.error ?? "操作失败")
            return
          }
          router.refresh()
        } finally {
          setLoading(false)
        }
      }}
    >
      <Power className="mr-1 size-3.5" />
      {isActive ? "停用" : "启用"}
    </Button>
  )
}
