"use client"

import * as React from "react"
import {
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupBatchDetail } from "@/lib/mockup/types"
import { toImageSrc } from "@/lib/utils"
import {
  cancelMockupTaskAction,
  retryBatchTaskAction,
} from "@/server/actions/mockup"

async function downloadUrl(url: string, filename: string) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objUrl)
  } catch {
    // CORS 等场景回退新窗口打开
    window.open(url, "_blank")
  }
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)
}

/** 从结果 URL 推断下载扩展名（结果文件按实际格式存储：.png/.jpg/.psd） */
function extFromUrl(url: string): string {
  const m = /\.(png|jpe?g|psd)(?:$|[?#])/i.exec(url)
  return m ? `.${m[1]!.toLowerCase().replace("jpeg", "jpg")}` : ".png"
}

/** 将图片 URL 列表打包为单个 ZIP 下载（命名：序号-名称，扩展名取自实际文件） */
export async function downloadImagesZip(
  items: Array<{ url: string; name: string }>,
  zipName: string,
): Promise<void> {
  if (items.length === 0) {
    toast.warning("暂无已完成的结果图")
    return
  }
  const { zipSync } = await import("fflate")
  const files: Record<string, Uint8Array> = {}
  for (const [i, it] of items.entries()) {
    const res = await fetch(it.url)
    if (!res.ok) continue
    files[`${String(i + 1).padStart(3, "0")}-${safeFileName(it.name)}${extFromUrl(it.url)}`] =
      new Uint8Array(await res.arrayBuffer())
  }
  if (Object.keys(files).length === 0) {
    toast.error("结果图拉取失败，请逐张下载")
    return
  }
  const blob = new Blob([zipSync(files)], { type: "application/zip" })
  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objUrl
  a.download = zipName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objUrl)
}

/** 外部渲染阶段 → 中文（与 PS-API stage 枚举对齐） */
const STAGE_LABELS: Record<string, string> = {
  DOWNLOAD: "下载素材",
  RUN_JSX: "执行渲染",
  EXPORT: "导出",
  UPLOAD: "上传",
}

/* ─── 批次详情（任务网格 + 取消 + 重试 + 打包下载） ─── */

export function BatchDetail({
  batch,
  onRefresh,
}: {
  batch: MockupBatchDetail
  onRefresh: () => void
}) {
  const [retrying, setRetrying] = React.useState<string | null>(null)
  const [cancelling, setCancelling] = React.useState<string | null>(null)
  const [zipping, setZipping] = React.useState(false)

  const handleCancelTask = async (taskId: string) => {
    setCancelling(taskId)
    try {
      const res = await cancelMockupTaskAction(taskId)
      if (!res.ok) {
        toast.error(res.error ?? "取消失败")
        return
      }
      toast.success(res.message ?? "取消请求已发送，状态稍后更新")
      onRefresh()
    } finally {
      setCancelling(null)
    }
  }

  const handleRetry = async (taskId: string) => {
    setRetrying(taskId)
    try {
      const res = await retryBatchTaskAction(taskId)
      if (!res.ok) {
        toast.error(res.error ?? "重试失败")
        return
      }
      toast.success("已重新提交（重新扣费）")
      onRefresh()
    } finally {
      setRetrying(null)
    }
  }

  const handleZip = async () => {
    if (zipping) return
    setZipping(true)
    try {
      await downloadImagesZip(
        batch.tasks
          .filter((t) => t.status === "completed" && t.resultImage)
          .map((t) => ({ url: t.resultImage!, name: t.label })),
        `批量替换-${batch.displayName}-${batch.id.slice(0, 8)}.zip`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "打包失败")
    } finally {
      setZipping(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{batch.displayName}</h2>
          <p className="text-xs text-muted-foreground">
            共 {batch.totalCount} 张 · 成功 {batch.succeededCount} · 失败{" "}
            {batch.failedCount} · 进行中 {batch.processingCount} ·{" "}
            {new Date(batch.createdAt).toLocaleString("zh-CN")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={zipping} onClick={() => void handleZip()}>
            {zipping ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            打包下载
          </Button>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {batch.tasks.map((t) => (
          <div
            key={t.taskId}
            className="flex flex-col gap-1 rounded-lg border bg-card p-1.5"
          >
            <div className="relative aspect-square overflow-hidden rounded-md bg-muted/50">
              {t.resultImage ? (
                <SmartImage
                  src={toImageSrc(t.resultImage, { width: 240 })}
                  alt={t.label}
                  className="size-full object-cover"
                />
              ) : (
                <span className="flex size-full items-center justify-center">
                  {t.status === "failed" ? (
                    <XCircle className="size-6 text-destructive/70" />
                  ) : t.status === "completed" ? (
                    <CheckCircle2 className="size-6 text-emerald-500/70" />
                  ) : (
                    <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
                  )}
                </span>
              )}
              <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[9px]">
                #{t.batchIndex}
              </span>
            </div>
            <span className="truncate text-[10px]" title={t.label}>
              {t.label}
            </span>
            {t.status === "processing" || t.status === "queued" ? (
              <Progress value={t.progress} className="h-1" />
            ) : null}
            <div className="flex items-center justify-between">
              <span
                className={`text-[10px] ${
                  t.status === "completed"
                    ? "text-emerald-600"
                    : t.status === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
                title={t.errorMessage ?? undefined}
              >
                {t.status === "completed"
                  ? "完成"
                  : t.status === "failed"
                    ? "失败"
                    : t.status === "queued"
                      ? "排队"
                      : (t.stage ? STAGE_LABELS[t.stage] ?? t.stage : "渲染中")}
              </span>
              <span className="flex gap-0.5">
                {t.status === "queued" || t.status === "processing" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    title="取消渲染（取消后退款）"
                    disabled={cancelling === t.taskId}
                    onClick={() => void handleCancelTask(t.taskId)}
                  >
                    {cancelling === t.taskId ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <X className="size-3" />
                    )}
                  </Button>
                ) : null}
                {t.status === "failed" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    title={`重试（重新扣费）${t.errorMessage ? `：${t.errorMessage}` : ""}`}
                    disabled={retrying === t.taskId}
                    onClick={() => void handleRetry(t.taskId)}
                  >
                    {retrying === t.taskId ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3" />
                    )}
                  </Button>
                ) : null}
                {t.resultImage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    title="下载"
                    onClick={() =>
                      void downloadUrl(
                        t.resultImage!,
                        `${String(t.batchIndex).padStart(3, "0")}-${safeFileName(t.label)}${extFromUrl(t.resultImage!)}`,
                      )
                    }
                  >
                    <Download className="size-3" />
                  </Button>
                ) : null}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
