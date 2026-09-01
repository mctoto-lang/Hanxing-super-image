"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { TemplateVarChips } from "@/components/superadmin/template-var-chips"
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

function DirectionForm({
  row,
  onDone,
  defaultScope,
  variant = "product",
}: {
  row: DirectionRow | null
  onDone: () => void
  /** 新增时预选的二级分类（取所在 tab；单选，可改） */
  defaultScope?: ProductDirectionScope
  /** 配置中心归属（weartry 时作用域固定、不显示商品专属的平台/主图类控件） */
  variant?: DirectionConfigVariant
}) {
  const conf = VARIANT_CONF[variant]
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [name, setName] = useState(row?.name ?? "")
  const [description, setDescription] = useState(row?.description ?? "")
  const [promptTemplate, setPromptTemplate] = useState(row?.promptTemplate ?? "")
  const [scope, setScope] = useState<ProductDirectionScope>(
    (row?.appliesTo?.[0] as ProductDirectionScope) ??
      defaultScope ??
      conf.scopes[0]!,
  )
  const [supportsCount, setSupportsCount] = useState(row?.supportsCount ?? false)
  const [maxCount, setMaxCount] = useState(row?.maxCount ?? 1)
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 99)
  const [isHidden, setIsHidden] = useState(row?.isHidden ?? false)
  const [isHero, setIsHero] = useState(row?.isHero ?? false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        name,
        description: description || undefined,
        promptTemplate,
        scope,
        supportsCount,
        maxCount,
        sortOrder,
        isHidden,
        isHero,
      }
      const res = row
        ? await updateDirectionAction(row.id, base)
        : await createDirectionAction(base)
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(
        row ? "方向已更新" : "方向已创建（key 按名称拼音自动生成）",
      )
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>方向名称</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="白底图" />
      </div>
      <div className="space-y-1.5">
        <Label>描述（卡片副文案）</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="纯白背景主图，平台核心展示位"
        />
      </div>
      {variant === "product" && (
        <div className="space-y-1.5">
          <Label>方向类别</Label>
          <Select
            value={isHero ? "hero" : "normal"}
            onValueChange={(v) => setIsHero(v === "hero")}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{isHero ? HERO_LABEL : NORMAL_LABEL}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">{NORMAL_LABEL}</SelectItem>
              <SelectItem value="hero">{HERO_LABEL}</SelectItem>
            </SelectContent>
          </Select>
          {isHero && (
            <p className="text-xs text-primary">
              生图时将自动注入所选平台的主图规范（如 Amazon：纯白背景、商品占比
              85%+、无水印与道具）
            </p>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        <Label>提示词模板</Label>
        <Textarea
          ref={textareaRef}
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          rows={5}
          placeholder={'纯白背景电商主图：{{productName}} 完整居中呈现… 变量芯片点击插入'}
        />
        <TemplateVarChips
          vars={conf.vars}
          template={promptTemplate}
          textareaRef={textareaRef}
          onTemplateChange={setPromptTemplate}
        />
        <p className="text-xs text-muted-foreground">
          {variant === "weartry"
            ? "模板即服装组图最终生图 prompt：未引用的变量不注入（严格模式）；可用变量见上方芯片"
            : "模板即最终生图 prompt：未引用的变量不注入（严格模式），补充要求需引用 {{additionalPrompt}} 才生效；{{platformSegment}} 为主图类自动含平台主图规范，{{platformGeneralSegment}}/{{platformHeroSegment}} 为原始字段值"}
        </p>
      </div>
      {conf.scopes.length > 1 && (
        <div className="space-y-1.5">
          <Label>二级分类（适用子功能）</Label>
          <Select
            value={scope}
            onValueChange={(v) => setScope(v as ProductDirectionScope)}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{conf.scopeLabel(scope)}</SelectValue>
            </SelectTrigger>
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
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={supportsCount}
            onCheckedChange={(v) => setSupportsCount(Boolean(v))}
          />
          支持数量调节
        </label>
        <div className="space-y-1.5">
          <Label>数量上限</Label>
          <Input
            type="number"
            min={1}
            max={4}
            value={maxCount}
            onChange={(e) => setMaxCount(Number(e.target.value) || 1)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>排序</Label>
          <Input
            type="number"
            min={0}
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={isHidden}
            onCheckedChange={(v) => setIsHidden(Boolean(v))}
          />
          前端隐藏
        </label>
        <p className="text-xs text-muted-foreground">
          隐藏后不出现在套图「自定义配置」手动列表；智能匹配与「其他」AI 补充仍可选中该方向
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button onClick={submit} disabled={submitting}>
          {submitting && <MorphingInfinity className="mr-1 size-4" />}
          保存
        </Button>
      </div>
    </div>
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
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          <DirectionForm
            row={null}
            onDone={() => setOpen(false)}
            defaultScope={defaultScope}
            variant={variant}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑方向 */
export function DirectionEditButton({
  row,
  variant = "product",
}: {
  row: DirectionRow
  variant?: DirectionConfigVariant
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>编辑方向：{row.name}</DialogTitle>
          <DialogDescription>
            key: {row.key}
            {variant === "product" && row.isHero
              ? " · 白底图类（生图注入平台主图规范）"
              : ""}
          </DialogDescription>
          <DirectionForm
            row={row}
            onDone={() => setOpen(false)}
            variant={variant}
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
  const [loading, setLoading] = useState(false)
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
