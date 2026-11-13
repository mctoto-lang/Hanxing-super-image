"use client"

import * as React from "react"
import { toast } from "sonner"
import { Pencil } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveFactoryAction } from "@/server/actions/inventory-production"
import type { Factory } from "./shared"

/** 工厂档案管理弹窗（建单时下拉选择） */

export function FactoryDialog({
  open,
  onOpenChange,
  factories,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  factories: Factory[]
  onSaved: () => void
}) {
  const [code, setCode] = React.useState("")
  const [name, setName] = React.useState("")
  const [note, setNote] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [pending, startSubmit] = React.useTransition()

  const reset = () => {
    setCode("")
    setName("")
    setNote("")
    setEnabled(true)
    setEditingId(null)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset() }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>工厂档案</DialogTitle>
          <DialogDescription>生产方代号（JS/JYC/RP/XG/XHY/HZ…），建单时下拉选择。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="max-h-48 space-y-1.5 overflow-y-auto">
            {factories.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
              >
                <span className="font-normal">{f.code}</span>
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-muted-foreground">{f.enabled ? "" : "已停用"}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0"
                  onClick={() => {
                    setEditingId(f.id)
                    setCode(f.code)
                    setName(f.name)
                    setNote(f.note ?? "")
                    setEnabled(f.enabled)
                  }}
                >
                  <Pencil className="size-3" />
                </Button>
              </div>
            ))}
            {factories.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无工厂，先添加</p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="fc-code">代号 *</Label>
              <Input
                id="fc-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="如 JS"
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fc-name">名称 *</Label>
              <Input
                id="fc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 金盛"
                className="h-9"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fc-note">备注</Label>
            <Input
              id="fc-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-9"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!enabled}
              onCheckedChange={(v) => setEnabled(v !== true)}
            />
            停用（不可再建单）
          </label>
        </div>
        <DialogFooter className="gap-2">
          {editingId ? (
            <Button variant="outline" onClick={reset} disabled={pending}>
              取消编辑
            </Button>
          ) : null}
          <Button
            disabled={pending}
            onClick={() =>
              startSubmit(async () => {
                if (!code.trim() || !name.trim()) {
                  toast.error("代号与名称必填")
                  return
                }
                const r = await saveFactoryAction(
                  {
                    code: code.trim(),
                    name: name.trim(),
                    note: note.trim() || null,
                    enabled,
                  },
                  editingId ?? undefined,
                )
                if (r.ok) {
                  toast.success(editingId ? "工厂已更新" : "工厂已添加")
                  reset()
                  onSaved()
                } else toast.error(r.error)
              })
            }
          >
            {pending && <DashRing className="size-3.5" />}
            {editingId ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
