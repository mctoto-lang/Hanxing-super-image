"use client"

import { useRef, useState } from "react"
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
import { TemplateVarChips } from "@/components/superadmin/template-var-chips"
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

function SceneForm({
  row,
  onDone,
}: {
  row: SceneRow | null
  onDone: () => void
}) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [name, setName] = useState(row?.name ?? "")
  const [description, setDescription] = useState(row?.description ?? "")
  const [promptTemplate, setPromptTemplate] = useState(
    row?.promptTemplate ?? "",
  )
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 99)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        name,
        description: description || undefined,
        promptTemplate,
        sortOrder,
      }
      const res = row
        ? await updateWeartrySceneAction(row.id, base)
        : await createWeartrySceneAction(base)
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(row ? "场景已更新" : "场景已创建（key 按名称拼音自动生成）")
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>场景名称</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="城市街拍"
        />
      </div>
      <div className="space-y-1.5">
        <Label>描述（下拉副文案）</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="街头自然光，行走抓拍氛围"
        />
      </div>
      <div className="space-y-1.5">
        <Label>注入提示词模板</Label>
        <Textarea
          ref={textareaRef}
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          rows={5}
          placeholder={
            "城市街头场景：自然街景背景（{{sceneName}}），午后侧光，浅景深……模板经 {{sceneSegment}} 注入穿戴生图提示词"
          }
        />
        <TemplateVarChips
          vars={WEARTRY_SCENE_TEMPLATE_VARS_FOR_SCENE}
          template={promptTemplate}
          textareaRef={textareaRef}
          onTemplateChange={setPromptTemplate}
        />
        <p className="text-xs text-muted-foreground">
          模板填充后作为 {"{{sceneSegment}}"} 注入「模特穿戴 ·
          穿戴生图」模板；未被引用的变量不注入（严格模式）
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

/** 新增场景 */
export function SceneFormDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新增场景
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新增场景</DialogTitle>
          <DialogDescription>
            场景供模特穿戴 tab 的「场景选择」下拉使用，选定后注入生图提示词
          </DialogDescription>
          <SceneForm row={null} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑场景 */
export function SceneEditButton({ row }: { row: SceneRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>编辑场景：{row.name}</DialogTitle>
          <DialogDescription>key: {row.key}</DialogDescription>
          <SceneForm row={row} onDone={() => setOpen(false)} />
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
  const [loading, setLoading] = useState(false)
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
