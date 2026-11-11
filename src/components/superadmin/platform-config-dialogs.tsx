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
import { platformConfigFormSchema } from "@/lib/forms/config-schemas"
import {
  createPlatformConfigAction,
  togglePlatformConfigActiveAction,
  updatePlatformConfigAction,
} from "@/server/actions/platform-product-config"

/** 上架平台行（编辑回填用） */
export interface PlatformConfigRow {
  id: string
  key: string
  label: string
  heroPromptSegment: string | null
  generalPromptSegment: string | null
  sortOrder: number
  isActive: boolean
}

interface PlatformFormValues {
  key: string
  label: string
  heroPromptSegment?: string
  generalPromptSegment?: string
}

function PlatformForm({
  row,
  onDone,
  open,
}: {
  row: PlatformConfigRow | null
  onDone: () => void
  /** 父级弹窗开合（open 时重置为行数据 defaults） */
  open: boolean
}) {
  const router = useRouter()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const defaults = React.useMemo<PlatformFormValues>(
    () => ({
      key: row?.key ?? "",
      label: row?.label ?? "",
      heroPromptSegment: row?.heroPromptSegment ?? "",
      generalPromptSegment: row?.generalPromptSegment ?? "",
    }),
    [row],
  )

  const form = useForm<PlatformFormValues>({
    resolver: standardSchemaResolver(platformConfigFormSchema),
    defaultValues: defaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(defaults)
      setServerError(null)
    }
  }, [open, form, defaults])

  async function onSubmit(values: PlatformFormValues) {
    setServerError(null)
    const base = {
      label: values.label,
      heroPromptSegment: values.heroPromptSegment || undefined,
      generalPromptSegment: values.generalPromptSegment || undefined,
    }
    const res = row
      ? await updatePlatformConfigAction(row.id, base)
      : await createPlatformConfigAction({ ...base, key: values.key })
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success(row ? "平台已更新" : "平台已创建")
    onDone()
    router.refresh()
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="key"
            render={({ field }) => (
              <FormItem>
                <FormLabel>平台标识（key）</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="amazon" disabled={Boolean(row)} />
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
                <FormLabel>平台名称</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="亚马逊" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="heroPromptSegment"
          render={({ field }) => (
            <FormItem>
              <FormLabel>主图规范提示词（注入白底图/主视觉类）</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="Amazon main image rules: pure white background (#FFFFFF), ..."
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                英文提示词片段，注入「白底图（首屏主视觉）」类生图 prompt；留空则不注入
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="generalPromptSegment"
          render={({ field }) => (
            <FormItem>
              <FormLabel>通用平台偏好提示词（注入全部方向）</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="Follow Amazon A+ content visual guidelines: ..."
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                注入所有生图 prompt 的平台风格偏好；留空则不注入
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

/** 新增平台 */
export function PlatformFormDialog() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增平台
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>新增上架平台</DialogTitle>
          <DialogDescription>商品图片各子功能共用的平台上架规则配置</DialogDescription>
          <PlatformForm row={null} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑平台 */
export function PlatformEditButton({ row }: { row: PlatformConfigRow }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>编辑平台：{row.label}</DialogTitle>
          <DialogDescription>key: {row.key}</DialogDescription>
          <PlatformForm row={row} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用平台 */
export function PlatformToggleActiveButton({
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
          const res = await togglePlatformConfigActiveAction(id)
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
