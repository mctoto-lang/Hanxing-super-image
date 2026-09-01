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

function PlatformForm({
  row,
  onDone,
}: {
  row: PlatformConfigRow | null
  onDone: () => void
}) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [key, setKey] = useState(row?.key ?? "")
  const [label, setLabel] = useState(row?.label ?? "")
  const [heroPromptSegment, setHeroPromptSegment] = useState(row?.heroPromptSegment ?? "")
  const [generalPromptSegment, setGeneralPromptSegment] = useState(
    row?.generalPromptSegment ?? "",
  )
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 99)

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        label,
        heroPromptSegment: heroPromptSegment || undefined,
        generalPromptSegment: generalPromptSegment || undefined,
        sortOrder,
      }
      const res = row
        ? await updatePlatformConfigAction(row.id, base)
        : await createPlatformConfigAction({ ...base, key })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(row ? "平台已更新" : "平台已创建")
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>平台标识（key）</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="amazon"
            disabled={Boolean(row)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>平台名称</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="亚马逊" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>主图规范提示词（注入白底图/主视觉类）</Label>
        <Textarea
          value={heroPromptSegment}
          onChange={(e) => setHeroPromptSegment(e.target.value)}
          rows={3}
          placeholder="Amazon main image rules: pure white background (#FFFFFF), ..."
        />
        <p className="text-xs text-muted-foreground">
          英文提示词片段，注入「白底图（首屏主视觉）」类生图 prompt；留空则不注入
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>通用平台偏好提示词（注入全部方向）</Label>
        <Textarea
          value={generalPromptSegment}
          onChange={(e) => setGeneralPromptSegment(e.target.value)}
          rows={3}
          placeholder="Follow Amazon A+ content visual guidelines: ..."
        />
        <p className="text-xs text-muted-foreground">
          注入所有生图 prompt 的平台风格偏好；留空则不注入
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

/** 新增平台 */
export function PlatformFormDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增平台
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新增上架平台</DialogTitle>
          <DialogDescription>商品图片各子功能共用的平台上架规则配置</DialogDescription>
          <PlatformForm row={null} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑平台 */
export function PlatformEditButton({ row }: { row: PlatformConfigRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>编辑平台：{row.label}</DialogTitle>
          <DialogDescription>key: {row.key}</DialogDescription>
          <PlatformForm row={row} onDone={() => setOpen(false)} />
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
  const [loading, setLoading] = useState(false)
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
