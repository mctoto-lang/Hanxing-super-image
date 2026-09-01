"use client"

import * as React from "react"
import { ImageIcon, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { uploadAvatarImage } from "@/lib/upload/upload-avatar-image"

/**
 * 头像上传控件（受控）：预览 + 上传 + 移除。
 *
 * 图片本体走 /api/upload/avatar（category=config，不过期）；
 * 由父组件在保存时把最终 URL 落库（users.image）。
 * 预览期间 URL 尚未落库，刷新页面即丢弃。
 */
export function AvatarUpload({
  imageUrl,
  onChange,
  fallbackText,
  disabled,
}: {
  imageUrl: string | null
  onChange: (url: string | null) => void
  /** 无头像时预览占位文字（取昵称/用户名首字） */
  fallbackText: string
  disabled?: boolean
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const initials = (fallbackText || "?").slice(0, 1).toUpperCase()

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // 允许重复选择同一文件
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件")
      return
    }
    setUploading(true)
    try {
      const url = await uploadAvatarImage(file)
      onChange(url)
      toast.success("头像已上传，保存后生效")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar className="size-16">
        <AvatarImage src={imageUrl ?? undefined} alt="头像" />
        <AvatarFallback className="text-lg">{initials}</AvatarFallback>
      </Avatar>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <MorphingInfinity className="size-3.5" />
          ) : (
            <ImageIcon className="size-3.5" />
          )}
          {imageUrl ? "更换头像" : "上传头像"}
        </Button>
        {imageUrl ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => onChange(null)}
          >
            <Trash2 className="size-3.5" />
            移除
          </Button>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  )
}
