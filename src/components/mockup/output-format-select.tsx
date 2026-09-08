"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type MockupOutputFormat = "png" | "jpeg" | "psd"

const OPTIONS: { value: MockupOutputFormat; label: string }[] = [
  { value: "png", label: "PNG 图片" },
  { value: "jpeg", label: "JPG 图片" },
  { value: "psd", label: "PSD 源文件" },
]

/** 渲染导出格式选择（提交时生效；PSD=保留图层的源文件，JPG 体积更小） */
export function MockupOutputFormatSelect({
  value,
  onChange,
}: {
  value: MockupOutputFormat
  onChange: (v: MockupOutputFormat) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v && onChange(v as MockupOutputFormat)}
    >
      <SelectTrigger
        aria-label="导出格式"
        size="sm"
        className="w-[110px] rounded-[min(var(--radius-md),12px)] text-xs"
      >
        <SelectValue>{OPTIONS.find((o) => o.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
