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
import { Checkbox } from "@/components/ui/checkbox"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { directionFormSchema } from "@/lib/forms/config-schemas"
import {
  createDirectionAction,
  toggleDirectionActiveAction,
  updateDirectionAction,
} from "@/server/actions/platform-product"
import { PRODUCT_MODE_LABELS } from "@/lib/product/dictionaries"
import {
  DIRECTION_TEMPLATE_VARS,
  type TemplateVarDef,
} from "@/lib/product/prompt-vars"
import { OUTFIT_DIRECTION_VARS } from "@/lib/weartry/prompt-vars"
import { WEARTRY_MODE_LABELS } from "@/lib/weartry/dictionaries"
import type { ProductDirectionScope } from "@/db/schema"

/** 配置中心归属：商品图片 / 穿戴图片（作用域与变量集按端隔离，互不可见） */
export type DirectionConfigVariant = "product" | "weartry"

/** 方向行（编辑回填用） */
export interface DirectionRow {
  id: string
  key: string
  name: string
  description: string | null
  promptTemplate: string
  appliesTo: string[]
  supportsCount: boolean
  maxCount: number
  sortOrder: number
  isActive: boolean
  isHidden: boolean
  isHero?: boolean
}

const HERO_LABEL = "白底图类（主图）"
const NORMAL_LABEL = "普通方向"

/** 端 → 可选作用域 / 变量集 / 作用域展示名 */
const VARIANT_CONF: Record<
  DirectionConfigVariant,
  {
    scopes: ProductDirectionScope[]
    vars: TemplateVarDef[]
    scopeLabel: (scope: ProductDirectionScope) => string
  }
> = {
  product: {
    scopes: ["suite", "detail", "refine"],
    vars: DIRECTION_TEMPLATE_VARS,
    scopeLabel: (s) => PRODUCT_MODE_LABELS[s as "suite" | "detail" | "refine"],
  },
  weartry: {
    scopes: ["weartry"],
    vars: OUTFIT_DIRECTION_VARS,
    scopeLabel: () => WEARTRY_MODE_LABELS.outfit,
  },
}

interface DirectionFormValues {
  name: string
  description?: string
  promptTemplate: string
  scope: ProductDirectionScope
  supportsCount: boolean
  maxCount: number
  isHidden: boolean
  isHero: boolean
}

function DirectionForm({
  row,
  onDone,
  open,
  defaultScope,
  variant = "product",
  promptOnly = false,
}: {
  row: DirectionRow | null
  onDone: () => void
  /** 父级弹窗开合（open 时重置为行数据 defaults） */
  open: boolean
  /** 新增时预选的二级分类（取所在 tab；单选，可改） */
  defaultScope?: ProductDirectionScope
  /** 配置中心归属（weartry 时作用域固定、不显示商品专属的平台/主图类控件） */
  variant?: DirectionConfigVariant
  /** 固定项模式（产品精修快捷优化项）：名称等均锁定，仅可编辑提示词模板 */
  promptOnly?: boolean
}) {
  const conf = VARIANT_CONF[variant]
  const router = useRouter()
  const [serverError, setServerError] = React.useState<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  const defaults = React.useMemo<DirectionFormValues>(
    () => ({
      name: row?.name ?? "",
      description: row?.description ?? "",
      promptTemplate: row?.promptTemplate ?? "",
      scope:
        (row?.appliesTo?.[0] as ProductDirectionScope) ??
        defaultScope ??
        conf.scopes[0]!,
      supportsCount: row?.supportsCount ?? false,
      maxCount: row?.maxCount ?? 1,
      isHidden: row?.isHidden ?? false,
      isHero: row?.isHero ?? false,
    }),
    [row, defaultScope, conf],
  )

  const form = useForm<DirectionFormValues>({
    resolver: standardSchemaResolver(directionFormSchema),
    defaultValues: defaults,
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset(defaults)
      setServerError(null)
    }
  }, [open, form, defaults])

  async function onSubmit(values: DirectionFormValues) {
    setServerError(null)
    let res: { ok: boolean; error: string | null }
    if (row && promptOnly) {
      res = await updateDirectionAction(row.id, {
        promptTemplate: values.promptTemplate,
      })
    } else {
      const base = {
        name: values.name,
        description: values.description || undefined,
        promptTemplate: values.promptTemplate,
        scope: values.scope,
        supportsCount: values.supportsCount,
        maxCount: values.maxCount,
        isHidden: values.isHidden,
        isHero: values.isHero,
      }
      res = row
        ? await updateDirectionAction(row.id, base)
        : await createDirectionAction(base)
    }
    if (!res.ok) {
      setServerError(res.error ?? "保存失败")
      return
    }
    toast.success(
      row
        ? promptOnly
          ? "提示词模板已更新"
          : "方向已更新"
        : "方向已创建（key 按名称拼音自动生成）",
    )
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
              <FormLabel>方向名称</FormLabel>
              {promptOnly ? (
                <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                  {row?.name}
                </p>
              ) : (
                <FormControl>
                  <Input {...field} placeholder="白底图" />
                </FormControl>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>描述（卡片副文案）</FormLabel>
              {promptOnly ? (
                <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                  {row?.description || "—"}
                </p>
              ) : (
                <FormControl>
                  <Input
                    {...field}
                    placeholder="纯白背景主图，平台核心展示位"
                  />
                </FormControl>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
        {variant === "product" && !promptOnly && (
          <FormField
            control={form.control}
            name="isHero"
            render={({ field }) => (
              <FormItem>
                <FormLabel>方向类别</FormLabel>
                <Select
                  value={field.value ? "hero" : "normal"}
                  onValueChange={(v) => field.onChange(v === "hero")}
                  items={[
                    { value: "normal", label: NORMAL_LABEL },
                    { value: "hero", label: HERO_LABEL },
                  ]}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {field.value ? HERO_LABEL : NORMAL_LABEL}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="normal">{NORMAL_LABEL}</SelectItem>
                    <SelectItem value="hero">{HERO_LABEL}</SelectItem>
                  </SelectContent>
                </Select>
                {field.value && (
                  <p className="text-xs text-primary">
                    生图时将自动注入所选平台的主图规范（如 Amazon：纯白背景、商品占比
                    85%+、无水印与道具）
                  </p>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={form.control}
          name="promptTemplate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>提示词模板</FormLabel>
              <FormControl>
                <Textarea
                  rows={5}
                  placeholder={
                    "纯白背景电商主图：{{productName}} 完整居中呈现… 变量芯片点击插入"
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
                vars={conf.vars}
                template={field.value}
                textareaRef={textareaRef}
                onTemplateChange={(next) => field.onChange(next)}
              />
              <p className="text-xs text-muted-foreground">
                {variant === "weartry"
                  ? "模板即服装组图最终生图 prompt：未引用的变量不注入（严格模式）；可用变量见上方芯片"
                  : "模板即最终生图 prompt：未引用的变量不注入（严格模式），补充要求需引用 {{additionalPrompt}} 才生效；{{platformSegment}} 为主图类自动含平台主图规范，{{platformGeneralSegment}}/{{platformHeroSegment}} 为原始字段值"}
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        {conf.scopes.length > 1 && !promptOnly && (
          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem>
                <FormLabel>二级分类（适用子功能）</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={(v) => field.onChange(v as ProductDirectionScope)}
                  items={conf.scopes.map((s) => ({
                    value: s,
                    label: conf.scopeLabel(s),
                  }))}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue>{conf.scopeLabel(field.value)}</SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {conf.scopes.map((s) => (
                      <SelectItem key={s} value={s}>
                        {conf.scopeLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  单选：每个方向只归属一个分类，三个分类的配置完全独立互不影响
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        {!promptOnly && (
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="supportsCount"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(Boolean(v))}
                    />
                  </FormControl>
                  <FormLabel className="text-sm font-normal">
                    支持数量调节
                  </FormLabel>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="maxCount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>数量上限</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={4}
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
          </div>
        )}
        {!promptOnly && (
          <FormField
            control={form.control}
            name="isHidden"
            render={({ field }) => (
              <FormItem className="gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(v) => field.onChange(Boolean(v))}
                    />
                  </FormControl>
                  前端隐藏
                </label>
                <p className="text-xs text-muted-foreground">
                  隐藏后不出现在套图「自定义配置」手动列表；智能匹配与「其他」AI 补充仍可选中该方向
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
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

/** 新增方向（defaultScope 为所在 tab 预选的二级分类，单选可改） */
export function DirectionFormDialog({
  defaultScope,
  variant = "product",
  triggerLabel = "新增方向",
  title = "新增方向",
  description = "方向池供商品套图 / A+详情页 / 产品精修选择",
}: {
  defaultScope?: ProductDirectionScope
  variant?: DirectionConfigVariant
  triggerLabel?: string
  title?: string
  description?: string
} = {}) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          <DirectionForm
            row={null}
            open={open}
            onDone={() => setOpen(false)}
            defaultScope={defaultScope}
            variant={variant}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑方向（产品精修固定项自动进入 promptOnly 模式：仅可改提示词模板） */
export function DirectionEditButton({
  row,
  variant = "product",
}: {
  row: DirectionRow
  variant?: DirectionConfigVariant
}) {
  const [open, setOpen] = React.useState(false)
  const promptOnly =
    variant === "product" && (row.appliesTo ?? []).includes("refine")
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogTitle>编辑方向：{row.name}</DialogTitle>
          <DialogDescription>
            {promptOnly
              ? "快捷优化项固定，仅可修改使用的提示词模板"
              : `key: ${row.key}${
                  variant === "product" && row.isHero
                    ? " · 白底图类（生图注入平台主图规范）"
                    : ""
                }`}
          </DialogDescription>
          <DirectionForm
            row={row}
            open={open}
            onDone={() => setOpen(false)}
            variant={variant}
            promptOnly={promptOnly}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用方向 */
export function DirectionToggleActiveButton({
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
          const res = await toggleDirectionActiveAction(id)
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
