"use client"

import * as React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { AtSign, Loader2, TriangleAlert, X } from "lucide-react"
import { toast } from "sonner"
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputStatus,
} from "@/components/ui/ai-chat-input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { BeamWrapper } from "@/components/create/beam-wrapper"
import { ChatModelPicker } from "@/components/chat/chat-model-picker"
import { ThinkingEffortSlider } from "@/components/chat/thinking-effort-slider"
import { ContextRing } from "@/components/chat/context-ring"
import { uploadImage } from "@/lib/upload/upload-image"
import type { ChatModelCard, ThinkingLevel } from "@/components/chat/types"

/**
 * AI 对话输入框（改造自生图 CreatePromptInput）
 *
 * 基于 ai-chat-input 组合式 PromptInput + BeamWrapper 光效：
 * - @ 图片上传（仅 supportsVision 多模态模型可点；未开启禁用 + Tooltip 说明）
 * - 模型切换（图标 + 名称 + 徽章 + 价格摘要）
 * - 思考强度（仅 supportsThinking 模型渲染；档位随会话持久化）
 * - 上下文已用进度环（弧长 = contextTokens / maxContextTokens）
 * - 流式中提交按钮变停止按钮（PromptInput 自带 onStop 语义）
 * - 文本草稿 localStorage 持久化（chat:input-draft:text；图片附件不持久化）
 */

const TEXT_DRAFT_KEY = "chat:input-draft:text"

/** 单条消息图片上限（与 sendChatMessageSchema.images.max 一致） */
const MAX_CHAT_IMAGES = 4
/** 单张图片大小上限（与服务端 /api/upload 白名单一致） */
const MAX_FILE_SIZE = 20 * 1024 * 1024

interface ChatAttachment {
  id: string
  file: File
  /** 本地预览 URL（objectURL，卸载时 revoke） */
  previewUrl: string
  /** 上传完成后的存储 URL */
  remoteUrl: string | null
  status: "uploading" | "done" | "error"
}

function loadTextDraft(): string {
  if (typeof window === "undefined") return ""
  try {
    return localStorage.getItem(TEXT_DRAFT_KEY) ?? ""
  } catch {
    return ""
  }
}

export function ChatInput({
  models,
  modelId,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  contextTokens,
  isStreaming,
  onSubmit,
  onStop,
  focusNonce,
}: {
  models: ChatModelCard[]
  modelId: string
  onModelChange: (id: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange: (level: ThinkingLevel) => void
  contextTokens: number
  isStreaming: boolean
  /** 提交（文本或图片至少一项）；抛错时输入框保留内容便于重试 */
  onSubmit: (text: string, images: string[]) => Promise<void>
  onStop: () => void
  /** 变化时聚焦输入框 */
  focusNonce?: number
}) {
  const [beamHovered, setBeamHovered] = React.useState(false)
  const [beamFocused, setBeamFocused] = React.useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // —— 图片附件（上传中/完成/失败三态；失败可点击重试）——
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const fileInputIdRef = useRef(0)
  // 卸载时释放 objectURL
  const previewUrlsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const urls = previewUrlsRef.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [])

  // 当前文本（驱动提交按钮可用态；纯图消息允许空文本）
  const [currentText, setCurrentText] = useState("")

  // 初始文本（草稿恢复）经 key 重挂载以 defaultValue 声明式写入
  //（原理同生图输入框：BeamWrapper 懒加载换树会丢弃命令式赋值）
  const [initialText, setInitialText] = useState<string | null>(null)
  const draftRestoredRef = useRef(false)
  useEffect(() => {
    if (draftRestoredRef.current) return
    draftRestoredRef.current = true
    const draft = loadTextDraft()
    if (draft) setInitialText(draft)
  }, [])

  // 防抖草稿
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleDraftSave = useCallback((text: string) => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(TEXT_DRAFT_KEY, text)
      } catch {
        // 存储满/隐私模式静默失败
      }
    }, 400)
  }, [])
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (focusNonce) textareaRef.current?.focus()
  }, [focusNonce])

  const selectedModel = models.find((m) => m.id === modelId)
  const hasModels = models.length > 0
  const visionEnabled = selectedModel?.supportsVision ?? false

  const doneImages = attachments
    .filter((a) => a.status === "done" && a.remoteUrl)
    .map((a) => a.remoteUrl!)
  const uploading = attachments.some((a) => a.status === "uploading")
  const canSubmit =
    (currentText.trim().length > 0 || doneImages.length > 0) && !isStreaming

  const status: PromptInputStatus = isStreaming ? "streaming" : "ready"

  async function uploadAttachment(id: string, file: File) {
    try {
      const url = await uploadImage(file)
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, remoteUrl: url, status: "done" } : a,
        ),
      )
    } catch (err) {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "error" } : a)),
      )
      toast.error(
        `${file.name}：上传失败${err instanceof Error ? `（${err.message}）` : ""}`,
      )
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = "" // 重置以便重复选择同一文件
    if (files.length === 0 || !visionEnabled) return

    const remaining = MAX_CHAT_IMAGES - attachments.length
    if (remaining <= 0) {
      toast.error(`最多上传 ${MAX_CHAT_IMAGES} 张图片`)
      return
    }

    // 逐文件校验格式 + 大小（与服务端 /api/upload 白名单一致）
    const validFiles: File[] = []
    for (const file of files) {
      const name = file.name.toLowerCase()
      const isAllowedType =
        file.type === "image/png" ||
        file.type === "image/jpeg" ||
        file.type === "image/webp" ||
        file.type === "image/gif" ||
        name.endsWith(".png") ||
        name.endsWith(".jpg") ||
        name.endsWith(".jpeg") ||
        name.endsWith(".webp") ||
        name.endsWith(".gif")
      if (!isAllowedType) {
        toast.error(`${file.name}：格式不支持，仅支持 PNG / JPEG / WEBP / GIF`)
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`${file.name}：大小超过 20MB`)
        continue
      }
      validFiles.push(file)
    }
    if (validFiles.length === 0) return

    const toUpload = validFiles.slice(0, remaining)
    if (validFiles.length > remaining) {
      toast.warning(`仅上传前 ${remaining} 张，已达图片上限 ${MAX_CHAT_IMAGES}`)
    }

    const newItems: ChatAttachment[] = toUpload.map((file) => {
      const previewUrl = URL.createObjectURL(file)
      previewUrlsRef.current.add(previewUrl)
      return {
        id: `att-${Date.now()}-${fileInputIdRef.current++}`,
        file,
        previewUrl,
        remoteUrl: null,
        status: "uploading",
      }
    })
    setAttachments((prev) => [...prev, ...newItems])
    // 逐张串行上传（与生图参考图一致，避免并发抢占带宽）
    for (const item of newItems) {
      await uploadAttachment(item.id, item.file)
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target) {
        URL.revokeObjectURL(target.previewUrl)
        previewUrlsRef.current.delete(target.previewUrl)
      }
      return prev.filter((a) => a.id !== id)
    })
  }

  async function handleSubmit(message: { text: string }) {
    const text = message.text.trim()
    if (isStreaming) return
    if (uploading) {
      toast.info("图片上传中，请稍候")
      throw new Error("图片上传中")
    }
    if (!text && doneImages.length === 0) return
    await onSubmit(text, doneImages)
    // 成功：清空草稿（文本已被 form.reset 清空）与附件
    try {
      localStorage.setItem(TEXT_DRAFT_KEY, "")
    } catch {
      // ignore
    }
    setAttachments((prev) => {
      for (const a of prev) {
        URL.revokeObjectURL(a.previewUrl)
        previewUrlsRef.current.delete(a.previewUrl)
      }
      return []
    })
  }

  if (!hasModels) {
    return (
      <div className="flex h-32 items-center justify-center rounded-3xl border border-dashed text-sm text-muted-foreground">
        暂无可用对话模型，请联系管理员配置
      </div>
    )
  }

  const beamActive = beamHovered || beamFocused || isStreaming

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
        onSubmit={handleSubmit}
        status={status}
        onStop={onStop}
        allowEmptySubmit
        className="rounded-3xl"
      >
        {/* 左上方：@ 图片上传按钮 + 附件缩略图（与自由创作输入框同布局） */}
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-disabled={!visionEnabled}
                    onClick={
                      visionEnabled
                        ? () => fileInputRef.current?.click()
                        : undefined
                    }
                    className={
                      visionEnabled
                        ? "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none"
                        : "inline-flex size-8 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-muted-foreground opacity-50"
                    }
                  />
                }
              >
                <AtSign className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="top">
                {visionEnabled
                  ? `上传图片（最多 ${MAX_CHAT_IMAGES} 张）`
                  : "当前模型未开启多模态，无法上传图片"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* 隐藏的文件选择 input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* 附件缩略图（上传中 spinner / 失败可点击重试 / 悬停删除） */}
          {attachments.map((a) => (
            <div
              key={a.id}
              className="group relative size-14 shrink-0 overflow-hidden rounded-lg border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={a.previewUrl}
                alt={a.file.name}
                className="size-full object-cover"
              />
              {a.status === "uploading" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <Loader2 className="size-4 animate-spin text-white" />
                </div>
              ) : a.status === "error" ? (
                <button
                  type="button"
                  onClick={() => {
                    setAttachments((prev) =>
                      prev.map((x) =>
                        x.id === a.id ? { ...x, status: "uploading" } : x,
                      ),
                    )
                    void uploadAttachment(a.id, a.file)
                  }}
                  className="absolute inset-0 flex items-center justify-center bg-destructive/70"
                  aria-label="上传失败，点击重试"
                >
                  <TriangleAlert className="size-4 text-white" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="移除图片"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>

        <PromptInputBody>
          <PromptInputTextarea
            key={initialText ?? "empty"}
            ref={textareaRef}
            defaultValue={initialText ?? ""}
            onChange={(e) => {
              setCurrentText(e.target.value)
              scheduleDraftSave(e.target.value)
            }}
            placeholder='输入消息，Enter 发送，Shift+Enter 换行；"@"可上传图片'
            maxLength={20000}
            disabled={isStreaming}
          />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {/* 模型切换 */}
            <ChatModelPicker models={models} value={modelId} onChange={onModelChange} />

            {/* 思考强度滑杆（仅支持思考的模型；off + 六档，随会话持久化） */}
            {selectedModel?.supportsThinking ? (
              <ThinkingEffortSlider
                value={thinkingLevel}
                onChange={onThinkingLevelChange}
              />
            ) : null}

            {/* 上下文已用进度环 */}
            <ContextRing
              usedTokens={contextTokens}
              maxTokens={selectedModel?.maxContextTokens ?? 32768}
            />
          </PromptInputTools>

          {/* 右侧：提交/停止按钮 */}
          <div className="flex items-center">
            <PromptInputSubmit status={status} onStop={onStop} disabled={!canSubmit} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </BeamWrapper>
  )
}
