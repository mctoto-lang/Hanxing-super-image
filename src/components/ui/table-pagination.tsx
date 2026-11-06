"use client"

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * 全站统一表格分页条（自库存 DataTable 抽出，TEMU 各表对齐同一口径）：
 * 共 N 条 + 每页条数 Select（可选）+ 第 x / y 页 + 首页/上一页/下一页/末页。
 * pageCount <= 1 时整条隐藏。
 */

const DEFAULT_PAGE_SIZE_OPTIONS = [20, 50, 100]

interface TablePaginationProps {
  /** 0-based 页索引 */
  pageIndex: number
  pageCount: number
  /** 总条数；传入则左侧显示「共 N 条」 */
  total?: number
  pageSize?: number
  pageSizeOptions?: number[]
  onPageChange: (pageIndex: number) => void
  /** 传入则显示每页条数 Select（调用方负责重置到第 1 页） */
  onPageSizeChange?: (pageSize: number) => void
  disabled?: boolean
  className?: string
}

export function TablePagination({
  pageIndex,
  pageCount,
  total,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  disabled,
  className,
}: TablePaginationProps) {
  if (pageCount <= 1) return null

  return (
    <div className={cn("flex items-center justify-between gap-3 px-1 text-sm", className)}>
      <div className="flex-1 text-muted-foreground">{total != null ? `共 ${total} 条` : null}</div>
      <div className="flex items-center gap-4">
        {onPageSizeChange && pageSize != null ? (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">每页</span>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => v && onPageSizeChange(Number(v))}
            >
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue>{pageSize} 条</SelectValue>
              </SelectTrigger>
              <SelectContent side="top">
                {pageSizeOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="hidden w-[80px] items-center justify-center font-medium tabular-nums sm:flex">
          第 {pageIndex + 1} / {pageCount} 页
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="hidden size-8 p-0 lg:flex"
            disabled={disabled || pageIndex <= 0}
            onClick={() => onPageChange(0)}
            title="首页"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="size-8 p-0"
            disabled={disabled || pageIndex <= 0}
            onClick={() => onPageChange(pageIndex - 1)}
            title="上一页"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="size-8 p-0"
            disabled={disabled || pageIndex >= pageCount - 1}
            onClick={() => onPageChange(pageIndex + 1)}
            title="下一页"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="hidden size-8 p-0 lg:flex"
            disabled={disabled || pageIndex >= pageCount - 1}
            onClick={() => onPageChange(pageCount - 1)}
            title="末页"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
