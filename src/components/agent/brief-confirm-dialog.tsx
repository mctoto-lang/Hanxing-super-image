"use client"

/**
 * 《设计简报》确认弹窗：创意总监整理的简报在这里查看 / 修改并确认，
 * 确认后进入内容方向阶段（saveTemplateBriefAction）。
 */
import { useEffect, useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ResponsiveDialog } from "./responsive-dialog"

export function BriefConfirmDialog({
  open,
  onOpenChange,
  initialBrief,
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialBrief: string
  /** AI 团队处理中（禁用编辑与确认） */
  busy: boolean
  onConfirm: (brief: string) => void | Promise<void>
}) {
  const [brief, setBrief] = useState(initialBrief)
  const [confirming, setConfirming] = useState(false)

  // 重新生成简报后重置编辑态
  useEffect(() => {
    setBrief(initialBrief)
  }, [initialBrief])

  const confirm = async () => {
    setConfirming(true)
    try {
      // 等待确认完成再复位：否则 React 批处理后 confirming 恒为 false，
      // spinner 与基于 confirming 的防重全部失效
      await onConfirm(brief)
    } finally {
      setConfirming(false)
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="《设计简报》"
      badge={
        <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
          待确认
        </Badge>
      }
      description="后续所有角色都会以这份简报为准，可直接修改；确认后世界观策划会据此构思 3 个内容方向。"
      desktopClassName="sm:max-w-2xl"
    >
      <div className="space-y-3">
        <label htmlFor="brief-editor-dialog" className="sr-only">
          设计简报内容
        </label>
        <Textarea
          id="brief-editor-dialog"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          className="min-h-[min(48svh,360px)] resize-y font-mono text-xs leading-6"
          disabled={busy}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="sm" disabled={busy || confirming} onClick={() => onOpenChange(false)}>
            稍后再说
          </Button>
          <Button size="sm" disabled={busy || confirming || !brief.trim()} onClick={confirm}>
            {confirming ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            确认简报，生成 3 个内容方向
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  )
}
