"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { Check, Copy } from "lucide-react"
import { cn, copyText } from "@/lib/utils"

/**
 * AI 对话 markdown 渲染
 *
 * react-markdown + remark-gfm（表格/任务列表/删除线）+
 * rehype-highlight（代码高亮），prose 排版（@tailwindcss/typography）。
 * 代码块右上角带复制按钮（ref 读取 pre 文本，不侵入 AST）。
 */

function PreWithCopy({ children }: { children?: React.ReactNode }) {
  const preRef = React.useRef<HTMLPreElement>(null)
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function handleCopy() {
    const text = preRef.current?.textContent ?? ""
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="group/code relative">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          handleCopy()
        }}
        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
        aria-label="复制代码"
      >
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

export function ChatMarkdown({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <div
      className={cn(
        // 正文排版对齐 agent 模板：15px / foreground/90（prose 默认行高 ~1.71）
        "prose prose-sm dark:prose-invert max-w-none break-words text-[15px] text-foreground/90",
        // 收紧 prose 默认首尾与标题间距，贴合聊天气泡节奏
        "[&_:first-child]:mt-0 [&_:last-child]:mb-0 [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-3",
        "[&_pre]:rounded-lg [&_pre]:bg-muted/60 [&_pre]:p-3 [&_pre]:text-xs",
        "[&_code]:before:content-none [&_code]:after:content-none [&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_a]:text-primary [&_a]:no-underline hover:[&_a]:underline",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:text-muted-foreground",
        // hr（模型输出 --- 分节）与表格边框统一为中性灰白：Typography 默认
        // --tw-prose-hr 为 slate 蓝灰（#364153），深色背景下呈蓝色；v4 的
        // border 宽度类默认 currentColor，深色下过亮
        "[&_hr]:border-border/70 [&_hr]:my-4",
        "[&_table]:text-xs [&_th]:border [&_th]:border-border/60 [&_td]:border [&_td]:border-border/60",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={{
          pre: PreWithCopy,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
