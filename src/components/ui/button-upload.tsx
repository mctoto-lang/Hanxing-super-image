"use client"

import { CheckCircle, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * 带进度动画的上传按钮（状态机参考 button-download 模板）：
 * idle（上传图片）→ uploading（spinner + 百分比 + 底部 primary 填充条）
 * → done（CheckCircle 已上传）→ 由调用方回落 idle。
 * uploading/done 期间禁用点击，防止重复触发。
 */
export function UploadButton({
  status,
  progress,
  onClick,
  className,
  label = "上传图片",
  size = "default",
}: {
  status: "idle" | "uploading" | "done"
  /** 0-100；缺省时只显示 spinner 不显示百分比 */
  progress?: number
  onClick: () => void
  className?: string
  label?: string
  size?: "default" | "sm"
}) {
  return (
    <Button
      type="button"
      size={size}
      onClick={onClick}
      disabled={status !== "idle"}
      className={cn(
        "relative overflow-hidden select-none",
        status === "uploading" && "bg-primary/50 hover:bg-primary/50",
        className,
      )}
    >
      {status === "idle" && (
        <>
          <Upload className="size-4" />
          {label}
        </>
      )}
      {status === "uploading" && (
        <div className="z-[5] flex items-center justify-center">
          <Loader2 className="mr-1 size-4 animate-spin" />
          {progress != null ? `${progress}%` : "上传中…"}
        </div>
      )}
      {status === "done" && (
        <>
          <CheckCircle className="size-4" />
          <span>已上传</span>
        </>
      )}
      {status === "uploading" && (
        <div
          className="absolute inset-y-0 left-0 z-[3] bg-primary transition-all duration-200 ease-in-out"
          style={{ width: `${progress ?? 0}%` }}
        />
      )}
    </Button>
  )
}
