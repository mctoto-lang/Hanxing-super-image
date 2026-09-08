"use client"

import * as React from "react"
import { Image as ImageIcon, Replace, Type } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupBindingSetting } from "@/db/schema"
import type { MockupCardItemView, MockupLibraryImage } from "@/lib/mockup/types"
import { saveCardBindingsAction } from "@/server/actions/mockup"
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
  /** 我的上传图片库（父级持有） */
  designAssets: MockupLibraryImage[]
  onDesignAssetUploaded: (image: MockupLibraryImage) => void
  onSaved: () => void
}

/**
 * 图层替换弹窗（点击小方块打开）
 *
 * 左列 = PSD 绑定图层名（快照，背景图层置顶），右列 = 替换图片（图片库
 * 选择/上传）或文字输入。选择图片或文字失焦后自动保存配置（供整卡渲染用）。
 */
export function BindingDialog({
  open,
  onOpenChange,
  cardId,
  cardTitle,
  item,
  initialSettings,
  designAssets,
  onDesignAssetUploaded,
  onSaved,
}: BindingDialogProps) {
  const [settings, setSettings] = React.useState<
    Record<string, MockupBindingSetting>
  >({})
  const [libraryBindingId, setLibraryBindingId] = React.useState<string | null>(
    null,
  )
  // 最近一次已持久化的快照，内容相同则跳过保存
  const savedSnapshotRef = React.useRef<string>("")

  React.useEffect(() => {
    if (open && item) {
      setSettings({ ...(initialSettings ?? {}) })
      savedSnapshotRef.current = JSON.stringify(initialSettings ?? {})
    }
  }, [open, item, initialSettings])

  if (!item) return null

  const persistSettings = async (next: Record<string, MockupBindingSetting>) => {
    const snapshot = JSON.stringify(next)
    if (snapshot === savedSnapshotRef.current) return
    savedSnapshotRef.current = snapshot
    const res = await saveCardBindingsAction({
      cardId,
      groupItemId: item.id,
      bindings: next,
    })
    if (!res.ok) {
      toast.error(res.error ?? "自动保存失败")
      return
    }
    onSaved()
  }

  const pickImage = (bindingId: string, imageUrl: string) => {
    const next = {
      ...settings,
      [bindingId]: { imageUrl, text: settings[bindingId]?.text },
    }
    setSettings(next)
    void persistSettings(next)
    setLibraryBindingId(null)
  }

  const setText = (bindingId: string, text: string) => {
    setSettings((prev) => ({
      ...prev,
      [bindingId]: { imageUrl: prev[bindingId]?.imageUrl, text },
    }))
  }

  // 背景绑定置顶
  const orderedBindings = [...item.bindings].sort((a, b) => {
    const ab = a.role === "background" ? 0 : 1
    const bb = b.role === "background" ? 0 : 1
    return ab - bb
  })
  const imageCount = item.bindings.length

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
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
            {orderedBindings.map((def) => {
              const setting = settings[def.bindingId]
              const isBackground = def.role === "background"
              return (
                <div
                  key={def.bindingId}
                  className={`flex items-center gap-3 rounded-lg border p-2.5 ${
                    isBackground ? "border-primary/40 bg-primary/5" : ""
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {def.type === "text" ? (
                      <Type className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 truncate text-sm">
                      {def.label || def.bindingId}
                      {isBackground ? (
                        <span className="ml-1 rounded bg-primary/15 px-1 text-[9px] text-primary">
                          背景
                        </span>
                      ) : null}
                      {def.required ? (
                        <span className="ml-1 text-destructive">*</span>
                      ) : null}
                    </div>
                  </div>

                  {def.type === "text" ? (
                    <Input
                      value={setting?.text ?? ""}
                      onChange={(e) => setText(def.bindingId, e.target.value)}
                      onBlur={() => void persistSettings(settings)}
                      placeholder={
                        def.required ? "必填文字" : "可选文字（留空不替换）"
                      }
                      className="max-w-[200px]"
                    />
                  ) : (
                    <div className="flex items-center gap-1.5">
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
