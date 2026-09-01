"use client"

import * as React from "react"
import { Upload, X, ImageIcon } from "lucide-react"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { cn } from "@/lib/utils"
import { uploadImage } from "@/lib/upload/upload-image"
import { toast } from "sonner"

/**
 * 参考图上传组件（手册 §5.5、§7.1，对照旧项目 product-reference-upload.tsx）
 *
 * - 仅图片（PNG/JPG/JPEG/WebP），单文件 ≤ 10MB，最长边 ≤ 8192px
 * - 上传到 /api/upload（FormData field="file"），返回 { url }
 * - 缩略图 + 删除；达到上限时隐藏上传入口
 */

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_DIMENSION = 8192
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"]

interface Props {
  maxImages: number
  value: string[]
  onChange: (urls: string[]) => void
  disabled?: boolean
}

/** 读取图片真实尺寸做预校验（防伪造 MIME） */
function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new window.Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("无法读取图片"))
    }
    img.src = url
  })
}

export function ReferenceImageUpload({
  maxImages,
  value,
  onChange,
  disabled,
}: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)

  const reached = value.length >= maxImages

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    const remaining = maxImages - value.length
    const picked = list.slice(0, remaining)

    for (const file of picked) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast.error(`${file.name}：仅支持 PNG/JPG/WebP`)
        continue
      }
      if (file.size > MAX_SIZE) {
        toast.error(`${file.name}：超过 10MB`)
        continue
      }
      try {
        const { width, height } = await readImageSize(file)
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          toast.error(`${file.name}：图片尺寸过大（上限 ${MAX_DIMENSION}px）`)
          continue
        }
        setUploading(true)
        const url = await uploadImage(file)
        onChange([...value, url])
      } catch {
        toast.error(`${file.name}：上传失败`)
      } finally {
        setUploading(false)
      }
    }
    if (inputRef.current) inputRef.current.value = ""
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (disabled || uploading || reached) return
    if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files)
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void handleFiles(e.target.files)
        }}
        disabled={disabled || uploading || reached}
      />

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {value.map((url, i) => (
            <div
              key={url + i}
              className="group relative size-16 overflow-hidden rounded-md border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`参考图 ${i + 1}`}
                className="size-full object-cover"
              />
              <button
                type="button"
                onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="删除参考图"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {!reached ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-accent",
            dragging && "border-primary bg-accent",
            (disabled || uploading) && "cursor-not-allowed opacity-60",
          )}
        >
          {uploading ? (
            <>
              <MorphingInfinity className="size-4" />
              上传中...
            </>
          ) : (
            <>
              <Upload className="size-4" />
              点击或拖拽上传参考图（最多 {maxImages} 张，PNG/JPG/WebP，≤10MB）
            </>
          )}
        </button>
      ) : null}

      {value.length === 0 && reached ? (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5" />
          已达参考图上限
        </div>
      ) : null}
    </div>
  )
}
