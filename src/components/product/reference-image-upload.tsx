"use client"

import { useCallback, useState } from "react"
import { Upload, X } from "lucide-react"
import Image from "next/image"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { cn, toImageSrc } from "@/lib/utils"
import { toast } from "sonner"
import { uploadReferenceImages } from "@/lib/workspace/upload"

interface ReferenceImageUploadProps {
  images: string[]
  onChange: (images: string[]) => void
  maxImages: number
}

export function ReferenceImageUpload({
  images,
  onChange,
  maxImages,
}: ReferenceImageUploadProps) {
  const [uploading, setUploading] = useState(false)

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const remaining = maxImages - images.length
      if (remaining <= 0) {
        toast.error(`最多上传 ${maxImages} 张参考图`)
        return
      }
      const fileArr = Array.from(files).slice(0, remaining)
      setUploading(true)
      try {
        const results = await uploadReferenceImages(fileArr)
        if (results.length === 0) {
          toast.error("图片上传失败，请检查格式与尺寸")
        } else {
          onChange([...images, ...results.map((r) => r.url)])
          if (results.length < fileArr.length) {
            toast.warning(
              `成功上传 ${results.length} 张，${fileArr.length - results.length} 张失败`,
            )
          }
        }
      } finally {
        setUploading(false)
      }
    },
    [images, maxImages, onChange],
  )

  const removeImage = (idx: number) => {
    onChange(images.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {images.map((url, idx) => (
          <div
            key={url + idx}
            className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted"
          >
            <Image
              src={toImageSrc(url)}
              alt={`参考图 ${idx + 1}`}
              fill
              className="object-cover"
              unoptimized
            />
            <button
              type="button"
              onClick={() => removeImage(idx)}
              className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="移除"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {images.length < maxImages && (
          <label
            className={cn(
              "flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary",
              uploading && "pointer-events-none opacity-50",
            )}
          >
            {uploading ? (
              <MorphingInfinity className="h-5 w-5" />
            ) : (
              <>
                <Upload className="h-5 w-5" />
                <span className="text-xs">上传参考图</span>
              </>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        支持 PNG/JPEG/WebP，单张 ≤ 10MB，最多 {maxImages} 张
      </p>
    </div>
  )
}
