"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
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

function LanguageForm({
  row,
  onDone,
}: {
  row: LanguageConfigRow | null
  onDone: () => void
}) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [key, setKey] = useState(row?.key ?? "")
  const [label, setLabel] = useState(row?.label ?? "")
  const [outputName, setOutputName] = useState(row?.outputName ?? "")
  const [imageDirective, setImageDirective] = useState(row?.imageDirective ?? "")
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 99)

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        label,
        outputName,
        imageDirective: imageDirective || undefined,
        sortOrder,
      }
      const res = row
        ? await updateLanguageConfigAction(row.id, base)
        : await createLanguageConfigAction({ ...base, key })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(row ? "语言已更新" : "语言已创建")
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>语言标识（key）</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="en"
            disabled={Boolean(row)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>显示名称</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="English" />
        </div>
        <div className="space-y-1.5">
          <Label>输出语言名</Label>
          <Input
            value={outputName}
            onChange={(e) => setOutputName(e.target.value)}
            placeholder="English（喂给 AI 的语言名）"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>图内文字指令</Label>
        <Textarea
          value={imageDirective}
          onChange={(e) => setImageDirective(e.target.value)}
          rows={2}
          placeholder="All text overlay in the image must be in English. "
        />
        <p className="text-xs text-muted-foreground">
          注入生图 prompt 的图内文字语言指令；留空则不注入
        </p>
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

/** 新增语言 */
export function LanguageFormDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增语言
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新增语言</DialogTitle>
          <DialogDescription>商品图片生图文字语言与 AI 帮写输出语言配置</DialogDescription>
          <LanguageForm row={null} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑语言 */
export function LanguageEditButton({ row }: { row: LanguageConfigRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>编辑语言：{row.label}</DialogTitle>
          <DialogDescription>key: {row.key}</DialogDescription>
          <LanguageForm row={row} onDone={() => setOpen(false)} />
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
  const [loading, setLoading] = useState(false)
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
