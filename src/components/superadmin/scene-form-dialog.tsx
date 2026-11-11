"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power } from "lucide-react"
import { toast } from "sonner"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm } from "react-hook-form"
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { TemplateVarChips } from "@/components/superadmin/template-var-chips"
import { sceneFormSchema } from "@/lib/forms/config-schemas"
import {
  createWeartrySceneAction,
  toggleWeartrySceneActiveAction,
  updateWeartrySceneAction,
} from "@/server/actions/platform-weartry"
import { WEARTRY_SCENE_TEMPLATE_VARS_FOR_SCENE } from "@/lib/weartry/prompt-vars"

/** 场景行（编辑回填用） */
export interface SceneRow {
  id: string
  key: string
  name: string
  description: string | null
  promptTemplate: string
  sortOrder: number
  isActive: boolean
}

interface SceneFormValues {
  name: string
  description?: string
  promptTemplate: string
}

function SceneForm({
  row,
  onDone,
  open,
}: {
  row: SceneRow | null
  onDone: () => void
  /** 父级弹窗开合（open 时重置为行数据 defaults） */
  open: boolean
}) {
  const router = useRouter()
  const [serverError, setServerError] = React.useState<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  const defaults = React.useMemo<SceneFormValues>(
    () => ({
      name: row?.name ?? "",
      description: row?.description ?? "",
      promptTemplate: row?.promptTemplate ?? "",
    }),
    [row],
  )

  const form = useForm<SceneFormValues>({
    resolver: standardSchemaResolver(sceneFormSchema),
    defaultValues: defaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(defaults)
      setServerError(null)
    }
  }, [open, form, defaults])

  async function onSubmit(values: SceneFormValues) {
    setServerError(null)
    const base = {
      name: values.name,
      description: values.description || undefined,
      promptTemplate: values.promptTemplate,
    }
    const res = row
      ? await updateWeartrySceneAction(row.id, base)
      : await createWeartrySceneAction(base)
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success(row ? "场景已更新" : "场景已创建（key 按名称拼音自动生成）")
    onDone()
    router.refresh()
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>场景名称</FormLabel>
              <FormControl>
                <Input {...field} placeholder="城市街拍" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>描述（下拉副文案）</FormLabel>
              <FormControl>
                <Input {...field} placeholder="街头自然光，行走抓拍氛围" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="promptTemplate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>注入提示词模板</FormLabel>
              <FormControl>
                <Textarea
                  rows={5}
                  placeholder={
                    "城市街头场景：自然街景背景（{{sceneName}}），午后侧光，浅景深……模板经 {{sceneSegment}} 注入穿戴生图提示词"
                  }
                  ref={(el: HTMLTextAreaElement | null) => {
                    textareaRef.current = el
                    field.ref(el)
                  }}
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              </FormControl>
              <TemplateVarChips
                vars={WEARTRY_SCENE_TEMPLATE_VARS_FOR_SCENE}
                template={field.value}
                textareaRef={textareaRef}
                onTemplateChange={(next) => field.onChange(next)}
              />
              <p className="text-xs text-muted-foreground">
                模板填充后作为 {"{{sceneSegment}}"} 注入「模特穿戴 ·
                穿戴生图」模板；未被引用的变量不注入（严格模式）
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError ? (
          <p className="text-sm text-destructive">{serverError}</p>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && <MorphingInfinity className="mr-1 size-4" />}
            {pending ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </Form>
  )
}

/** 新增场景 */
export function SceneFormDialog() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增场景
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>新增场景</DialogTitle>
          <DialogDescription>
            场景供模特穿戴 tab 的「场景选择」下拉使用，选定后注入生图提示词
          </DialogDescription>
          <SceneForm row={null} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑场景 */
export function SceneEditButton({ row }: { row: SceneRow }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>编辑场景：{row.name}</DialogTitle>
          <DialogDescription>key: {row.key}</DialogDescription>
          <SceneForm row={row} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用场景 */
export function SceneToggleActiveButton({
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
          const res = await toggleWeartrySceneActiveAction(id)
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
