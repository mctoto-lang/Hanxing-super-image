import { cn } from "@/lib/utils"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

/**
 * 管理端表格底部分页（服务端组件，shadcn pagination 封装）
 *
 * 以 Link + query 参数驱动（?page=N），翻页由服务端页面重新取数；
 * 自动保留其它搜索参数（如 /admin/users 的 q）。
 * 仅在数据超过一页（表格长到需要分页）时渲染；单页时靠内容区滚动浏览。
 */
export function TablePagination({
  page,
  pageSize,
  total,
  basePath,
  query = {},
  className,
}: {
  /** 当前页（从 1 开始） */
  page: number
  pageSize: number
  total: number
  /** 路由路径，如 /admin/users */
  basePath: string
  /** 需要保留的其它 query 参数（不含 page） */
  query?: Record<string, string | string[] | undefined>
  className?: string
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (!value) continue
      if (Array.isArray(value)) {
        for (const v of value) if (v) params.append(key, v)
      } else {
        params.set(key, value)
      }
    }
    if (targetPage > 1) params.set("page", String(targetPage))
    const qs = params.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  // 页码窗口：总页数 ≤ 7 全量展示；否则 首页 + 当前±2 + 末页 + 省略号
  const pageNumbers: (number | "ellipsis-start" | "ellipsis-end")[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i)
  } else {
    pageNumbers.push(1)
    const start = Math.max(2, page - 1)
    const end = Math.min(totalPages - 1, page + 1)
    if (start > 2) pageNumbers.push("ellipsis-start")
    for (let i = start; i <= end; i++) pageNumbers.push(i)
    if (end < totalPages - 1) pageNumbers.push("ellipsis-end")
    pageNumbers.push(totalPages)
  }

  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t bg-muted/50 p-4",
        className,
      )}
    >
      <p className="text-xs text-muted-foreground">
        共 {total.toLocaleString("zh-CN")} 条 · 第 {page}/{totalPages} 页
      </p>
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href={buildHref(Math.max(1, page - 1))}
              aria-disabled={page <= 1}
              className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
            />
          </PaginationItem>
          {pageNumbers.map((p) =>
            typeof p === "number" ? (
              <PaginationItem key={p}>
                <PaginationLink href={buildHref(p)} isActive={p === page}>
                  {p}
                </PaginationLink>
              </PaginationItem>
            ) : (
              <PaginationItem key={p}>
                <PaginationEllipsis />
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <PaginationNext
              href={buildHref(Math.min(totalPages, page + 1))}
              aria-disabled={page >= totalPages}
              className={
                page >= totalPages ? "pointer-events-none opacity-50" : undefined
              }
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}

/** 解析页面 searchParams 中的 page 参数（缺省 1，非法回退 1） */
export function parsePageParam(
  searchParams: Record<string, string | string[] | undefined>,
): number {
  const raw = searchParams.page
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = Number.parseInt(value ?? "1", 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** 提取单值 query 参数（如 q） */
export function parseQueryParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const raw = searchParams[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return (value ?? "").trim()
}
