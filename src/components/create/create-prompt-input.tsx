"use client"

import * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AtSign, Sparkle, X } from "lucide-react"
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputStatus,
} from "@/components/ui/ai-chat-input"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { ModelPickerPopover } from "@/components/create/model-picker-popover"
import { SizePickerPopover } from "@/components/create/size-picker-popover"
import { CreditsRing } from "@/components/create/credits-ring"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { submitTaskAction } from "@/server/actions/create"
import { toast } from "sonner"
import { cn, toImageSrc } from "@/lib/utils"
import { uploadImage } from "@/lib/upload/upload-image"
import { resolveSizePresets } from "@/lib/image-sizes"
import { SmartImage } from "@/components/ui/smart-image"
import type { CreateModel } from "@/components/create/types"

/** 单张参考图大小上限 */
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * 输入栏草稿本地缓存（浏览器 localStorage）。
 *
 * 组件在切换会话、输入栏收起/展开、新对话↔会话切换时都会重挂载，
 * 本地 state 全部归零；草稿落盘后挂载时恢复，输入内容与模型/尺寸/数量
 * 选择跨重挂载（含刷新页面）保留。null 字段 = 从未存储过。
 */
const INPUT_DRAFT_STORAGE_KEY = "create:input-draft"

interface InputDraft {
  modelId: string | null
  imageSize: string | null
  imageCount: number | null
  referenceImages: string[] | null
  text: string
}

const EMPTY_DRAFT: InputDraft = {
  modelId: null,
  imageSize: null,
  imageCount: null,
  referenceImages: null,
  text: "",
}

function loadInputDraft(): InputDraft {
  if (typeof window === "undefined") return EMPTY_DRAFT
  try {
    const raw = localStorage.getItem(INPUT_DRAFT_STORAGE_KEY)
    if (!raw) return EMPTY_DRAFT
    return { ...EMPTY_DRAFT, ...JSON.parse(raw) }
  } catch {
    return EMPTY_DRAFT
  }
}

function saveInputDraft(draft: InputDraft) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(INPUT_DRAFT_STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // 存储满/隐私模式静默失败
  }
}

/**
 * 生图输入框（自由创作页 §6 v2）
 *
 * 基于 ai-chat-input 的 ChatGPT 风格组合式 PromptInput 封装：
 * - 提示词输入（Enter 提交 / Shift+Enter 换行）
 * - @ 参考图上传（左上方圆形按钮，点击直接打开文件选择框；缩略图显示在后方）
 * - 模型选择（ModelPickerPopover，卡片列表）
 * - 尺寸/数量（SizePickerPopover 合并面板：比例横排 + 智能 + 数量 + 自定义尺寸）
 * - 积分进度环（CreditsRing，位于尺寸选择器右侧）
 * - 外层 colorful border-beam 光效（悬停/聚焦/生成中激活）
 * - 输入草稿本地缓存（create:input-draft）：文本/模型/尺寸/数量/参考图
 *   跨重挂载（切换会话、收起展开）与刷新保留；提交成功清空文本
 *
 * onSubmit → submitTaskAction({ ..., conversationId })
 * 未传 conversationId 时自动建会话，通过 onConversationCreated 回调通知。
 */
export function CreatePromptInput({
  models,
  userCredits,
  enterpriseCredits,
  conversationId,
  onConversationCreated,
  prefill,
  focusNonce,
}: {
  models: CreateModel[]
  userCredits: number
  enterpriseCredits: number
  /** 所属会话；未传=新对话模式（提交时自动建会话） */
  conversationId?: string
  /** 新对话首次提交后回调（切换选中到新会话） */
  onConversationCreated?: (id: string) => void
  /** 预填内容（使用提示词 / 重新编辑），nonce 变化时应用 */
  prefill?: { text: string; referenceImages?: string[]; nonce: number } | null
  /** 变化时聚焦输入框（展开收起条后聚焦用） */
  focusNonce?: number
}) {
  const router = useRouter()

  // 表单状态
  const [modelId, setModelId] = useState(models[0]?.id ?? "")
  const [imageSize, setImageSize] = useState("1024x1024")
  const [imageCount, setImageCount] = useState(1)
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)

  // 任务状态
  const [status, setStatus] = useState<PromptInputStatus>("ready")
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Border Beam 激活状态（悬停/聚焦/生成中）
  const [beamHovered, setBeamHovered] = useState(false)
  const [beamFocused, setBeamFocused] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 初始文本（草稿恢复 / 重新编辑预填）经 key 重挂载以 defaultValue 声明式写入。
  // 不能用命令式 textarea.value 赋值：BeamWrapper 懒加载 BorderBeam 时
  // Suspense 从 fallback 树换到正式树会整体重建子树 DOM，命令式赋值随旧
  // 节点丢弃（defaultValue 兜底为空 → 刷新后草稿文本“消失”）
  const [initialText, setInitialText] = useState<{
    text: string
    nonce: string | number
  } | null>(null)

  // —— 草稿持久化 ——
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftPatchRef = useRef<Partial<InputDraft>>({})

  // 防抖合并写入：多个触发点（配置 state / 文本 onChange / prefill）的
  // patch 先累积，400ms 后与已存草稿 read-merge-write，互不覆盖
  const scheduleDraftSave = useCallback((patch: Partial<InputDraft>) => {
    draftPatchRef.current = { ...draftPatchRef.current, ...patch }
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      saveInputDraft({ ...loadInputDraft(), ...draftPatchRef.current })
      draftPatchRef.current = {}
    }, 400)
  }, [])

  // 立即落盘：先合并 pending patch 再叠加显式 patch（提交成功清空文本用）
  const flushDraftSave = useCallback((patch: Partial<InputDraft> = {}) => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    saveInputDraft({
      ...loadInputDraft(),
      ...draftPatchRef.current,
      ...patch,
    })
    draftPatchRef.current = {}
  }, [])

  // 挂载后恢复草稿（不用 lazy useState 初始化：modelId/imageSize 影响首帧
  // 文本，lazy 读 localStorage 会造成 SSR 水合不一致；ref 守卫保证只跑一次，
  // 覆盖切换会话/收起展开的重挂载场景）
  const draftRestoredRef = useRef(false)
  useEffect(() => {
    if (draftRestoredRef.current) return
    draftRestoredRef.current = true
    const draft = loadInputDraft()

    const targetModel =
      draft.modelId && models.some((m) => m.id === draft.modelId)
        ? models.find((m) => m.id === draft.modelId)
        : models[0]
    if (targetModel) setModelId(targetModel.id)
    if (draft.imageSize) setImageSize(draft.imageSize)
    if (targetModel?.supportsImageCount && draft.imageCount && draft.imageCount > 0) {
      setImageCount(draft.imageCount)
    }
    if (draft.referenceImages?.length) {
      setReferenceImages(
        draft.referenceImages.slice(0, targetModel?.maxReferenceImages ?? 0),
      )
    }
    // 文本：prefill（使用提示词/重新编辑）优先于草稿；经 initialText 触发
    // textarea 重挂载以 defaultValue 写入，对后续 DOM 重建免疫
    if (!prefill && draft.text) {
      setInitialText({ text: draft.text, nonce: `draft-${Date.now()}` })
    }
  }, [models, prefill])

  // 配置变化写入草稿（切换模型触发的参考图清空/数量重置经由 state 自动同步）。
  // 跳过挂载首跑：首跑携带的是默认值而非恢复值，写入会覆盖已存草稿
  // （恢复 setState 触发的重跑会以恢复值做一次无害写回）。
  const configSavedRef = useRef(false)
  useEffect(() => {
    if (!configSavedRef.current) {
      configSavedRef.current = true
      return
    }
    scheduleDraftSave({ modelId, imageSize, imageCount, referenceImages })
  }, [modelId, imageSize, imageCount, referenceImages, scheduleDraftSave])

  // 卸载/页面卸载前落盘 pending 补丁：上滑收起卸载组件、或浏览器刷新/关闭时，
  // 防抖窗口内尚未写入的最后操作（如删参考图后立刻刷新）会丢失，重新打开时
  // 表现为已删除内容“复活”。React 的卸载 cleanup 不会在浏览器 unload 时执行，
  // 需额外监听 pagehide。StrictMode 假卸载无 pending 补丁，落盘幂等无害。
  useEffect(() => {
    const onPageHide = () => flushDraftSave()
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      flushDraftSave()
    }
  }, [flushDraftSave])

  // 预填应用（使用提示词 / 重新编辑）。textarea 用 key+defaultValue 重挂载写入
  // 初始文本（对组件重挂载鲁棒），这里只负责参考图回填；同步预填内容到草稿，
  // 使后续重挂载（切换会话再回来）显示的仍是最近一次预填文本。
  useEffect(() => {
    if (!prefill) return
    if (prefill.referenceImages) {
      setReferenceImages(prefill.referenceImages)
    }
    setInitialText({ text: prefill.text, nonce: prefill.nonce })
    scheduleDraftSave({
      text: prefill.text,
      ...(prefill.referenceImages
        ? { referenceImages: prefill.referenceImages }
        : {}),
    })
  }, [prefill, scheduleDraftSave])

  // 外部触发聚焦（紧凑条展开后）
  useEffect(() => {
    if (focusNonce) textareaRef.current?.focus()
  }, [focusNonce])

  const selectedModel = models.find((m) => m.id === modelId)
  const maxRef = selectedModel?.maxReferenceImages ?? 0
  const supportsCount = selectedModel?.supportsImageCount ?? false
  const supportsAuto = selectedModel?.supportsSmartSize ?? false
  const sizePresets = useMemo(
    () => resolveSizePresets(selectedModel?.sizePresets, { includeDisabled: true }),
    [selectedModel?.sizePresets],
  )
  const totalCost = (selectedModel?.costPerImage ?? 0) * imageCount
  const canAfford = totalCost <= userCredits
  const hasModels = models.length > 0

  // 当前尺寸若命中一个被关闭的预设（含初始加载与切换模型），
  // 回退到首个启用预设。注意：自定义尺寸（未命中任何预设）保持不动。
  useEffect(() => {
    if (!selectedModel) return
    if (imageSize === "auto") {
      if (!supportsAuto) {
        const enabled = resolveSizePresets(selectedModel.sizePresets)
        setImageSize(enabled[0]?.value ?? "1024x1024")
      }
      return
    }
    const current = sizePresets.find((s) => s.value === imageSize)
    if (current && !current.enabled) {
      const enabled = resolveSizePresets(selectedModel.sizePresets)
      setImageSize(enabled[0]?.value ?? imageSize)
    }
  }, [selectedModel, imageSize, supportsAuto, sizePresets])

  function handleModelChange(id: string) {
    const next = models.find((m) => m.id === id)
    setModelId(id)
    setReferenceImages([])
    // 切换模型后，若新模型不支持数量选择则重置为 1
    if (!next?.supportsImageCount) setImageCount(1)
    // 若当前是「智能(auto)」但新模型不支持智能比例，则回退到首个预设
    if (imageSize === "auto" && !next?.supportsSmartSize) {
      const presets = resolveSizePresets(next?.sizePresets)
      setImageSize(presets[0]?.value ?? "1024x1024")
    }
  }

  // 参考图文件选择 + 验证 + 上传
  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = "" // 重置以便重复选择同一文件
    if (files.length === 0) return

    const remaining = maxRef - referenceImages.length
    if (remaining <= 0) {
      toast.error(`最多上传 ${maxRef} 张参考图`)
      return
    }

    // 逐文件验证格式 + 大小（与服务端 /api/upload 白名单一致）
    const validFiles: File[] = []
    for (const file of files) {
      const ext = file.name.toLowerCase()
      const isAllowedType =
        file.type === "image/png" ||
        file.type === "image/jpeg" ||
        file.type === "image/webp" ||
        file.type === "image/gif" ||
        ext.endsWith(".png") ||
        ext.endsWith(".jpg") ||
        ext.endsWith(".jpeg") ||
        ext.endsWith(".webp") ||
        ext.endsWith(".gif")
      if (!isAllowedType) {
        toast.error(`${file.name}：格式不支持，仅支持 PNG / JPEG / WEBP / GIF`)
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`${file.name}：大小超过 10MB`)
        continue
      }
      validFiles.push(file)
    }

    if (validFiles.length === 0) return

    // 限制到剩余配额
    const toUpload = validFiles.slice(0, remaining)
    if (validFiles.length > remaining) {
      toast.warning(`仅上传前 ${remaining} 张，已达参考图上限 ${maxRef}`)
    }

    // 逐文件上传
    setUploading(true)
    const newUrls: string[] = []
    for (const file of toUpload) {
      try {
        const url = await uploadImage(file)
        newUrls.push(url)
      } catch {
        toast.error(`${file.name}：上传失败`)
      }
    }
    setUploading(false)

    if (newUrls.length > 0) {
      setReferenceImages((prev) => [...prev, ...newUrls])
    }
  }

  function removeReferenceImage(index: number) {
    setReferenceImages((prev) => prev.filter((_, i) => i !== index))
  }

  // 实际的提交处理（由 PromptInput 的 onSubmit 调用）
  const handlePromptSubmit = React.useCallback(
    async (message: { text: string }) => {
      const text = message.text.trim()
      if (!text) return
      if (!canAfford) {
        toast.error(`积分不足，需要 ${totalCost}，当前余额 ${userCredits}`)
        // 抛出以阻止 PromptInput 的 form.reset() 清空输入（草稿随之保留）
        throw new Error("积分不足")
      }

      setSubmitting(true)
      setStatus("submitted")

      let res: Awaited<ReturnType<typeof submitTaskAction>>
      try {
        res = await submitTaskAction({
          modelId,
          prompt: text,
          imageSize,
          imageCount,
          referenceImages,
          conversationId,
        })
      } catch {
        // 网络/传输异常：必须恢复可编辑状态，否则输入区永久禁用
        setSubmitting(false)
        setStatus("error")
        toast.error("提交请求失败，请检查网络后重试")
        setTimeout(() => setStatus("ready"), 1500)
        // 抛出阻止 form.reset()，保留输入便于重试
        throw new Error("提交请求失败")
      }

      setSubmitting(false)

      if (res.ok) {
        toast.success(
          `已提交，消耗 ${res.cost} 积分（并发上限 ${res.effectiveMaxConcurrent}）`,
        )
        setActiveTaskId(res.taskId ?? null)
        setReferenceImages([])
        // 文本已被 form.reset() 清空，草稿同步清空
        flushDraftSave({ text: "" })
        // 新对话首次提交：切换到新建的会话
        if (!conversationId && res.conversationId && onConversationCreated) {
          onConversationCreated(res.conversationId)
        }
        router.refresh()
      } else {
        setStatus("error")
        toast.error(res.error ?? "提交失败")
        setTimeout(() => setStatus("ready"), 1500)
        // 失败保留输入便于修改重试（阻止 form.reset()；草稿仍持有文本）
        throw new Error(res.error ?? "提交失败")
      }
    },
      [
        modelId,
        imageSize,
        imageCount,
        referenceImages,
        conversationId,
        canAfford,
        totalCost,
        userCredits,
        onConversationCreated,
        router,
        flushDraftSave,
      ],
  )

  // 提交后轮询任务结果（有次数上限；会话过期立即停止，不再无限轮询）
  useEffect(() => {
    if (!activeTaskId) return
    let stopped = false
    let attempts = 0
    // 3s × 400 = 20 分钟：覆盖最慢任务（taskTimeout 默认 300s + 自动重试排队）
    const MAX_ATTEMPTS = 400

    const stopPolling = (message: string) => {
      toast.error(message)
      setStatus("ready")
      setActiveTaskId(null)
    }

    const poll = async () => {
      attempts++
      if (attempts > MAX_ATTEMPTS) {
        stopPolling("任务状态查询超时，请稍后刷新页面查看结果")
        return
      }
      try {
        const resp = await fetch(`/api/tasks/${activeTaskId}/result`)
        // 中间件把未登录请求重定向到 /login 时，fetch 跟随后返回 200 HTML
        const contentType = resp.headers.get("content-type") ?? ""
        if (contentType.includes("text/html")) {
          stopPolling("登录状态已过期，请重新登录")
          return
        }
        if (!resp.ok) return
        const data = (await resp.json()) as {
          status: string
          errorMessage?: string | null
        }
        if (stopped) return

        if (data.status === "completed") {
          toast.success("生成完成")
          setStatus("ready")
          setActiveTaskId(null)
          router.refresh()
        } else if (data.status === "failed") {
          toast.error(data.errorMessage?.slice(0, 80) ?? "生成失败")
          setStatus("ready")
          setActiveTaskId(null)
          router.refresh()
        }
      } catch {
        // 网络抖动忽略，由次数上限兜底
      }
    }

    void poll()
    const timer = setInterval(poll, 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [activeTaskId, router])

  if (!hasModels) {
    return (
      <div className="flex h-32 items-center justify-center rounded-3xl border border-dashed text-sm text-muted-foreground">
        暂无可用模型，请联系管理员配置
      </div>
    )
  }

  const supportsRef =
    selectedModel?.supportsReferenceImage &&
    selectedModel.maxReferenceImages > 0

  // @ 参考图按钮禁用态 + 对应 Tooltip 文案
  const refDisabled =
    !supportsRef || uploading || referenceImages.length >= maxRef
  const refTooltip = !supportsRef
    ? "当前模型未开启参考图"
    : uploading
      ? "上传中…"
      : referenceImages.length >= maxRef
        ? `参考图已达上限（${maxRef} 张）`
        : "上传参考图"

  const isGenerating = status === "submitted" || status === "streaming"
  const beamActive = beamHovered || beamFocused || isGenerating

  return (
    <BeamWrapper
      active={beamActive}
      colorVariant="colorful"
      size="md"
      borderRadius={24}
      onMouseEnter={() => setBeamHovered(true)}
      onMouseLeave={() => setBeamHovered(false)}
      onFocus={() => setBeamFocused(true)}
      onBlur={() => setBeamFocused(false)}
    >
      <PromptInput
        onSubmit={handlePromptSubmit}
        status={status}
        className="rounded-3xl"
      >
        {/* 左上方：@ 参考图按钮 + 缩略图（@ 按钮始终渲染，Tooltip 提示状态） */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-disabled={refDisabled}
                    onClick={
                      refDisabled
                        ? undefined
                        : () => fileInputRef.current?.click()
                    }
                    className={cn(
                      "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none",
                      refDisabled &&
                        "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
                    )}
                  />
                }
              >
                {uploading ? (
                  <MorphingInfinity className="size-4" />
                ) : (
                  <AtSign className="size-4" />
                )}
              </TooltipTrigger>
              <TooltipContent side="top">{refTooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* 参考图缩略图（悬停在对话框上方显示放大预览，渐入渐出） */}
          {referenceImages.map((url, i) => (
            <TooltipProvider key={url + i}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="group relative size-8 shrink-0 overflow-hidden rounded-md border" />
                  }
                >
                  <SmartImage
                    src={toImageSrc(url)}
                    alt=""
                    className="size-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeReferenceImage(i)}
                    className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="size-3.5 text-white" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  sideOffset={16}
                  arrow={false}
                  className="max-w-sm p-0.5"
                >
                  <SmartImage
                    src={toImageSrc(url)}
                    alt="参考图预览"
                    className="max-h-72 max-w-sm rounded object-contain"
                  />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ))}

          {/* 隐藏的文件选择 input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>

        {/* 文本输入区（key 随 initialText 变化 → 重挂载以 defaultValue 声明式
            写入草稿恢复/预填文本；onChange 持久化草稿） */}
        <PromptInputBody>
          <PromptInputTextarea
            key={initialText ? initialText.nonce : (prefill?.nonce ?? "empty")}
            ref={textareaRef}
            defaultValue={initialText ? initialText.text : (prefill?.text ?? "")}
            onChange={(e) => scheduleDraftSave({ text: e.target.value })}
            placeholder={'输入文字"@"上传参考图片，描述你想生成的图片。'}
            maxLength={4000}
            disabled={submitting}
          />
        </PromptInputBody>

        {/* 底部工具栏 */}
        <PromptInputFooter>
          <PromptInputTools>
            {/* 模型选择 */}
            <ModelPickerPopover
              models={models}
              value={modelId}
              onChange={handleModelChange}
            />

            {/* 尺寸 + 数量 + 自定义尺寸（合并面板） */}
            <SizePickerPopover
              presets={sizePresets}
              supportsAuto={supportsAuto}
              value={imageSize}
              onSizeChange={setImageSize}
              supportsCount={supportsCount}
              count={imageCount}
              onCountChange={setImageCount}
            />

            {/* 积分进度环（位于尺寸选择器右侧） */}
            <CreditsRing
              userBalance={userCredits}
              enterpriseBalance={enterpriseCredits}
            />
          </PromptInputTools>

          {/* 右侧：四芒星 + 消耗提示 + 提交按钮 */}
          <div className="flex items-center gap-1.5">
            <Sparkle className="size-3.5 fill-primary text-primary" />
            <span className="text-xs text-muted-foreground tabular-nums">
              {totalCost} 积分
            </span>
            <PromptInputSubmit
              status={status}
              disabled={submitting || !canAfford}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </BeamWrapper>
  )
}
