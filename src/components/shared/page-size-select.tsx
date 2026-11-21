"use client"

import { useRouter } from "next/navigation"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * 每页显示数量选择（URL 驱动分页页脚用；TablePagination 服务端渲染内嵌）。
 * 切换后保留其余 query、重置回第 1 页。
 */
export function PageSizeSelect({
  basePath,
  query = {},
  pageSize,
  options,
}: {
  basePath: string
  /** 需要保留的其它 query 参数（不含 page/pageSize） */
  query?: Record<string, string | string[] | undefined>
  pageSize: number
  options: number[]
}) {
  const router = useRouter()
  const onChange = (v: string | null) => {
    const next = Number(v ?? options[0])
    if (!Number.isFinite(next) || next === pageSize) return
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (!value) continue
      if (Array.isArray(value)) {
        for (const vq of value) if (vq) params.append(key, vq)
      } else {
        params.set(key, value)
      }
    }
    // 首选项 = 默认页大小（不落 URL）；其余显式带 pageSize
    if (next !== options[0]) params.set("pageSize", String(next))
    const qs = params.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath)
  }

  return (
    <Select
      items={options.map((o) => ({ value: String(o), label: `${o} 条/页` }))}
      value={String(pageSize)}
      onValueChange={onChange}
    >
      <SelectTrigger size="sm" aria-label="每页显示数量" className="h-7 w-26 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={String(o)}>
            {o} 条/页
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
