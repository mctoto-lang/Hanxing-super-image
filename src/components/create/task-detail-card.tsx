"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  RefreshCw,
  Trash2,
  AlertCircle,
  MoreHorizontal,
  PencilLine,
  Copy,
  TriangleAlert,
  Info,
  Download,
  Maximize2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { copyText, toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import { ImageGeneration } from "@/components/ui/image-generation"
import { parseImageSize, sizeToRatioLabel } from "@/lib/image-sizes"
import { deleteTaskAction } from "@/server/actions/conversations"
import { submitTaskAction } from "@/server/actions/create"
import { toast } from "sonner"
import { ImageViewer, downloadImageFile } from "@/components/ui/image-viewer"

/**
 * 单次生成消息项（自由创作页 §6 v6，扁平聊天消息样式）
 *
 * 结构：
 *   1. 头部：参考图缩略图（点击打开放大查看器；多张时右上角蓝色角标
 *      数量，过期显示感叹号；无参考图不显示占位图标）
 *      + 提示词（恒定 line-clamp-2 最多 2 行；悬停被截断的提示词时，
 *        原位浮现半透明灰底白字矩形框（absolute 悬浮图层，卡片高度不变），
 *        框内前 2 行与原截断文字像素级重合、完整提示词向下延展盖住
 *        meta 行与图片、限高内滚，框内末尾提供「复制提示词」按钮）
 *      + meta 行：模型名称 | 比例 | 详细信息（竖线分隔；比例优先取图片
 *        实测值——auto 任务不再误显 1:1；多图实测比例不一致时不显示；
 *        悬停详细信息弹出「生成时间 / 生成耗时 / 消耗积分」）
 *   2. 图片网格（一行最多 4 张；多图比例不一致时统一为批内最高图比例的
 *      容器，较小图片 object-contain 居中、上下 bg-muted/50 半透明灰填充；
 *      悬浮图片右上角浮现「下载 / 放大」两个圆形按钮，放大打开放大查看器）
 *   3. 操作行：重新编辑 / 重新生成 / 更多（方形小按钮，菜单从按钮右侧弹出）
 *      + 状态（仅非完成态显示徽章：排队中/生成中/失败；完成不渲染）
 */

export interface TaskDetail {
  id: string
  modelId: string | null
  prompt: string
  status: "queued" | "processing" | "completed" | "failed"
  imageSize: string | null
  imageCount: number
  resultImages: string[] | null
  referenceImages: string[] | null
  errorMessage: string | null
  creditsCharged: number | null
  createdAt: Date
  /** 模型开始生成时间（耗时 = completedAt − startedAt；缺省无法计算耗时） */
  startedAt: Date | null
  completedAt: Date | null
  modelDisplayName: string
  modelIconUrl: string | null
}

/** 重新编辑回填内容 */
export interface EditTaskPayload {
  prompt: string
  referenceImages: string[]
}

const STATUS_MAP = {
  queued: { label: "排队中", variant: "outline" as const },
  processing: { label: "生成中", variant: "secondary" as const },
  completed: { label: "完成", variant: "default" as const },
  failed: { label: "失败", variant: "destructive" as const },
}

/** 探测图片 URL 是否仍可访问（参考图被 COS 生命周期清理后失效），带超时兜底 */
function checkImageAlive(url: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const img = new Image()
    const timer = setTimeout(() => done(false), timeoutMs)
    img.onload = () => done(true)
    img.onerror = () => done(false)
    img.src = url
  })
}

/** 生成时间（发送生图请求的时间）：2026-08-19 09:41 */
function formatRequestTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 模型生成耗时：completedAt − startedAt；<60s 一位小数秒，否则 X分Y秒 */
function formatGenerationDuration(ms: number): string {
  if (ms < 0) return "-"
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  // 先取整总秒数再拆分，避免 59.5~60s 四舍五入出「X分60秒」
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}分${total % 60}秒`
}

export function TaskDetailCard({
  task,
  conversationId,
  onEditTask,
}: {
  task: TaskDetail
  /** 所属会话（重新生成时提交用） */
  conversationId: string
  /** 「重新编辑」：将提示词 + 参考图填入当前输入框 */
  onEditTask?: (payload: EditTaskPayload) => void
}) {
  const router = useRouter()
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [regenerating, setRegenerating] = React.useState(false)
  // 第一张参考图是否已过期（缩略图加载失败）
  const [refExpired, setRefExpired] = React.useState(false)
  // 悬停被 2 行截断的提示词时，上方浮现完整提示词矩形框（受控 Tooltip）
  const [promptHover, setPromptHover] = React.useState(false)
  const promptRef = React.useRef<HTMLParagraphElement>(null)
  const thumbRef = React.useRef<HTMLImageElement>(null)
  // 图片放大查看器（图片格悬浮「放大」按钮打开）
  const [viewerOpen, setViewerOpen] = React.useState(false)
  const [viewerIndex, setViewerIndex] = React.useState(0)
  // 参考图放大查看器（点击头部参考图缩略图打开）
  const [refViewerOpen, setRefViewerOpen] = React.useState(false)
  const [refViewerIndex, setRefViewerIndex] = React.useState(0)

  // 补偿检查：错误可能在 React 水合前已触发（onError 丢失），
  // 挂载后直接读取 img 的完成状态判断失败
  React.useEffect(() => {
    const el = thumbRef.current
    if (el && el.complete && el.naturalWidth === 0) {
      setRefExpired(true)
    }
  }, [])

  // 展示上限 32 = 创作页次数上限 4 × 即梦每次 N 上限 8
  const images = (task.resultImages ?? []).slice(0, 32)
  const pending = task.status === "queued" || task.status === "processing"
  // 非进行中任务的缺失张数（全失败 = 全部；部分失败 = 总数 - 成功数），用于失败占位格
  const missingCount = pending
    ? 0
    : Math.max(0, Math.min(task.imageCount, 32) - images.length)
  const status = STATUS_MAP[task.status]
  const { width, height } = parseImageSize(task.imageSize)
  const refImages = task.referenceImages ?? []
  const refThumb = refImages[0] ?? null

  // —— 结果图实测尺寸（onLoad 读取 naturalWidth/Height）——
  // 用于：auto 任务显示真实比例；多图比例不一致时以最高图为基准容器
  const [imgSizes, setImgSizes] = React.useState<
    Record<number, { w: number; h: number }>
  >({})
  const recordImgSize = (i: number, el: HTMLImageElement) => {
    if (el.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
      setImgSizes((prev) =>
        prev[i]
          ? prev
          : { ...prev, [i]: { w: el.naturalWidth, h: el.naturalHeight } },
      )
    }
  }
  const handleImageLoad = (
    i: number,
    e: React.SyntheticEvent<HTMLImageElement>,
  ) => {
    recordImgSize(i, e.currentTarget)
  }

  // 水合时序补偿：SSR HTML 中的 <img> 命中浏览器缓存时，在 React 水合完成前
  // 就已加载完毕，水合后附加的 onLoad 永远不触发 → 尺寸缺失 → 基准容器算不出。
  // ref 回调挂载时同步补查一次（缓存命中多数已 complete），再隔一帧补查解码
  // 稍慢的情况；与 onLoad 双保险（同参考图 refExpired 补偿检查一个模式）
  const measureImgRef = (i: number) => (el: HTMLImageElement | null) => {
    if (!el) return
    recordImgSize(i, el)
    requestAnimationFrame(() => recordImgSize(i, el))
  }

  const measured = images
    .map((_, i) => imgSizes[i])
    .filter((s): s is { w: number; h: number } => Boolean(s))
  const allMeasured = images.length > 0 && measured.length === images.length
  // 比例一致 = 所有图简化比例相同（如全 16:9）
  const ratiosConsistent =
    allMeasured &&
    new Set(measured.map((s) => sizeToRatioLabel(`${s.w}x${s.h}`))).size === 1

  const isAutoSize = !task.imageSize || task.imageSize === "auto"
  // 比例标签：实测一致 → 实际比例（修正 auto 误显 1:1）；
  // 未测完且非 auto → 请求比例；实测不一致或 auto 未测完 → 不显示
  const ratioLabel = ratiosConsistent
    ? sizeToRatioLabel(`${measured[0].w}x${measured[0].h}`)
    : !allMeasured && !isAutoSize
      ? sizeToRatioLabel(task.imageSize)
      : null

  // 基准容器比例：批内最高图（H/W 最大），保证所有较矮图仅上下留白；
  // 小图 object-contain 居中，上下空白由容器 bg-muted/50 半透明灰填充
  const baseline = allMeasured
    ? measured.reduce((a, b) => (b.h / b.w > a.h / a.w ? b : a))
    : null

  async function handleDelete() {
    setDeleting(true)
    const res = await deleteTaskAction(task.id)
    setDeleting(false)
    setConfirmDelete(false)
    if (res.ok) {
      toast.success("已删除")
      router.refresh()
    } else {
      toast.error(res.error ?? "删除失败")
    }
  }

  /** 重新编辑：填回提示词 + 仍可访问的参考图 */
  async function handleEdit() {
    if (refImages.length === 0) {
      onEditTask?.({ prompt: task.prompt, referenceImages: [] })
      return
    }
    if (refExpired) {
      onEditTask?.({ prompt: task.prompt, referenceImages: [] })
      toast.warning("参考图已过期，请重新上传参考图")
      return
    }
    const alive = await Promise.all(
      refImages.map((u) => checkImageAlive(toImageSrc(u))),
    )
    const aliveRefs = refImages.filter((_, i) => alive[i])
    onEditTask?.({ prompt: task.prompt, referenceImages: aliveRefs })
    if (aliveRefs.length < refImages.length) {
      toast.warning("部分参考图已过期，请重新上传")
    }
  }

  /** 重新生成：用原参数重新提交；参考图过期则提示并中止 */
  async function handleRegenerate() {
    if (refImages.length > 0) {
      let expired = refExpired
      if (!expired) {
        const alive = await Promise.all(
          refImages.map((u) => checkImageAlive(toImageSrc(u))),
        )
        expired = alive.some((a) => !a)
      }
      if (expired) {
        toast.warning("参考图已过期，请重新上传参考图后再创建生图任务")
        return
      }
    }

    if (!task.modelId) {
      toast.error("该任务不支持重新生成")
      return
    }
    setRegenerating(true)
    let res: Awaited<ReturnType<typeof submitTaskAction>>
    try {
      res = await submitTaskAction({
        modelId: task.modelId,
        prompt: task.prompt,
        imageSize: task.imageSize ?? "1024x1024",
        imageCount: task.imageCount,
        referenceImages: refImages,
        conversationId,
      })
    } catch {
      // 网络/传输异常：必须恢复按钮状态，否则永久禁用
      setRegenerating(false)
      toast.error("重新生成请求失败，请检查网络后重试")
      return
    }
    setRegenerating(false)
    if (res.ok) {
      toast.success(`已重新提交，消耗 ${res.cost} 积分`)
      router.refresh()
    } else {
      toast.error(res.error ?? "重新生成失败")
    }
  }

  /** 复制提示词到剪贴板（悬停浮层内的「复制提示词」按钮） */
  async function handleCopyPrompt() {
    const ok = await copyText(task.prompt)
    if (ok) {
      setPromptHover(false)
      toast.success("已复制到剪贴板")
    } else {
      toast.error("复制失败，请手动选择复制")
    }
  }

  return (
    <div className="py-5">
      {/* 头部：参考图缩略图（无参考图时不显示占位图标）+ 提示词（2 行截断，
          悬停原位展开）+ meta 行（提示词下方，展开期间隐藏）。
          items-center：参考图与右列（提示词 + meta 行）垂直居中对齐 */}
      <div className="flex items-center gap-2.5">
        {/* 参考图缩略图（点击打开放大查看器；多张时右上角蓝色角标数量；
            过期显示感叹号） */}
        {refThumb && !refExpired ? (
          <button
            type="button"
            onClick={() => {
              setRefViewerIndex(0)
              setRefViewerOpen(true)
            }}
            title="查看参考图"
            className="relative block shrink-0 cursor-zoom-in rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={thumbRef}
              src={toImageSrc(refThumb, { width: 96 })}
              alt="参考图"
              className="size-10 rounded-md border object-cover"
              onError={() => setRefExpired(true)}
            />
            {refImages.length > 1 && (
              <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-blue-600 text-[10px] font-medium tabular-nums text-white shadow-sm">
                {refImages.length}
              </span>
            )}
          </button>
        ) : refThumb && refExpired ? (
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted"
            title="参考图已过期"
          >
            <TriangleAlert className="size-4 text-amber-500" />
          </div>
        ) : null}

        {/* 提示词（恒定 2 行截断；悬停被截断的提示词时，原位浮现半透明灰底
            白字矩形框（absolute 悬浮图层，不占文档流、卡片高度不变）：
            负外边距向外扩出内边距，使框内前 2 行文字与原截断文字像素级
            重合，完整提示词向下延展盖住 meta 行与图片、限高内部滚动，
            框内末尾提供「复制提示词」按钮复制到剪贴板） */}
        <div
          className="relative min-w-0 flex-1"
          onMouseLeave={() => setPromptHover(false)}
        >
          <p
            ref={promptRef}
            className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
            onMouseEnter={() => {
              // 仅提示词被 2 行截断（纵向溢出）时才弹出完整框
              const el = promptRef.current
              if (el && el.scrollHeight > el.clientHeight + 1) {
                setPromptHover(true)
              }
            }}
          >
            {task.prompt}
          </p>
          {promptHover && (
            // 负外边距补偿内边距：框几何边缘外扩（-left/-top/-right），
            // 框内文字区域与原 <p> 内容盒重合 → 前 2 行像素级对齐
            <div className="absolute -left-3 -top-2.5 right-[-12px] z-30 rounded-lg bg-neutral-800/95 px-3 pt-2.5 pb-2.5 text-white shadow-lg duration-150 animate-in fade-in">
              {/* 完整提示词：限高 + 内部滚动（隐藏滚动条），按钮固定框底恒可见 */}
              <div className="max-h-72 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {task.prompt}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCopyPrompt()}
                className="mt-2 inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs font-medium transition-colors hover:bg-white/20"
              >
                <Copy className="size-3.5" />
                复制提示词
              </button>
            </div>
          )}
          {/* meta 行：模型名称 | 比例 | 详细信息（竖线分隔，悬停弹出；
              提示词展开期间被浮层盖住，收起即恢复） */}
          <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{task.modelDisplayName}</span>
            {ratioLabel && (
              <>
                <span className="h-3 w-px bg-border" aria-hidden />
                <span>{ratioLabel}</span>
              </>
            )}
            <span className="h-3 w-px bg-border" aria-hidden />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex cursor-default items-center gap-0.5 transition-colors hover:text-foreground" />
                  }
                >
                  <Info className="size-3" />
                  详细信息
                </TooltipTrigger>
                <TooltipContent side="top" className="space-y-1 text-left text-xs">
                  <p>
                    生成时间 {formatRequestTime(new Date(task.createdAt))}
                  </p>
                  {task.startedAt && task.completedAt ? (
                    <p>
                      生成耗时{" "}
                      {formatGenerationDuration(
                        new Date(task.completedAt).getTime() -
                          new Date(task.startedAt).getTime(),
                      )}
                    </p>
                  ) : null}
                  <p>消耗积分 {task.creditsCharged ?? "-"}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </span>
        </div>
      </div>

      {/* 图片网格（一行最多 4 张；全部加载后统一为批内最高图比例的容器，
          较小图 object-contain 居中、上下 bg-muted/50 半透明灰填充；
          加载完成前按自然高度显示，避免跳动。
          非进行中任务的缺失张以 1:1 失败占位格补齐（感叹号 + 生成失败） */}
      {images.length > 0 || (!pending && missingCount > 0) ? (
        <div
          className="mt-2 grid items-start gap-1.5"
          style={{ gridTemplateColumns: `repeat(4, minmax(0, 1fr))` }}
        >
          {images.map((url, i) => (
            <div
              key={i}
              className="group relative overflow-hidden rounded-md border bg-muted/50"
              style={
                baseline
                  ? { aspectRatio: `${baseline.w} / ${baseline.h}` }
                  : undefined
              }
            >
              <SmartImage
                ref={measureImgRef(i)}
                src={toImageSrc(url, { width: 400 })}
                alt={`生成图 ${i + 1}`}
                className={baseline ? "size-full object-contain" : "w-full"}
                loading="lazy"
                onLoad={(e) => handleImageLoad(i, e)}
              />
              {/* 悬浮右上角操作：下载 / 放大（打开放大查看器） */}
              <div className="absolute right-1 top-1 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                <button
                  type="button"
                  title="下载"
                  onClick={() =>
                    downloadImageFile(url, `hanxing-${Date.now()}-${i + 1}`)
                  }
                  className="flex size-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                >
                  <Download className="size-3.5" />
                </button>
                <button
                  type="button"
                  title="放大"
                  onClick={() => {
                    setViewerIndex(i)
                    setViewerOpen(true)
                  }}
                  className="flex size-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                >
                  <Maximize2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
          {Array.from({ length: missingCount }).map((_, i) => (
            <div
              key={`failed-${i}`}
              className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed bg-muted/40 text-muted-foreground"
              style={{ aspectRatio: "1 / 1" }}
            >
              <AlertCircle className="size-5 text-destructive/70" />
              <span className="text-xs">生成失败</span>
            </div>
          ))}
        </div>
      ) : pending ? (
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {Array.from({ length: Math.min(task.imageCount, 32) }).map((_, i) => (
            <ImageGeneration
              key={i}
              showMeta={false}
              ratio={`${width} / ${height}`}
              resolution={isAutoSize ? "智能" : `${width} × ${height}`}
            />
          ))}
        </div>
      ) : null}

      {/* 失败错误信息 / 部分失败提示（completed 但有失败张：已按张退款） */}
      {task.status === "failed" && task.errorMessage ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{task.errorMessage.slice(0, 120)}</span>
        </div>
      ) : task.status === "completed" && task.errorMessage ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{task.errorMessage.slice(0, 120)}</span>
        </div>
      ) : null}

      {/* 操作行：重新编辑 / 重新生成 / 更多（删除菜单从更多按钮右侧弹出） + 状态 */}
      <div className="mt-3 flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 rounded-md border-border/60 bg-card/80 px-3 text-xs shadow-sm hover:bg-accent"
          onClick={() => void handleEdit()}
        >
          <PencilLine className="size-3.5" />
          重新编辑
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 rounded-md border-border/60 bg-card/80 px-3 text-xs shadow-sm hover:bg-accent"
          onClick={() => void handleRegenerate()}
          disabled={pending || regenerating}
        >
          {regenerating ? (
            <MorphingInfinity className="size-3.5" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          重新生成
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-card/80 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            title="更多操作"
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          {/* 弹层去掉默认 p-1 内边距：总高与「更多」按钮（h-8=32px）一致，
              菜单项撑满弹层并以 rounded-lg 对齐弹层圆角 */}
          <DropdownMenuContent
            side="right"
            align="start"
            className="w-36 p-0"
            positionerClassName="z-40"
          >
            <DropdownMenuItem
              variant="destructive"
              className="h-8 rounded-lg"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
              删除该批次结果
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 状态徽章：仅非完成态显示（进行中/失败仍提示；完成态不渲染）；
            h-8 与左侧操作按钮齐高 */}
        {task.status !== "completed" && (
          <Badge variant={status.variant} className="ml-auto h-8">
            {pending && <MorphingInfinity className="mr-1 size-3" />}
            {status.label}
          </Badge>
        )}
      </div>

      {/* 删除确认弹窗 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除该批次结果？</DialogTitle>
            <DialogDescription>
              将永久删除这次生成的图片和记录。积分不退还（已消费算沉没成本）。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <>
                  <MorphingInfinity className="mr-1 size-4" />
                  删除中
                </>
              ) : (
                "确认删除"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 放大查看器：图片格悬浮「放大」按钮打开（旋转/缩放/拖拽/下载/信息面板） */}
      <ImageViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        images={images}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        info={{
          model: task.modelDisplayName,
          prompt: task.prompt,
          createdAt: task.createdAt,
        }}
      />

      {/* 参考图放大查看器：点击头部参考图缩略图打开（可左右切换全部参考图） */}
      <ImageViewer
        open={refViewerOpen}
        onOpenChange={setRefViewerOpen}
        images={refImages}
        index={refViewerIndex}
        onIndexChange={setRefViewerIndex}
        info={{ prompt: task.prompt, createdAt: task.createdAt }}
      />
    </div>
  )
}
