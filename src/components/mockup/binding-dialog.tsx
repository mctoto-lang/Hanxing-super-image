"use client"

import * as React from "react"
import { Image as ImageIcon, Loader2, Replace, Type } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupBindingSetting } from "@/db/schema"
import type { MockupCardItemView, MockupLibraryImage } from "@/lib/mockup/types"
import { renderCardItemAction, saveCardBindingsAction } from "@/server/actions/mockup"
import { toImageSrc } from "@/lib/utils"
import { ImageLibraryDialog } from "./image-library-dialog"

interface BindingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cardId: string
  cardTitle: string
  item: MockupCardItemView | null
  /** 卡片当前保存的配置（弹窗初始值） */
  initialSettings: Record<string, MockupBindingSetting> | undefined
  costPerRender: number
  /** 我的上传图片库（父级持有） */
  designAssets: MockupLibraryImage[]
  onDesignAssetUploaded: (image: MockupLibraryImage) => void
  onRendered: () => void
  onSaved: () => void
}

/**
 * 图层替换弹窗（点击小方块打开）
 *
 * 左列 = PSD 绑定图层名（快照），右列 = 替换图片（图片库选择/上传）或文字输入。
 * 底部：仅渲染此样机（单张立即渲染）/ 保存配置（持久化，供整卡渲染用）。
 */
export function BindingDialog({
  open,
  onOpenChange,
  cardId,
  cardTitle,
  item,
  initialSettings,
  costPerRender,
  designAssets,
  onDesignAssetUploaded,
  onRendered,
  onSaved,
}: BindingDialogProps) {
  const [settings, setSettings] = React.useState<
    Record<string, MockupBindingSetting>
  >({})
  const [libraryBindingId, setLibraryBindingId] = React.useState<string | null>(
    null,
  )
  const [saving, setSaving] = React.useState(false)
  const [rendering, setRendering] = React.useState(false)

  React.useEffect(() => {
    if (open && item) {
      setSettings({ ...(initialSettings ?? {}) })
    }
  }, [open, item, initialSettings])

  if (!item) return null

  const pickImage = (bindingId: string, imageUrl: string) => {
    setSettings((prev) => ({
      ...prev,
      [bindingId]: { imageUrl, text: prev[bindingId]?.text },
    }))
    setLibraryBindingId(null)
  }

  const setText = (bindingId: string, text: string) => {
    setSettings((prev) => ({
      ...prev,
      [bindingId]: { imageUrl: prev[bindingId]?.imageUrl, text },
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await saveCardBindingsAction({
        cardId,
        groupItemId: item.id,
        bindings: settings,
      })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success("配置已保存")
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const handleRenderSingle = async () => {
    // 先保存当前配置再渲染（渲染读取卡片已存配置）
    setRendering(true)
    try {
      const saveRes = await saveCardBindingsAction({
        cardId,
        groupItemId: item.id,
        bindings: settings,
      })
      if (!saveRes.ok) {
        toast.error(saveRes.error ?? "保存失败")
        return
      }
      const res = await renderCardItemAction(cardId, item.id)
      if (!res.ok) {
        toast.error(res.error ?? "提交失败")
        return
      }
      if (res.submitted > 0) {
        toast.success(`已提交渲染，扣费 ${res.cost} 积分`)
        onRendered()
        onOpenChange(false)
      } else {
        const reason = res.skipped[0]?.reason ?? res.failedSubmits[0]?.message
        toast.warning(reason ? `未渲染：${reason}` : "未渲染")
      }
    } finally {
      setRendering(false)
    }
  }

  const imageCount = item.bindings.length

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>替换图层 · {item.displayName}</DialogTitle>
            <DialogDescription>
              {cardTitle} · 共 {imageCount} 个可替换图层（必填项配齐后才能渲染）
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {item.bindings.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                该模板没有配置可替换图层，请在模板管理中编辑绑定后重新加入套组
              </div>
            ) : null}
            {item.bindings.map((def) => {
              const setting = settings[def.bindingId]
              return (
                <div
                  key={def.bindingId}
                  className="flex items-center gap-3 rounded-lg border p-2.5"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {def.type === "text" ? (
                      <Type className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm">
                        {def.label || def.bindingId}
                        {def.required ? (
                          <span className="ml-1 text-destructive">*</span>
                        ) : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {def.type === "text" ? "文字图层" : "图片图层"}
                        {def.layerPath ? ` · ${def.layerPath}` : ""}
                      </div>
                    </div>
                  </div>

                  {def.type === "text" ? (
                    <Input
                      value={setting?.text ?? ""}
                      onChange={(e) => setText(def.bindingId, e.target.value)}
                      placeholder={
                        def.required ? "必填文字" : "可选文字（留空不替换）"
                      }
                      className="max-w-[200px]"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      {setting?.imageUrl ? (
                        <SmartImage
                          src={toImageSrc(setting.imageUrl, { width: 80 })}
                          alt="已选图片"
                          className="size-9 rounded border object-cover"
                        />
                      ) : (
                        <span className="inline-flex size-9 items-center justify-center rounded border border-dashed text-muted-foreground">
                          <ImageIcon className="size-4" />
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setLibraryBindingId(def.bindingId)}
                      >
                        <Replace className="size-3.5" />
                        替换图片
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="secondary"
              disabled={rendering}
              onClick={() => void handleRenderSingle()}
            >
              {rendering ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              仅渲染此样机 · {costPerRender} 积分
            </Button>
            <Button disabled={saving} onClick={() => void handleSave()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImageLibraryDialog
        open={libraryBindingId !== null}
        onOpenChange={(o) => !o && setLibraryBindingId(null)}
        assets={designAssets}
        onUploaded={onDesignAssetUploaded}
        onSelect={(url) =>
          libraryBindingId && pickImage(libraryBindingId, url)
        }
      />
    </>
  )
}
