"use client"

import type { RefObject } from "react"
import { extractTemplateVars, type TemplateVarDef } from "@/lib/product/prompt-vars"

/**
 * 模板编辑变量芯片 + 未知变量提示（提示词模板表单 / 方向表单共用）
 *
 * - 芯片点击在光标处插入 {{变量}}（无光标信息时追加到末尾）
 * - 模板引用了清单之外的变量时显示非阻断警告（运行时会被替换为空）
 */
export function TemplateVarChips({
  vars,
  template,
  textareaRef,
  onTemplateChange,
}: {
  vars: TemplateVarDef[]
  template: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onTemplateChange: (next: string) => void
}) {
  const known = new Set(vars.map((v) => v.name))
  const unknown = extractTemplateVars(template).filter((v) => !known.has(v))

  const insertVar = (name: string) => {
    const token = `{{${name}}}`
    const el = textareaRef.current
    if (!el) {
      onTemplateChange(template + token)
      return
    }
    const start = el.selectionStart ?? template.length
    const end = el.selectionEnd ?? template.length
    onTemplateChange(template.slice(0, start) + token + template.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <div className="space-y-1">
      {vars.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">可用变量（点击插入）：</span>
          {vars.map((v) => (
            <button
              key={v.name}
              type="button"
              title={v.desc}
              onClick={() => insertVar(v.name)}
              className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {`{{${v.name}}}`}
            </button>
          ))}
        </div>
      )}
      {unknown.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {`以下变量不在可用清单中，运行时将被替换为空：${unknown.map((v) => `{{${v}}}`).join(" ")}`}
        </p>
      )}
    </div>
  )
}
