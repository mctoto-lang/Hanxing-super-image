"use client"

import * as React from "react"
import { Loader2, Search } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

/**
 * 共享搜索条（TEMU 工具栏口径，shadcn 官方 InputGroup 规范）：整组一个边框 +
 * 整组 focus 环——左段可搜索项下拉（段间竖线）、中段输入框、尾段浅灰「搜索」
 * 按钮。按钮点击 / 输入框回车触发 onSearch；空关键词可点 = 清除该字段筛选
 * （返回全部）。受控组件，切字段保留关键词、placeholder 随字段。
 */

export interface SearchBarField {
  value: string
  /** 下拉项文案 */
  label: string
  /** 选中该字段时输入框 placeholder（勿重复字段名） */
  placeholder: string
}

export function TemuSearchBar({
  fields,
  field,
  onFieldChange,
  keyword,
  onKeywordChange,
  onSearch,
  searching = false,
  className,
}: {
  fields: SearchBarField[]
  field: string
  onFieldChange: (v: string) => void
  keyword: string
  onKeywordChange: (v: string) => void
  /** 按钮/回车触发；空关键词点击 = 清除该字段筛选 */
  onSearch: (field: string, keyword: string) => void
  searching?: boolean
  className?: string
}) {
  const current = fields.find((f) => f.value === field) ?? fields[0]
  const items = fields.map((f) => ({ value: f.value, label: f.label }))
  const fire = () => onSearch(current?.value ?? "", keyword.trim())
  return (
    <InputGroup className={`h-8 text-xs ${className ?? ""}`}>
      <InputGroupAddon
        align="inline-start"
        className="gap-0 self-stretch border-r border-input py-0 pr-1.5 pl-0.5"
      >
        <Select items={items} value={current?.value} onValueChange={(v) => onFieldChange(v ?? field)}>
          <SelectTrigger
            size="sm"
            aria-label="可搜索项"
            className="h-7 w-24 justify-center border-0 bg-transparent px-2 text-xs font-medium focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
          >
            <SelectValue>{current?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {fields.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={keyword}
        onChange={(e) => onKeywordChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && fire()}
        placeholder={current?.placeholder}
        aria-label="搜索关键词"
        className="h-7 px-2 text-xs"
      />
      <InputGroupAddon align="inline-end" className="self-stretch py-0 pr-1">
        <InputGroupButton
          variant="secondary"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={fire}
          disabled={searching}
        >
          {searching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Search className="size-3.5" />
          )}
          搜索
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
