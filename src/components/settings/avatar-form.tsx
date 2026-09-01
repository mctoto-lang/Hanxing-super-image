"use client"

import * as React from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

import { AvatarUpload } from "@/components/shared/avatar-upload"
import { updateMyAvatarAction } from "@/server/actions/settings"

/**
 * 个人头像表单：上传/移除后立即生效（落 users.image）。
 * 上传走 /api/upload/avatar（category=config，不过期）。
 */
export function AvatarForm({
  initialImage,
  fallbackText,
}: {
  initialImage: string | null
  fallbackText: string
}) {
  const [imageUrl, setImageUrl] = React.useState<string | null>(initialImage)
  const [pending, startTransition] = React.useTransition()
  const router = useRouter()

  function handleChange(url: string | null) {
    setImageUrl(url)
    startTransition(async () => {
      const res = await updateMyAvatarAction({ imageUrl: url })
      if (res.ok) {
        toast.success(url ? "头像已更新" : "头像已移除")
        router.refresh()
      } else {
        toast.error(res.error ?? "保存失败")
      }
    })
  }

  return (
    <AvatarUpload
      imageUrl={imageUrl}
      onChange={handleChange}
      fallbackText={fallbackText}
      disabled={pending}
    />
  )
}
