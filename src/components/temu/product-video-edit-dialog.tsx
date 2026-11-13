"use client"

import * as React from "react"
import { toast } from "sonner"
import { FileVideo, RefreshCw, Upload } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getTemuVideoResultAction, submitProductVideoAction } from "@/server/actions/temu-publish"
import {
  SINGLE_UPLOAD_MAX_BYTES,
  uploadProgress,
  validateVideoFile,
  videoChunkRanges,
} from "@/lib/temu/video-upload"
import type { TemuProductRow } from "@/server/actions/temu"

/**
 * 换视频弹窗（商品信息页设置菜单）：上传 → 转码轮询 → 挂载提交。
 * 链路口径（2026-11-12 探针全通，docs §8.12）：sign → galerie 直传（≤20MB 单请求 /
 * >20MB 分片）→ result.get{vid} 轮询 → edit.pictures.submit 挂主图轮播视频位或
 * 详情视频位（独立提交即生效）。官方无素材回显接口，重复挂载同视频报 996000024。
 */

type Phase = "idle" | "uploading" | "transcoding" | "ready"

type VideoResult = {
  vid: string
  coverUrl: string
  videoUrl: string
  width: number
  height: number
}

/** 转码轮询：3s 间隔、上限 40 次（约 2 分钟），超限转手动重试 */
const POLL_INTERVAL_MS = 3000
const POLL_MAX_TRIES = 40

function fmtMB(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 容错读取上传路由响应：成功体为 JSON，错误体统一为纯文本（route-helpers 口径，
 *  官方 galerie 错误/权限/超限等以原文透传）——先读文本再 JSON.parse，非 JSON 时
 *  以原文为错误信息，勿直接 res.json()（会对纯文本错误体抛 SyntaxError 盖掉真实原因） */
async function readUploadJson<T extends { ok?: boolean; error?: string }>(
  res: Response,
  fallback: string,
): Promise<T> {
  const text = await res.text()
  let json: T | null = null
  try {
    json = JSON.parse(text) as T
  } catch {
    // 纯文本错误体：json 保持 null，走下方原文兜底
  }
  if (!res.ok || !json?.ok) throw new Error(json?.error || text.trim() || fallback)
  return json
}

async function readVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement("video")
    el.preload = "metadata"
    const done = (v: number | null) => {
      URL.revokeObjectURL(url)
      resolve(v)
    }
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null)
    el.onerror = () => done(null)
    // 兜底：元数据 5 秒读不出按未知处理，不拦截上传
    setTimeout(() => done(null), 5000)
    el.src = url
  })
}

export function ProductVideoEditDialog({
  open,
  onOpenChange,
  row,
  storeId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 链接（SKC）主行：取 productId / productName */
  row: TemuProductRow | null
  storeId?: string
}) {
  const [phase, setPhase] = React.useState<Phase>("idle")
  const [file, setFile] = React.useState<File | null>(null)
  const [duration, setDuration] = React.useState<number | null>(null)
  const [uploaded, setUploaded] = React.useState(0)
  const [video, setVideo] = React.useState<VideoResult | null>(null)
  const [slot, setSlot] = React.useState<"carousel" | "detail">("carousel")
  const [submitting, setSubmitting] = React.useState(false)
  const [pollExhausted, setPollExhausted] = React.useState(false)
  const abortRef = React.useRef<AbortController | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const reset = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setPhase("idle")
    setFile(null)
    setDuration(null)
    setUploaded(0)
    setVideo(null)
    setSlot("carousel")
    setPollExhausted(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [])

  React.useEffect(() => {
    if (open) reset()
  }, [open, reset])

  const pickFile = async (f: File) => {
    const dur = await readVideoDuration(f)
    const err = validateVideoFile(f, dur)
    if (err) {
      toast.error(err)
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    setFile(f)
    setDuration(dur)
  }

  /** 上传（≤20MB 单请求；>20MB 分片 init→part×N→complete） */
  const upload = async () => {
    if (!file || !storeId) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase("uploading")
    setUploaded(0)
    try {
      let vid: string
      if (file.size <= SINGLE_UPLOAD_MAX_BYTES) {
        const fd = new FormData()
        fd.append("op", "single")
        fd.append("store", storeId)
        fd.append("file", file)
        const res = await fetch("/api/temu/video-upload", { method: "POST", body: fd, signal: controller.signal })
        const json = await readUploadJson<{ ok?: boolean; vid?: string }>(res, `上传失败（HTTP ${res.status}）`)
        if (!json.vid) throw new Error(`上传失败（HTTP ${res.status}）`)
        vid = json.vid
        setUploaded(file.size)
      } else {
        // 分片：非末块恒 20MB（5MB 整数倍），末块余量不限
        const fd0 = new FormData()
        fd0.append("op", "init")
        fd0.append("store", storeId)
        fd0.append("contentType", file.type)
        const res0 = await fetch("/api/temu/video-upload", { method: "POST", body: fd0, signal: controller.signal })
        const json0 = await readUploadJson<{ ok?: boolean; uploadSign?: string }>(res0, `初始化分片失败（HTTP ${res0.status}）`)
        if (!json0.uploadSign) throw new Error(`初始化分片失败（HTTP ${res0.status}）`)
        const ranges = videoChunkRanges(file.size)
        for (let i = 0; i < ranges.length; i += 1) {
          const { start, end } = ranges[i]!
          const blob = file.slice(start, end)
          const fd = new FormData()
          fd.append("op", "part")
          fd.append("store", storeId)
          fd.append("uploadSign", json0.uploadSign)
          fd.append("partNum", String(i + 1))
          fd.append("file", blob, `part-${i + 1}`)
          const res = await fetch("/api/temu/video-upload", { method: "POST", body: fd, signal: controller.signal })
          await readUploadJson<{ ok?: boolean }>(res, `分片 ${i + 1}/${ranges.length} 上传失败（HTTP ${res.status}）`)
          setUploaded(end)
        }
        const fdc = new FormData()
        fdc.append("op", "complete")
        fdc.append("store", storeId)
        fdc.append("uploadSign", json0.uploadSign)
        const res = await fetch("/api/temu/video-upload", { method: "POST", body: fdc, signal: controller.signal })
        const json = await readUploadJson<{ ok?: boolean; vid?: string }>(res, `完成上传失败（HTTP ${res.status}）`)
        if (!json.vid) throw new Error(`完成上传失败（HTTP ${res.status}）`)
        vid = json.vid
      }
      setPhase("transcoding")
      setPollVid(vid)
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return
      toast.error(err instanceof Error ? err.message : "上传失败")
      setPhase("idle")
      setUploaded(0)
    }
  }

  /** 轮询目标 vid（上传完成才有；ref 供轮询 effect 读取） */
  const [pollVid, setPollVid] = React.useState<string | null>(null)

  // 转码轮询：phase=transcoding 时启动（错误/未完成静默继续，超限转手动重试）
  React.useEffect(() => {
    if (phase !== "transcoding" || !pollVid || !storeId) return
    let tries = 0
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      tries += 1
      try {
        const r = await getTemuVideoResultAction({ store: storeId, vid: pollVid })
        if (cancelled) return
        if (r.ok && r.video) {
          setVideo(r.video)
          setPhase("ready")
          return
        }
        if (!r.ok) {
          toast.error(r.error, { duration: 6000 })
          setPhase("ready")
          return
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "查询转码结果失败")
        setPhase("ready")
        return
      }
      if (tries >= POLL_MAX_TRIES) {
        setPollExhausted(true)
        return
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    let timer = setTimeout(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phase, pollVid, storeId])

  const retryPoll = async () => {
    if (!pollVid || !storeId) return
    const r = await getTemuVideoResultAction({ store: storeId, vid: pollVid })
    if (r.ok && r.video) {
      setVideo(r.video)
      setPollExhausted(false)
      setPhase("ready")
    } else if (!r.ok) {
      toast.error(r.error, { duration: 6000 })
    } else {
      toast.info("转码仍在处理中，请稍后再试")
    }
  }

  const submit = async () => {
    if (!row?.productId || !storeId || !video) return
    setSubmitting(true)
    try {
      const r = await submitProductVideoAction({
        storeId,
        productId: row.productId,
        slot,
        video,
      })
      if (r.ok) {
        toast.success(slot === "carousel" ? "主图视频已提交官方（生效以官方审核为准）" : "详情视频已提交官方（生效以官方审核为准）")
        onOpenChange(false)
      } else {
        toast.error(r.error)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const pct = file ? uploadProgress(uploaded, file.size) : 0
  const canSubmit = phase === "ready" && !!video && !!row?.productId && !!storeId && !submitting

  /** 关闭请求统一走这里：取消按钮与 ESC/遮罩一致——中止进行中的上传并复位 */
  const requestClose = (v: boolean) => {
    onOpenChange(v)
    if (!v) reset()
  }

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>换视频</DialogTitle>
          <DialogDescription>
            {row?.productName ? `${row.productName.slice(0, 40)}${row.productName.length > 40 ? "…" : ""} · ` : ""}
            上传后挂载到主图视频位或详情视频位。
          </DialogDescription>
        </DialogHeader>
        {/* DialogDescription 渲染 <p>，块级提示须放外部防 p>div 嵌套 hydration 错 */}
        <div className="text-xs text-muted-foreground">
          官方口径：≤500MB、≤60 秒，建议 1:1 / 3:4 / 16:9，前 10 秒突出核心卖点；超过 20MB 自动走分片上传。
        </div>

        <div className="space-y-3">
          {/* 文件选择 / 上传进度 */}
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void pickFile(f)
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={phase === "uploading" || phase === "transcoding"}
              onClick={() => fileInputRef.current?.click()}
            >
              <FileVideo className="size-3.5" /> 选择视频
            </Button>
            {file && (
              <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {file.name} · {fmtMB(file.size)}
                {duration != null ? ` · ${Math.round(duration)} 秒` : ""} ·{" "}
                {file.size > SINGLE_UPLOAD_MAX_BYTES ? "分片上传" : "直传"}
              </div>
            )}
            {file && phase === "idle" && (
              <Button type="button" size="sm" className="h-8" onClick={() => void upload()}>
                <Upload className="size-3.5" /> 上传
              </Button>
            )}
          </div>

          {/* 上传进度条 */}
          {file && phase === "uploading" && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <DashRing className="size-3" /> 上传中 {pct}%（{fmtMB(uploaded)} / {fmtMB(file.size)}）
              </div>
            </div>
          )}

          {/* 转码轮询 */}
          {phase === "transcoding" && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DashRing className="size-3" />
              {pollExhausted ? (
                <>
                  转码耗时较长，可稍后手动刷新
                  <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void retryPoll()}>
                    <RefreshCw className="size-3" /> 刷新
                  </Button>
                </>
              ) : (
                "官方转码处理中，通常十几秒内完成…"
              )}
            </div>
          )}

          {/* 转码完成预览 */}
          {phase === "ready" && video && (
            <div className="space-y-2">
              <video
                src={video.videoUrl}
                poster={video.coverUrl || undefined}
                controls
                className="max-h-64 w-full rounded-md border bg-muted/40"
              />
              {video.width > 0 && (
                <div className="text-xs text-muted-foreground">
                  转码完成：{video.width}×{video.height}
                </div>
              )}
            </div>
          )}
          {phase === "ready" && !video && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              转码结果暂不可用
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void retryPoll()}>
                <RefreshCw className="size-3" /> 重试查询
              </Button>
            </div>
          )}

          {/* 挂载位选择 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">挂载位置</span>
            <Button
              type="button"
              variant={slot === "carousel" ? "default" : "outline"}
              size="sm"
              className="h-7 text-[11px]"
              disabled={!canSubmit && phase !== "ready"}
              onClick={() => setSlot("carousel")}
            >
              主图视频
            </Button>
            <Button
              type="button"
              variant={slot === "detail" ? "default" : "outline"}
              size="sm"
              className="h-7 text-[11px]"
              disabled={!canSubmit && phase !== "ready"}
              onClick={() => setSlot("detail")}
            >
              详情视频
            </Button>
          </div>

          {!row?.productId && <div className="text-xs text-amber-600">该链接缺 SPU 编号（productId），无法提交</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => requestClose(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? <DashRing className="size-4" /> : null}
            提交官方
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
