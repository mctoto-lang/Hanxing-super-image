"use client"

import * as React from "react"
import { useActionState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { createWorkspaceTaskAction } from "@/server/actions/workspace"

export function WorkspaceCreateDialog({
  templates,
}: {
  templates: { id: string; name: string }[]
}) {
  const [open, setOpen] = React.useState(false)
  const [cardCount, setCardCount] = React.useState(4)
  const [templateId, setTemplateId] = React.useState("")
  const router = useRouter()

  const [state, formAction, pending] = useActionState(
    async (_prev: unknown, formData: FormData) => {
      const res = await createWorkspaceTaskAction({
        theme: String(formData.get("theme") ?? ""),
        cardCount: Number(formData.get("cardCount") ?? 4),
        templateId: String(formData.get("templateId") ?? "") || undefined,
      })
      if (res.ok) {
        toast.success(`已裂变 ${res.cardCount} 张卡片`)
        setOpen(false)
        router.refresh()
        return null
      }
      toast.error(res.error ?? "创建失败")
      return { error: res.error }
    },
    null,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><Plus className="size-4" />新建任务</Button>} />
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>新建批量生图任务</DialogTitle>
          <DialogDescription>
            输入主题，AI 会裂变出多张卡片的提示词
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="theme">主题</Label>
            <Textarea
              id="theme"
              name="theme"
              rows={3}
              placeholder="如：夏日饮品系列海报，清新风格，5 张不同口味"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>卡片数量</Label>
              <input type="hidden" name="cardCount" value={cardCount} />
              <Select
                value={String(cardCount)}
                onValueChange={(v) => setCardCount(Number(v ?? 4))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{cardCount} 张</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {[2, 3, 4, 5, 6, 8, 10].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} 张
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>裂变模板</Label>
              <input type="hidden" name="templateId" value={templateId} />
              <Select value={templateId} onValueChange={(v) => setTemplateId(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="默认">
                    {templateId
                      ? (templates.find((t) => t.id === templateId)?.name ?? "默认")
                      : "默认"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {state?.error ? (
            <p className="text-sm text-destructive">{state.error}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <MorphingInfinity className="size-4" />
                  裂变中（LLM 调用）...
                </>
              ) : (
                "开始裂变"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
