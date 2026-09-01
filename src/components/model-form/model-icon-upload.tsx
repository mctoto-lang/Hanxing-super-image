"use client"

import * as React from "react"
import { Upload, X } from "lucide-react"
import { toast } from "sonner"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { cn, toImageSrc } from "@/lib/utils"
import { uploadConfigImage } from "@/lib/upload/upload-config-image"

/**
 * 模型图标上传（需求 1）
 *
 * 替代旧「图标 URL」文本框：仅本地上传，预览 + 更换/移除。
 * 上传走 /api/upload/config（category=config，不过期）。
 */
const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.svg,image/png,image/jpeg,image/webp,image/gif,image/svg+xml"

export function ModelIconUpload({
  value,
  onChange,
}: {
  value: string | null
  onChange: (url: string | null) => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return

    const name = file.name.toLowerCase()
    const isImage =
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|svg)$/.test(name)
    if (!isImage) {
      toast.error("仅支持图片格式")
      return
    }
    if (file.size > MAX_SIZE) {
      toast.error("图标大小不能超过 2MB")
      return
    }

    setUploading(true)
    try {
      const url = await uploadConfigImage(file)
      onChange(url)
      toast.success("图标已上传")
    } catch {
      toast.error("图标上传失败")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={handleFile}
      />

      {/* 预览 / 占位 */}
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={toImageSrc(value)}
          alt="模型图标"
          className="size-12 shrink-0 rounded-lg border object-cover"
        />
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className={cn(
            "flex size-12 shrink-0 flex-col items-center justify-center rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-primary hover:text-primary",
            uploading && "opacity-60",
          )}
        >
          {uploading ? (
            <MorphingInfinity className="size-4" />
          ) : (
            <Upload className="size-4" />
          )}
        </button>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-60"
          >
            {uploading ? "上传中..." : value ? "更换图标" : "上传图标"}
          </button>
          {value ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-destructive"
            >
              <X className="size-3" />
              移除
            </button>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          PNG / JPG / WebP / GIF / SVG，≤ 2MB
        </p>
      </div>
    </div>
  )
}
