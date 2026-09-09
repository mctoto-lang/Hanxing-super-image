"use client"

import * as React from "react"
import { cn, copyText } from "@/lib/utils"
import {
  ChevronDown,
  Search,
  Terminal,
  Check,
  Globe,
  ExternalLink,
  Brain,
  FileCode,
  FileText,
  Command,
  Database,
  CircleAlert,
  Cpu,
  CodeXml,
  Copy,
  CheckCheck,
} from "lucide-react"

/**
 * AI Agent Response 组件集（AI 对话 agent 轨迹展示）
 *
 * 来源：21st.dev 模板 ai-agent-response，落地适配：
 * - lucide-react 1.x 图标改名：AlertCircle→CircleAlert、FileCode2→FileCode、Code2→CodeXml
 * - 原模板内嵌在 ThinkingState 里的 keyframes（agent-pixel-on / agent-shimmer /
 *   agent-fade）移至 globals.css，便于其它构建块（如 PixelDotsLoader）单独使用
 * - 入参类型以 unknown 替代 any
 *
 * 当前 /chat 仅接入 PixelDotsLoader 与 NestedReasoningBlock 的视觉风格
 * （见 src/components/chat/agent-reasoning.tsx）；TerminalCommand / FileDiff /
 * TracePillRow / ThinkingState / AgentWorkflow 为后续后端支持工具调用、
 * 终端执行等 SSE 事件时预留，暂无数据源。
 */

/* ─────────────────────────────────────────────────────────
 * SAFE DYNAMIC ICON RENDERER
 * ───────────────────────────────────────────────────────── */

/** 可作为 icon 传入的组件类型（lucide 图标、forwardRef 组件等） */
export type AgentIconComponent = React.ComponentType<{
  className?: string
  ["aria-hidden"]?: boolean
}>

function renderDynamicIcon(
  icon: AgentIconComponent | React.ReactElement,
  className?: string
): React.ReactNode {
  if (!icon) return null
  if (React.isValidElement(icon)) return icon
  if (typeof icon === "function" || typeof icon === "object") {
    return React.createElement(icon as AgentIconComponent, {
      className: cn("size-3.5 shrink-0", className),
      "aria-hidden": true,
    })
  }
  return null
}

/* ─────────────────────────────────────────────────────────
 * COMPACT 3x3 PIXEL DOT GRID LOADER
 * ───────────────────────────────────────────────────────── */
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3)
  const c = i % 3
  return (c + Math.abs(r - 1)) * 90
})

export function PixelDotsLoader({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 grid-cols-[repeat(3,3px)] items-center gap-[1.5px]",
        className
      )}
    >
      {CHEVRON_DELAYS.map((delay, index) => (
        <span
          key={index}
          className="size-[3px] rounded-full bg-foreground/80 transition-opacity motion-reduce:animate-none"
          style={{
            opacity: 0.2,
            animation: `agent-pixel-on 650ms cubic-bezier(0.23, 1, 0.32, 1) ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  )
}

/* ─────────────────────────────────────────────────────────
 * TERMINAL & BASH COMMAND EXECUTION VIEWER
 * ───────────────────────────────────────────────────────── */
export interface TerminalCommandProps {
  command: string
  output?: string
  exitCode?: number
  durationMs?: number
  isRunning?: boolean
  className?: string
}

export function TerminalCommand({
  command,
  output,
  exitCode = 0,
  durationMs,
  isRunning = false,
  className,
}: TerminalCommandProps) {
  const [copied, setCopied] = React.useState(false)

  const handleCopy = () => {
    const fullText = output ? `$ ${command}\n\n${output}` : `$ ${command}`
    void copyText(fullText).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-lg border border-border/80 bg-card font-mono text-[11.5px] shadow-xs select-text",
        className
      )}
    >
      {/* Terminal Command Header */}
      <div className="flex items-center justify-between border-b border-border/70 bg-muted/40 px-2.5 py-1.5 text-[11px]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Terminal className="size-3.5 shrink-0 text-violet-500" aria-hidden="true" />
          <span className="select-none font-bold text-muted-foreground/60">$</span>
          <span className="truncate font-semibold tracking-tight text-foreground">
            {command}
          </span>
        </div>

        <div className="ml-2 flex shrink-0 items-center gap-2">
          {durationMs !== undefined && (
            <span className="text-[11px] tabular-nums text-muted-foreground/60">
              {durationMs}ms
            </span>
          )}

          {isRunning ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10.5px] font-medium text-violet-600 dark:text-violet-400">
              <span className="size-1.5 animate-pulse rounded-full bg-violet-500" />
              running
            </span>
          ) : exitCode === 0 ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
              exit 0
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-rose-600 dark:text-rose-400">
              exit {exitCode}
            </span>
          )}

          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Copied command and output" : "Copy command"}
            className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.96]"
          >
            {copied ? (
              <CheckCheck className="size-3 text-emerald-500" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Stdout Output Area */}
      {output && (
        <div className="relative overflow-x-auto bg-muted/20 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <pre className="whitespace-pre font-mono">
            {output.split("\n").map((line, idx) => {
              const isPass =
                line.includes("✓") || line.includes("PASS") || line.includes("passed")
              const isFail =
                line.includes("FAIL") || line.includes("Error") || line.includes("failed")
              const isWarn = line.includes("WARN") || line.includes("warning")

              return (
                <div
                  key={idx}
                  className={cn(
                    "flex items-start gap-1",
                    isPass && "font-medium text-emerald-600 dark:text-emerald-400",
                    isFail && "font-medium text-rose-600 dark:text-rose-400",
                    isWarn && "text-amber-600 dark:text-amber-400",
                    !isPass && !isFail && !isWarn && "text-muted-foreground"
                  )}
                >
                  <span>{line}</span>
                </div>
              )
            })}
          </pre>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * REAL FILE DIFF VIEWER
 * ───────────────────────────────────────────────────────── */
export type DiffRow = {
  old?: number | null
  cur?: number | null
  type: "add" | "del" | "ctx"
  text: string
}

export interface FileDiffProps {
  file: string
  rows: DiffRow[]
  className?: string
}

export function FileDiff({ file, rows = [], className }: FileDiffProps) {
  const [copied, setCopied] = React.useState(false)
  const added = rows.filter((r) => r.type === "add").length
  const removed = rows.filter((r) => r.type === "del").length

  const handleCopy = () => {
    const textContent = rows
      .map((r) => `${r.type === "add" ? "+" : r.type === "del" ? "-" : " "} ${r.text}`)
      .join("\n")
    void copyText(textContent).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-lg border border-border/80 bg-card font-mono text-[11.5px] shadow-xs select-text",
        className
      )}
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between border-b border-border/70 bg-muted/40 px-2.5 py-1.5 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <CodeXml className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-medium tracking-tight text-foreground">{file}</span>
        </div>

        <div className="ml-2 flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tabular-nums">
            {added > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
            )}
            {removed > 0 && (
              <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
            )}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Copied diff" : "Copy diff to clipboard"}
            className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.96]"
          >
            {copied ? (
              <CheckCheck className="size-3 text-emerald-500" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Code Gutter & Lines */}
      <div className="relative flex flex-col overflow-x-auto py-1.5 leading-[21px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-[70px] top-0 z-1 w-[1px] bg-border/60"
        />

        {rows.map((r, i) => (
          <div
            key={i}
            className={cn(
              "group relative grid grid-cols-[34px_34px_20px_1fr] items-stretch transition-colors duration-100",
              r.type === "add" &&
                "bg-emerald-500/10 text-emerald-950 dark:bg-emerald-500/15 dark:text-emerald-100",
              r.type === "del" &&
                "bg-rose-500/10 text-rose-950 dark:bg-rose-500/15 dark:text-rose-100",
              r.type === "ctx" && "text-muted-foreground"
            )}
          >
            {r.type === "add" && (
              <span
                className="absolute bottom-0 left-0 top-0 w-[3px] bg-emerald-500"
                aria-hidden="true"
              />
            )}
            {r.type === "del" && (
              <span
                className="absolute bottom-0 left-0 top-0 w-[3px]"
                aria-hidden="true"
                style={{
                  background:
                    "repeating-linear-gradient(45deg, #ef4444 0, #ef4444 1.5px, transparent 1.5px, transparent 3px)",
                }}
              />
            )}

            <span
              className={cn(
                "select-none pr-2 text-right text-[10.5px] tabular-nums",
                r.type === "del"
                  ? "font-semibold text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground/60"
              )}
            >
              {r.old ?? ""}
            </span>
            <span
              className={cn(
                "select-none pr-2 text-right text-[10.5px] tabular-nums",
                r.type === "add"
                  ? "font-semibold text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground/60"
              )}
            >
              {r.cur ?? ""}
            </span>

            <span
              className={cn(
                "select-none text-center text-[11px] font-bold",
                r.type === "add" && "text-emerald-600 dark:text-emerald-400",
                r.type === "del" && "text-rose-600 dark:text-rose-400"
              )}
            >
              {r.type === "add" ? "+" : r.type === "del" ? "−" : ""}
            </span>

            <code
              className={cn(
                "whitespace-pre pl-1 pr-3 font-mono text-[11.5px]",
                r.type === "add"
                  ? "font-medium text-foreground"
                  : r.type === "del"
                    ? "text-foreground line-through opacity-80"
                    : "text-muted-foreground"
              )}
            >
              {r.text}
            </code>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * TYPE DEFINITIONS & SCHEMAS
 * ───────────────────────────────────────────────────────── */
export type TraceNodeType =
  | "reasoning"
  | "step"
  | "search"
  | "tool"
  | "terminal"
  | "diffs"
  | (string & {})

export type DetailLine = {
  text: string
  tone?: "add" | "del" | "ctx" | "muted" | "error"
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string
  label?: string | ((args: TArgs) => string)
  icon?: AgentIconComponent | React.ReactElement
  iconClassName?: string
  formatChip?: (args: TArgs, result?: TResult) => string
  monoChip?: boolean
  renderCustomContent?: (props: {
    args?: TArgs
    result?: TResult
    node: TraceNode<TArgs, TResult>
  }) => React.ReactNode
}

export type TraceNode<TArgs = unknown, TResult = unknown> = {
  id?: string
  type: TraceNodeType
  toolName?: string
  sentences?: string[]
  durationSeconds?: number
  primary?: string
  secondary?: string
  mono?: boolean
  icon?: AgentIconComponent | React.ReactElement
  iconClassName?: string
  status?: "pending" | "running" | "completed" | "failed"
  args?: TArgs
  result?: TResult
  command?: string
  output?: string
  exitCode?: number
  durationMs?: number
  add?: number
  del?: number
  diffRows?: DiffRow[]
  diffFile?: string
  codeSnippet?: string
  details?: DetailLine[]
  sources?: { name: string; url?: string }[]
  renderContent?: () => React.ReactNode
}

export type AgentPhase = {
  trace: TraceNode[]
  message?: string
}

const SENT_H = 46
const GAP = 8
const MAX_H = 184
const FADE = 18

/* ─────────────────────────────────────────────────────────
 * DEFAULT TOOL REGISTRY
 * ───────────────────────────────────────────────────────── */
export const DEFAULT_TOOL_REGISTRY: Record<string, ToolDefinition> = {
  read_file: {
    name: "read_file",
    label: "Read",
    icon: FileText,
    iconClassName: "text-muted-foreground/80",
    monoChip: true,
  },
  edit_file: {
    name: "edit_file",
    label: "Edit",
    icon: FileCode,
    iconClassName: "text-amber-500",
    monoChip: true,
  },
  execute_command: {
    name: "execute_command",
    label: "Run",
    icon: Terminal,
    iconClassName: "text-violet-500",
    monoChip: true,
  },
  search_web: {
    name: "search_web",
    label: "Search",
    icon: Search,
    iconClassName: "text-blue-500",
  },
  query_database: {
    name: "query_database",
    label: "SQL Query",
    icon: Database,
    iconClassName: "text-emerald-500",
    monoChip: true,
  },
}

/* ─────────────────────────────────────────────────────────
 * STREAMING TEXT
 * ───────────────────────────────────────────────────────── */
export interface StreamingTextProps extends React.HTMLAttributes<HTMLDivElement> {
  text: string
  speed?: number
  chunkSize?: number
  onComplete?: () => void
}

export function StreamingText({
  text,
  speed = 18,
  chunkSize = 2,
  className,
  onComplete,
  ...props
}: StreamingTextProps) {
  const [shown, setShown] = React.useState("")
  const onCompleteRef = React.useRef(onComplete)
  React.useEffect(() => {
    onCompleteRef.current = onComplete
  })

  React.useEffect(() => {
    let i = 0
    const id = setInterval(() => {
      i += chunkSize
      const nextText = text.slice(0, i)
      setShown(nextText)
      if (i >= text.length) {
        clearInterval(id)
        onCompleteRef.current?.()
      }
    }, speed)
    return () => clearInterval(id)
  }, [text, speed, chunkSize])

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "select-text whitespace-pre-line font-sans text-[14.5px] leading-relaxed text-foreground/90 text-pretty",
        className
      )}
      {...props}
    >
      {shown}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * NESTED REASONING BLOCK
 * ───────────────────────────────────────────────────────── */
interface NestedReasoningBlockProps {
  sentences: string[]
  delays?: number[]
  isActive: boolean
  isFinished: boolean
  durationSeconds?: number
  onFinished?: () => void
}

export function NestedReasoningBlock({
  sentences,
  delays,
  isActive,
  isFinished,
  durationSeconds = 4.2,
  onFinished,
}: NestedReasoningBlockProps) {
  const [revealedCount, setRevealedCount] = React.useState(
    isFinished ? sentences.length : 0
  )
  const [manualOpen, setManualOpen] = React.useState(false)
  const [fade, setFade] = React.useState({ top: false, bottom: true })
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const onFinishedRef = React.useRef(onFinished)
  React.useEffect(() => {
    onFinishedRef.current = onFinished
  })

  React.useEffect(() => {
    if (!isActive || isFinished) return

    const cadence = delays || sentences.map(() => 1800 + Math.floor(Math.random() * 400))
    const totalMs = cadence.reduce((a, b) => a + b, 0)

    const timers: ReturnType<typeof setTimeout>[] = []
    let cumulative = 0

    cadence.forEach((delay, idx) => {
      cumulative += delay
      timers.push(
        setTimeout(() => {
          setRevealedCount(idx + 1)
        }, cumulative)
      )
    })

    timers.push(
      setTimeout(() => {
        onFinishedRef.current?.()
      }, totalMs + 600)
    )

    return () => timers.forEach(clearTimeout)
  }, [isActive, isFinished, delays, sentences])

  const expanded = isFinished ? manualOpen : isActive
  const count = isFinished ? sentences.length : revealedCount
  const contentH = count > 0 ? count * SENT_H + (count - 1) * GAP : 0
  const capped = contentH > MAX_H
  const viewH = capped ? MAX_H : contentH
  const scrollable = isFinished && manualOpen
  const translate = scrollable ? 0 : capped ? MAX_H - FADE - contentH : 0

  const showTop = scrollable ? fade.top : capped
  const showBottom = scrollable ? fade.bottom : capped

  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none"

  const onScroll = () => {
    const el = viewportRef.current
    if (!el) return
    setFade({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    })
  }

  return (
    <div
      className="my-0.5 flex w-full flex-col"
      style={{ animation: "agent-fade 280ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <button
        type="button"
        disabled={!isFinished}
        aria-expanded={expanded}
        onClick={() => isFinished && setManualOpen((v) => !v)}
        className={cn(
          "group/row relative flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] transition-colors duration-150",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          isFinished
            ? "cursor-pointer hover:bg-muted/60 active:scale-[0.98]"
            : "cursor-default"
        )}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <Brain
            aria-hidden="true"
            className={cn(
              "size-3.5 opacity-75 transition-opacity duration-150",
              isFinished && "group-hover/row:opacity-0",
              manualOpen && "opacity-0"
            )}
          />
          {isFinished && (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "absolute size-3.5 rotate-0 opacity-0 transition-transform duration-200",
                "group-hover/row:opacity-100",
                manualOpen ? "opacity-100 rotate-0" : "-rotate-90"
              )}
            />
          )}
        </span>

        <span className="text-[12px] font-medium transition-colors">
          {isFinished ? (
            <span className="text-foreground">
              Thought for{" "}
              <span className="font-mono text-[11.5px] tabular-nums">
                {durationSeconds}s
              </span>
            </span>
          ) : (
            <span
              className="bg-clip-text font-medium text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, var(--color-muted-foreground, oklch(0.55 0 0)) 35%, var(--color-foreground, oklch(0.95 0 0)) 50%, var(--color-muted-foreground, oklch(0.55 0 0)) 65%)",
                backgroundSize: "200% 100%",
                animation: "agent-shimmer 1.8s linear infinite",
              }}
            >
              Thinking…
            </span>
          )}
        </span>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
          expanded
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 mb-1.5 ml-2.5 border-l border-border/70 py-0.5 pl-2.5">
            <div
              ref={viewportRef}
              className={cn(
                "overflow-hidden transition-[height] duration-300 ease-out pr-1",
                scrollable &&
                  "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              )}
              style={{
                height: `${viewH}px`,
                WebkitMaskImage: mask,
                maskImage: mask,
              }}
              onScroll={scrollable ? onScroll : undefined}
            >
              <div
                className="flex flex-col gap-2 transition-transform duration-400 ease-out will-change-transform"
                style={{ transform: `translateY(${translate}px)` }}
              >
                {sentences.slice(0, count).map((line, i) => (
                  <p
                    key={i}
                    className="m-0 h-[46px] overflow-hidden text-pretty text-[13px] leading-[23px] font-[425] tracking-tight text-muted-foreground line-clamp-2"
                    style={{
                      animation: "agent-fade 250ms cubic-bezier(0.23,1,0.32,1) both",
                    }}
                  >
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * UNIVERSAL EXTENSIBLE PILL ROW ITEM
 * ───────────────────────────────────────────────────────── */
interface TracePillRowProps {
  node: TraceNode
  isActive: boolean
  isFinished: boolean
  toolRegistry?: Record<string, ToolDefinition>
}

function TracePillRow({
  node,
  isActive,
  toolRegistry = DEFAULT_TOOL_REGISTRY,
}: TracePillRowProps) {
  const [open, setOpen] = React.useState(false)

  const toolDef = node.toolName ? toolRegistry[node.toolName] : undefined

  const isCommandNode = Boolean(
    node.command || node.type === "terminal" || node.type === "command"
  )

  const hasDetails = Boolean(
    isCommandNode ||
      node.renderContent ||
      toolDef?.renderCustomContent ||
      node.diffRows ||
      node.codeSnippet ||
      (node.details && node.details.length > 0) ||
      (node.sources && node.sources.length > 0) ||
      node.args ||
      node.result
  )

  const primaryText =
    node.primary ||
    (isCommandNode ? "Run" : undefined) ||
    (typeof toolDef?.label === "function" ? toolDef.label(node.args) : toolDef?.label) ||
    toolDef?.name ||
    node.type

  const secondaryText =
    node.secondary ||
    node.command ||
    (toolDef?.formatChip ? toolDef.formatChip(node.args, node.result) : undefined) ||
    (typeof node.args === "string" ? node.args : undefined)

  const isMono = node.mono ?? (isCommandNode || Boolean(toolDef?.monoChip))

  const renderIcon = () => {
    if (isActive) {
      return (
        <span
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-foreground"
        />
      )
    }
    if (node.status === "failed" || (node.exitCode !== undefined && node.exitCode > 0)) {
      return <CircleAlert className="size-3.5 shrink-0 text-rose-500" aria-hidden="true" />
    }

    if (node.icon) return renderDynamicIcon(node.icon, node.iconClassName)
    if (toolDef?.icon) return renderDynamicIcon(toolDef.icon, toolDef.iconClassName)

    const semanticKey = `${node.primary || ""} ${node.toolName || ""} ${node.type || ""} ${node.command || ""}`.toLowerCase()

    if (semanticKey.includes("read") || semanticKey.includes("inspect") || semanticKey.includes("parse")) {
      return (
        <FileText
          className="size-3.5 shrink-0 text-muted-foreground/80"
          aria-hidden="true"
        />
      )
    }
    if (
      semanticKey.includes("edit") ||
      semanticKey.includes("write") ||
      semanticKey.includes("patch") ||
      semanticKey.includes("create")
    ) {
      return <FileCode className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
    }
    if (
      isCommandNode ||
      semanticKey.includes("run") ||
      semanticKey.includes("test") ||
      semanticKey.includes("compile") ||
      semanticKey.includes("tsc") ||
      semanticKey.includes("exec")
    ) {
      return <Terminal className="size-3.5 shrink-0 text-violet-500" aria-hidden="true" />
    }
    if (
      semanticKey.includes("search") ||
      semanticKey.includes("query") ||
      semanticKey.includes("lookup")
    ) {
      return <Search className="size-3.5 shrink-0 text-blue-500" aria-hidden="true" />
    }
    if (
      semanticKey.includes("db") ||
      semanticKey.includes("database") ||
      semanticKey.includes("sql") ||
      semanticKey.includes("redis")
    ) {
      return <Database className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
    }
    if (
      semanticKey.includes("deploy") ||
      semanticKey.includes("canary") ||
      semanticKey.includes("cluster")
    ) {
      return <Cpu className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />
    }
    if (node.type === "step") {
      return <Check className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
    }

    return (
      <Command className="size-3.5 shrink-0 text-muted-foreground/80" aria-hidden="true" />
    )
  }

  return (
    <div
      className="my-0.5 flex flex-col"
      style={{ animation: "agent-fade 280ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <button
        type="button"
        disabled={!hasDetails}
        aria-expanded={open}
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={cn(
          "group/row relative flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] transition-colors duration-150",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          hasDetails
            ? "cursor-pointer hover:bg-muted/60 active:scale-[0.98]"
            : "cursor-default"
        )}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <span
            className={cn(
              "flex items-center justify-center transition-opacity duration-150",
              hasDetails && "group-hover/row:opacity-0",
              open && "opacity-0"
            )}
          >
            {renderIcon()}
          </span>
          {hasDetails && (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "absolute size-3.5 rotate-0 opacity-0 transition-transform duration-200",
                "group-hover/row:opacity-100",
                open ? "opacity-100 rotate-0" : "-rotate-90"
              )}
            />
          )}
        </span>

        <span className="shrink-0 text-[12px] font-medium tracking-tight text-foreground">
          {primaryText}
        </span>

        {secondaryText && (
          <span
            className={cn(
              "inline-flex h-5 min-w-0 max-w-[65%] items-center truncate rounded-md border border-border/40 bg-muted/80 px-1.5 text-[11px] text-muted-foreground transition-colors group-hover/row:border-border/80 group-hover/row:text-foreground",
              isMono ? "font-mono" : "font-sans"
            )}
          >
            <span className="truncate">{secondaryText}</span>
          </span>
        )}

        {node.add !== undefined || node.del !== undefined ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
            {node.add !== undefined && node.add > 0 ? (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                +{node.add}
              </span>
            ) : null}
            {node.del !== undefined && node.del > 0 ? (
              <span className="font-medium text-rose-600 dark:text-rose-400">
                −{node.del}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>

      {hasDetails && (
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]",
            open
              ? "grid-rows-[1fr] opacity-100"
              : "pointer-events-none grid-rows-[0fr] opacity-0"
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mt-1 mb-1.5 ml-2.5 flex flex-col gap-1.5 border-l border-border/70 py-0.5 pl-2.5">
              {/* Custom Viewport Renderers */}
              {node.renderContent ? (
                node.renderContent()
              ) : toolDef?.renderCustomContent ? (
                toolDef.renderCustomContent({
                  args: node.args,
                  result: node.result,
                  node,
                })
              ) : null}

              {/* Dedicated Terminal Execution Format */}
              {isCommandNode && node.command ? (
                <TerminalCommand
                  command={node.command}
                  output={node.output}
                  exitCode={node.exitCode ?? 0}
                  durationMs={node.durationMs}
                  isRunning={isActive}
                />
              ) : null}

              {/* Real Embedded FileDiff Component */}
              {node.diffRows ? (
                <FileDiff
                  file={
                    node.diffFile ||
                    (typeof node.secondary === "string" ? node.secondary : "patch.ts")
                  }
                  rows={node.diffRows}
                />
              ) : null}

              {/* Structured Line Details */}
              {!isCommandNode && node.details && node.details.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {node.details.map((line, lIdx) => (
                    <span
                      key={lIdx}
                      className={cn(
                        "text-[11.5px] leading-relaxed",
                        line.tone === "add" &&
                          "font-mono text-emerald-600 dark:text-emerald-400",
                        line.tone === "del" &&
                          "font-mono text-rose-600 dark:text-rose-400",
                        line.tone === "ctx" && "font-mono text-muted-foreground",
                        line.tone === "error" &&
                          "font-medium text-rose-600 dark:text-rose-400",
                        (!line.tone || line.tone === "muted") && "text-muted-foreground"
                      )}
                    >
                      {line.text}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Code Snippet Fallback */}
              {!isCommandNode && !node.diffRows && node.codeSnippet ? (
                <div className="overflow-x-auto rounded-lg border border-border/70 bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                  <pre className="whitespace-pre">{node.codeSnippet}</pre>
                </div>
              ) : null}

              {/* Sources */}
              {node.sources && node.sources.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {node.sources.map((src, sIdx) => (
                    <a
                      key={sIdx}
                      href={src.url || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <Globe className="size-2.5 opacity-70" aria-hidden="true" />
                      <span>{src.name}</span>
                      <ExternalLink className="size-2.5 opacity-50" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * THINKING STATE (Unboxed Seamless Trigger)
 * keyframes（agent-pixel-on / agent-shimmer / agent-fade）见 globals.css
 * ───────────────────────────────────────────────────────── */
export interface ThinkingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  nodes?: TraceNode[]
  tools?: Record<string, ToolDefinition>
  autoPlay?: boolean
  defaultExpanded?: boolean
  workingLabel?: string
  onSettled?: () => void
}

export const ThinkingState = React.forwardRef<HTMLDivElement, ThinkingStateProps>(
  (
    {
      nodes = [],
      tools = DEFAULT_TOOL_REGISTRY,
      autoPlay = true,
      defaultExpanded,
      workingLabel = "Working...",
      onSettled,
      className,
      style,
      ...props
    },
    ref
  ) => {
    const totalNodes = nodes.length
    const [activeIndex, setActiveIndex] = React.useState(autoPlay ? 0 : totalNodes)
    const [isWorking, setIsWorking] = React.useState(autoPlay)
    const [manualExpanded, setManualExpanded] = React.useState<boolean | null>(
      defaultExpanded !== undefined ? defaultExpanded : null
    )

    // 渲染期不得调用 Date.now()（react-hooks/purity），初值 0，
    // 真实起点在下方 autoPlay effect 内赋值
    const startTimeRef = React.useRef<number>(0)
    const [elapsedSeconds, setElapsedSeconds] = React.useState<number>(0)
    const isWorkingRef = React.useRef(isWorking)
    const onSettledRef = React.useRef(onSettled)
    React.useEffect(() => {
      isWorkingRef.current = isWorking
      onSettledRef.current = onSettled
    })

    React.useEffect(() => {
      if (!autoPlay) return
      startTimeRef.current = Date.now()

      const timer = setInterval(() => {
        if (!isWorkingRef.current) {
          clearInterval(timer)
          return
        }
        const diff = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000))
        setElapsedSeconds(diff)
      }, 250)

      return () => clearInterval(timer)
    }, [autoPlay])

    const advanceStep = React.useCallback(() => {
      setActiveIndex((prev) => {
        const next = prev + 1
        if (next >= totalNodes) {
          setIsWorking(false)
          const finalDuration = Math.max(
            1,
            Math.round((Date.now() - startTimeRef.current) / 1000)
          )
          setElapsedSeconds(finalDuration)
        }
        return next
      })
    }, [totalNodes])

    React.useEffect(() => {
      if (!autoPlay || !isWorking || activeIndex >= totalNodes) return

      const currentNode = nodes[activeIndex]
      if (currentNode?.type === "reasoning") return

      const delay =
        currentNode?.type === "tool" || currentNode?.type === "terminal"
          ? 2200
          : currentNode?.type === "search"
            ? 2400
            : 1700

      const timer = setTimeout(() => {
        advanceStep()
      }, delay)

      return () => clearTimeout(timer)
    }, [activeIndex, autoPlay, isWorking, totalNodes, nodes, advanceStep])

    React.useEffect(() => {
      if (!isWorking && autoPlay) {
        onSettledRef.current?.()
      }
    }, [isWorking, autoPlay])

    const isGlobalExpanded = manualExpanded !== null ? manualExpanded : isWorking

    return (
      <div
        ref={ref}
        className={cn(
          "flex w-full select-none flex-col font-sans text-foreground",
          className
        )}
        style={style}
        {...props}
      >
        {/* Master Header Trigger (Seamless unboxed prose integration) */}
        <button
          type="button"
          aria-expanded={isGlobalExpanded}
          onClick={() => setManualExpanded((prev) => !(prev !== null ? prev : isWorking))}
          className={cn(
            "group flex w-fit cursor-pointer items-center gap-1.5 bg-transparent p-0 text-left text-[13.5px] leading-relaxed font-normal text-muted-foreground/75 transition-colors duration-150 hover:text-foreground",
            "rounded-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          )}
        >
          {isWorking ? <PixelDotsLoader /> : null}

          <span className="text-[13.5px] font-normal transition-colors">
            {isWorking ? (
              <span
                className="bg-clip-text font-medium text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, var(--color-muted-foreground, oklch(0.55 0 0)) 35%, var(--color-foreground, oklch(0.95 0 0)) 50%, var(--color-muted-foreground, oklch(0.55 0 0)) 65%)",
                  backgroundSize: "200% 100%",
                  animation: "agent-shimmer 1.5s linear infinite",
                }}
              >
                {workingLabel}
              </span>
            ) : (
              <span>
                Worked for{" "}
                <span className="font-mono text-[12px] tabular-nums">
                  {elapsedSeconds}
                </span>{" "}
                {elapsedSeconds === 1 ? "second" : "seconds"}
              </span>
            )}
          </span>

          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3 rotate-0 opacity-30 transition-transform duration-300 group-hover:opacity-80",
              isGlobalExpanded ? "rotate-180" : "rotate-0"
            )}
          />
        </button>

        {/* Master Collapsible Timeline Channel */}
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
            isGlobalExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "pointer-events-none grid-rows-[0fr] opacity-0"
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-border/60 py-0.5 pl-2">
              {nodes.slice(0, activeIndex + 1).map((node, idx) => {
                const isNodeActive = idx === activeIndex && isWorking
                const isNodeFinished = idx < activeIndex || !isWorking

                if (node.type === "reasoning" && node.sentences) {
                  return (
                    <NestedReasoningBlock
                      key={idx}
                      sentences={node.sentences}
                      durationSeconds={node.durationSeconds}
                      isActive={isNodeActive}
                      isFinished={isNodeFinished}
                      onFinished={advanceStep}
                    />
                  )
                }

                return (
                  <TracePillRow
                    key={idx}
                    node={node}
                    isActive={isNodeActive}
                    isFinished={isNodeFinished}
                    toolRegistry={tools}
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }
)
ThinkingState.displayName = "ThinkingState"

/* ─────────────────────────────────────────────────────────
 * MULTI-PHASE AGENT WORKFLOW ORCHESTRATOR
 * ───────────────────────────────────────────────────────── */
export interface AgentWorkflowProps extends React.HTMLAttributes<HTMLDivElement> {
  phases: AgentPhase[]
  tools?: Record<string, ToolDefinition>
  workingLabel?: string
  onComplete?: () => void
}

export function AgentWorkflow({
  phases = [],
  tools,
  workingLabel = "Working...",
  onComplete,
  className,
  ...props
}: AgentWorkflowProps) {
  const [currentPhaseIdx, setCurrentPhaseIdx] = React.useState(0)
  const [phaseStatus, setPhaseStatus] = React.useState<"trace" | "message">("trace")
  const onCompleteRef = React.useRef(onComplete)
  React.useEffect(() => {
    onCompleteRef.current = onComplete
  })

  const handleTraceSettled = React.useCallback(
    (idx: number) => {
      if (idx === currentPhaseIdx) {
        if (phases[idx]?.message) {
          setPhaseStatus("message")
        } else if (idx < phases.length - 1) {
          setCurrentPhaseIdx((prev) => prev + 1)
          setPhaseStatus("trace")
        } else {
          onCompleteRef.current?.()
        }
      }
    },
    [currentPhaseIdx, phases]
  )

  const handleMessageCompleted = React.useCallback(
    (idx: number) => {
      if (idx === currentPhaseIdx) {
        if (idx < phases.length - 1) {
          setCurrentPhaseIdx((prev) => prev + 1)
          setPhaseStatus("trace")
        } else {
          onCompleteRef.current?.()
        }
      }
    },
    [currentPhaseIdx, phases]
  )

  return (
    <div className={cn("flex w-full flex-col gap-4", className)} {...props}>
      {phases.map((phase, idx) => {
        if (idx > currentPhaseIdx) return null

        const isCurrentPhase = idx === currentPhaseIdx
        const shouldShowTrace = true
        const shouldPlayTrace = isCurrentPhase && phaseStatus === "trace"
        const isTraceFinished = !isCurrentPhase || phaseStatus === "message"

        const shouldShowMessage = isTraceFinished && !!phase.message
        const shouldStreamMessage = isCurrentPhase && phaseStatus === "message"

        return (
          <div key={idx} className="flex flex-col gap-1">
            {shouldShowTrace ? (
              <ThinkingState
                nodes={phase.trace}
                tools={tools}
                autoPlay={shouldPlayTrace}
                workingLabel={workingLabel}
                onSettled={() => handleTraceSettled(idx)}
              />
            ) : null}

            {shouldShowMessage && phase.message ? (
              <div className="pt-0 animate-[agent-fade_300ms_ease-out_both]">
                {shouldStreamMessage ? (
                  <StreamingText
                    text={phase.message}
                    speed={18}
                    chunkSize={2}
                    onComplete={() => handleMessageCompleted(idx)}
                  />
                ) : (
                  <div className="select-text whitespace-pre-line font-sans text-[14.5px] leading-relaxed text-foreground/90 text-pretty">
                    {phase.message}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
