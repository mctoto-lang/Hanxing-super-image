"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * 选品工具筛选下拉（筛选栏共用）：空值显示占位文案，base-ui Select 需传
 * items 让 SelectValue 按选项渲染标签。
 */
export function FilterSelect({
  value,
  onChange,
  ariaLabel,
  items,
  placeholder,
  width = "w-32",
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  items: Array<{ value: string; label: string }>
  placeholder: string
  width?: string
}) {
  return (
    <Select
      items={items}
      value={value || null}
      onValueChange={(v) => onChange(v ?? "")}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel} className={`${width} text-xs`}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
