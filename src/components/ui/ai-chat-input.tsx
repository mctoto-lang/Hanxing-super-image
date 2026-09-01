"use client"

import * as React from "react"
import { ArrowUp, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"

/**
 * PromptInput — ChatGPT 风格的组合式输入框（参考 AI Elements PromptInput 设计）
 *
 * 组合式 API：
 *   <PromptInput onSubmit={(message) => ...}>
 *     <PromptInputBody>
 *       <PromptInputTextarea placeholder="..." />
 *     </PromptInputBody>
 *     <PromptInputFooter>
 *       <PromptInputTools>{工具栏按钮}</PromptInputTools>
 *       <PromptInputSubmit status="ready|submitted|streaming" />
 *     </PromptInputFooter>
 *   </PromptInput>
 *
 * 特性：
 * - Enter 提交，Shift+Enter 换行（含中文输入法 composing 判断）
 * - submitted 状态显示 spinner，streaming 可点击停止
 * - 外层圆角卡片样式（rounded-3xl），类似 ChatGPT 输入框
 * - 仅依赖项目已有的 cn 工具，不引入额外 shadcn 组件
 */

// ============================================================================
// Context
// ============================================================================

interface PromptInputContextValue {
  /** 当前提交状态 */
  status: PromptInputStatus
  /** 是否正在生成（submitted 或 streaming） */
  isGenerating: boolean
}

const PromptInputContext = React.createContext<PromptInputContextValue | null>(
  null,
)

// ============================================================================
// 类型
// ============================================================================

export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error"

export interface PromptInputMessage {
  /** 用户输入的文本 */
  text: string
}

export interface PromptInputProps
  extends Omit<React.HTMLAttributes<HTMLFormElement>, "onSubmit"> {
  /** 提交回调 */
  onSubmit: (
    message: PromptInputMessage,
    event: React.FormEvent<HTMLFormElement>,
  ) => void | Promise<void>
  /** 提交状态，控制 Submit 按钮显示 */
  status?: PromptInputStatus
  /** streaming 状态下点击停止按钮的回调；提供后才显示停止按钮 */
  onStop?: () => void
}

// ============================================================================
// 根组件 PromptInput
// ============================================================================

export function PromptInput({
  className,
  onSubmit,
  status = "ready",
  onStop,
  children,
  ...props
}: PromptInputProps) {
  const isGenerating = status === "submitted" || status === "streaming"

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const form = event.currentTarget
      const formData = new FormData(form)
      const text = (formData.get("message") as string) || ""
      if (!text.trim() && !isGenerating) return

      try {
        const result = onSubmit({ text }, event)
        if (result instanceof Promise) {
          await result
          form.reset()
        } else {
          form.reset()
        }
      } catch {
        // 出错不清空，用户可能想重试
      }
    },
    [onSubmit, isGenerating],
  )

  const handleStop = React.useCallback(
    (e: React.MouseEvent) => {
      if (isGenerating && onStop) {
        e.preventDefault()
        onStop()
      }
    },
    [isGenerating, onStop],
  )

  const ctxValue = React.useMemo(
    () => ({ status, isGenerating }),
    [status, isGenerating],
  )

  return (
    <PromptInputContext.Provider value={ctxValue}>
      <form
        onSubmit={handleSubmit}
        className={cn(
          "w-full rounded-3xl border bg-card shadow-sm transition-shadow focus-within:shadow-md",
          className,
        )}
        {...props}
      >
        {children}
        {/* 隐藏的停止按钮拦截：当 isGenerating 且有 onStop 时，提交按钮会变成停止按钮 */}
        {isGenerating && onStop ? (
          <button
            type="button"
            onClick={handleStop}
            className="sr-only"
            aria-label="停止生成"
            tabIndex={-1}
          />
        ) : null}
      </form>
    </PromptInputContext.Provider>
  )
}

// ============================================================================
// PromptInputBody — 输入区主体容器
// ============================================================================

export function PromptInputBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-4 pt-3", className)} {...props} />
  )
}

// ============================================================================
// PromptInputTextarea — 文本输入框
// ============================================================================

export type PromptInputTextareaProps = React.ComponentProps<"textarea">

export function PromptInputTextarea({
  className,
  placeholder = "输入提示词…",
  onKeyDown,
  ...props
}: PromptInputTextareaProps) {
  const [isComposing, setIsComposing] = React.useState(false)

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(e)
      if (e.defaultPrevented) return

      // Enter 提交，Shift+Enter 换行；输入法 composing 时忽略
      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) return
        if (e.shiftKey) return
        e.preventDefault()

        const { form } = e.currentTarget
        const submitButton = form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null
        if (submitButton?.disabled) return
        form?.requestSubmit()
      }
    },
    [onKeyDown, isComposing],
  )

  return (
    <textarea
      name="message"
      className={cn(
        "w-full resize-none bg-transparent text-sm outline-none",
        "min-h-[44px] max-h-48 field-sizing-content",
        "placeholder:text-muted-foreground",
        className,
      )}
      placeholder={placeholder}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      {...props}
    />
  )
}

// ============================================================================
// PromptInputFooter — 底部工具栏容器
// ============================================================================

export function PromptInputFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-3 pb-3 pt-2",
        className,
      )}
      {...props}
    />
  )
}

// ============================================================================
// PromptInputTools — 左侧工具按钮组容器
// ============================================================================

export function PromptInputTools({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1", className)}
      {...props}
    />
  )
}

// ============================================================================
// PromptInputButton — 工具栏按钮
// ============================================================================

export interface PromptInputButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 是否激活态（如选中的工具） */
  active?: boolean
  /** 按钮变体 */
  variant?: "ghost" | "outline"
  /** 按钮尺寸 */
  size?: "sm" | "icon" | "icon-sm"
}

export function PromptInputButton({
  className,
  active,
  variant = "ghost",
  size = "sm",
  type = "button",
  ...props
}: PromptInputButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium",
        "transition-colors focus:outline-none disabled:pointer-events-none disabled:opacity-50",
        variant === "ghost" && "text-muted-foreground hover:bg-accent hover:text-foreground",
        variant === "outline" && "border bg-background hover:bg-accent",
        active && "bg-accent text-foreground",
        size === "icon" && "size-8 p-0",
        size === "icon-sm" && "size-7 p-0",
        className,
      )}
      {...props}
    />
  )
}

// ============================================================================
// PromptInputSubmit — 提交/停止按钮
// ============================================================================

export interface PromptInputSubmitProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 提交状态 */
  status?: PromptInputStatus
  /** 停止回调（提供后在 generating 时变成停止按钮） */
  onStop?: () => void
}

export function PromptInputSubmit({
  className,
  status = "ready",
  onStop,
  disabled,
  onClick,
  ...props
}: PromptInputSubmitProps) {
  const isGenerating = status === "submitted" || status === "streaming"

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        e.preventDefault()
        onStop()
        return
      }
      onClick?.(e)
    },
    [isGenerating, onStop, onClick],
  )

  return (
    <button
      type={isGenerating && onStop ? "button" : "submit"}
      aria-label={isGenerating && onStop ? "停止生成" : "提交"}
      disabled={disabled && !isGenerating}
      onClick={handleClick}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full",
        "bg-primary text-primary-foreground transition-colors",
        "hover:bg-primary/90 focus:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {status === "submitted" ? (
        <MorphingInfinity className="size-4" />
      ) : status === "streaming" && onStop ? (
        <Square className="size-3.5 fill-current" />
      ) : (
        <ArrowUp className="size-4" />
      )}
    </button>
  )
}
