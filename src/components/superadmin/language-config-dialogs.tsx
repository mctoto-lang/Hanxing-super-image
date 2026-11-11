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
import { languageConfigFormSchema } from "@/lib/forms/config-schemas"
import {
  createLanguageConfigAction,
  toggleLanguageConfigActiveAction,
  updateLanguageConfigAction,
} from "@/server/actions/platform-product-config"

/** 语言行（编辑回填用） */
export interface LanguageConfigRow {
  id: string
  key: string
  label: string
  outputName: string
  imageDirective: string | null
  sortOrder: number
  isActive: boolean
}

interface LanguageFormValues {
  key: string
  label: string
  outputName: string
  imageDirective?: string
}

function LanguageForm({
  row,
  onDone,
  open,
}: {
  row: LanguageConfigRow | null
  onDone: () => void
  /** 父级弹窗开合（open 时重置为行数据 defaults） */
  open: boolean
}) {
  const router = useRouter()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const defaults = React.useMemo<LanguageFormValues>(
    () => ({
      key: row?.key ?? "",
      label: row?.label ?? "",
      outputName: row?.outputName ?? "",
      imageDirective: row?.imageDirective ?? "",
    }),
    [row],
  )

  const form = useForm<LanguageFormValues>({
    resolver: standardSchemaResolver(languageConfigFormSchema),
    defaultValues: defaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(defaults)
      setServerError(null)
    }
  }, [open, form, defaults])

  async function onSubmit(values: LanguageFormValues) {
    setServerError(null)
    const base = {
      label: values.label,
      outputName: values.outputName,
      imageDirective: values.imageDirective || undefined,
    }
    const res = row
      ? await updateLanguageConfigAction(row.id, base)
      : await createLanguageConfigAction({ ...base, key: values.key })
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success(row ? "语言已更新" : "语言已创建")
    onDone()
    router.refresh()
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="key"
            render={({ field }) => (
              <FormItem>
                <FormLabel>语言标识（key）</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="en" disabled={Boolean(row)} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>显示名称</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="English" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="outputName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>输出语言名</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="English（喂给 AI 的语言名）" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="imageDirective"
          render={({ field }) => (
            <FormItem>
              <FormLabel>图内文字指令</FormLabel>
              <FormControl>
                <Textarea
                  rows={2}
                  placeholder="All text overlay in the image must be in English. "
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                注入生图 prompt 的图内文字语言指令；留空则不注入
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

/** 新增语言 */
export function LanguageFormDialog() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增语言
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>新增语言</DialogTitle>
          <DialogDescription>商品图片生图文字语言与 AI 帮写输出语言配置</DialogDescription>
          <LanguageForm row={null} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑语言 */
export function LanguageEditButton({ row }: { row: LanguageConfigRow }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>编辑语言：{row.label}</DialogTitle>
          <DialogDescription>key: {row.key}</DialogDescription>
          <LanguageForm row={row} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用语言 */
export function LanguageToggleActiveButton({
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
          const res = await toggleLanguageConfigActiveAction(id)
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
