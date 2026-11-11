"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power } from "lucide-react"
import { toast } from "sonner"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { sizeSpecFormSchema } from "@/lib/forms/config-schemas"
import {
  createSizeSpecAction,
  toggleSizeSpecActiveAction,
  updateSizeSpecAction,
} from "@/server/actions/platform-product"
import { PLATFORMS, PRODUCT_MODE_LABELS } from "@/lib/product/dictionaries"

export interface SizeSpecRow {
  id: string
  platformKey: string
  label: string
  width: number
  height: number
  ratioLabel: string | null
  note: string | null
  appliesTo: string[]
  sortOrder: number
  isActive: boolean
}

type SizeSpecScope = "suite" | "detail"

interface SizeSpecFormValues {
  platformKey: string
  label: string
  width: number
  height: number
  ratioLabel?: string
  note?: string
  appliesTo: SizeSpecScope[]
}

function SizeSpecForm({
  row,
  onDone,
  open,
}: {
  row: SizeSpecRow | null
  onDone: () => void
  /** 父级弹窗开合（open 时重置为行数据 defaults） */
  open: boolean
}) {
  const router = useRouter()
  const [serverError, setServerError] = React.useState<string | null>(null)

  const defaults = React.useMemo<SizeSpecFormValues>(
    () => ({
      platformKey: row?.platformKey ?? "amazon",
      label: row?.label ?? "",
      width: row?.width ?? 970,
      height: row?.height ?? 600,
      ratioLabel: row?.ratioLabel ?? "",
      note: row?.note ?? "",
      appliesTo: (row?.appliesTo as SizeSpecScope[]) ?? ["detail"],
    }),
    [row],
  )

  const form = useForm<SizeSpecFormValues>({
    resolver: standardSchemaResolver(sizeSpecFormSchema),
    defaultValues: defaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(defaults)
      setServerError(null)
    }
  }, [open, form, defaults])

  async function onSubmit(values: SizeSpecFormValues) {
    setServerError(null)
    const base = {
      platformKey: values.platformKey,
      label: values.label,
      width: values.width,
      height: values.height,
      ratioLabel: values.ratioLabel || undefined,
      note: values.note || undefined,
      appliesTo: values.appliesTo,
    }
    const res = row
      ? await updateSizeSpecAction(row.id, base)
      : await createSizeSpecAction(base)
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success(row ? "规范已更新" : "规范已创建")
    onDone()
    router.refresh()
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="platformKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>平台</FormLabel>
                <Select value={field.value} onValueChange={(v) => field.onChange(v ?? "amazon")} items={PLATFORMS}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {PLATFORMS.find((p) => p.value === field.value)?.label ??
                          field.value}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {PLATFORMS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>尺寸名称</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="高级A+（Web端）" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="width"
            render={({ field }) => (
              <FormItem>
                <FormLabel>宽（px）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={64}
                    max={8192}
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(
                        e.target.value === "" ? undefined : Number(e.target.value),
                      )
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="height"
            render={({ field }) => (
              <FormItem>
                <FormLabel>高（px）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={64}
                    max={8192}
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(
                        e.target.value === "" ? undefined : Number(e.target.value),
                      )
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ratioLabel"
            render={({ field }) => (
              <FormItem>
                <FormLabel>比例文案</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="长图 / 4:3" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="note"
          render={({ field }) => (
            <FormItem>
              <FormLabel>规范说明</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="Premium A+ 桌面端全宽模块（1464px 宽）"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="appliesTo"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-3">
                  <FormLabel>适用子功能</FormLabel>
                  {(["suite", "detail"] as const).map((s) => (
                    <label key={s} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={field.value.includes(s)}
                        onCheckedChange={(v) =>
                          field.onChange(
                            v
                              ? [...field.value, s]
                              : field.value.filter((x) => x !== s),
                          )
                        }
                      />
                      {PRODUCT_MODE_LABELS[s]}
                    </label>
                  ))}
                </div>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverError ? (
          <p className="text-sm text-destructive">{serverError}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            取消
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && <MorphingInfinity className="mr-1 size-4" />}
            {pending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

/** 新增尺寸规范 */
export function SizeSpecFormDialog() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增规范
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>新增尺寸规范</DialogTitle>
          <DialogDescription>
            平台有具体尺寸规范的场景（如 Amazon A+ 模块尺寸）
          </DialogDescription>
          <SizeSpecForm row={null} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑尺寸规范 */
export function SizeSpecEditButton({ row }: { row: SizeSpecRow }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>编辑规范：{row.label}</DialogTitle>
          <DialogDescription>平台：{row.platformKey}</DialogDescription>
          <SizeSpecForm row={row} open={open} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用 */
export function SizeSpecToggleActiveButton({
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
          const res = await toggleSizeSpecActiveAction(id)
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
