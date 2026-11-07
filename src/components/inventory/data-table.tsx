"use client"

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TablePagination } from "@/components/ui/table-pagination"
import { ScrollJumpButtons } from "@/components/ui/scroll-jump-buttons"
import { TableSkeletonRows } from "@/components/temu/table-skeleton"

/**
 * 库存域 Data Table 封装（TanStack Table v8 + shadcn dashboard-01 模板观感）
 *
 * 模板口径：三段式（工具栏在卡片外/表格独立 rounded-lg border 卡片/分页条在
 * 卡片下方）、行底横线 + 列竖线可选（columnDividers，TEMU 六表同款类名模板）、
 * 表头 sticky bg-muted、text-sm、单元格 px-3 py-2.5、勾选行 data-state=selected
 * 高亮、模板分页条。列经 meta.align 可右对齐/居中（居中用于勾选框、徽章列；
 * 库存域其余口径：全列左对齐）。
 * 注意：必须用裸 <table>——ui Table 自带 overflow-x-auto 包裹 div 会成为最近
 * 滚动祖先且高度随内容撑开，th 的 sticky top-0 永远不触发（TEMU 表同结论）。
 * 内置：列排序（点击表头）、前端筛选/分页，
 * 或 infinite 无限加载（渐进渲染：数据全量在内存，滚动到底逐批露出，无分页条）。
 */

export type { ColumnDef }

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ColumnMeta<TData extends RowData, TValue> {
    /** 对齐：right=数字列右对齐（tabular-nums 由调用方自带）；
        center=勾选框/徽章/图标等居中列 */
    align?: "left" | "center" | "right"
  }
}

const PAGE_SIZE_OPTIONS = [20, 50, 100]

/** 无限加载模式每批露出行数（渐进渲染，防全量渲染卡顿；口径同 TEMU 商品表） */
const ROW_STEP = 40

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[]
  data: TData[]
  /** 表格外层容器额外类名（高度链/滚动控制） */
  containerClassName?: string
  /** 初始排序 */
  initialSorting?: SortingState
  /** 空态内容 */
  empty?: React.ReactNode
  /** 加载中且无行：显示骨架行（shadcn Skeleton，宽度错落；空态仅在非加载中显示） */
  loading?: boolean
  /** 行点击 */
  onRowClick?: (row: TData) => void
  pageSize?: number
  /** 勾选行高亮判定（整行 data-state=selected 底色） */
  isRowSelected?: (row: TData) => boolean
  /** 无限加载（渐进渲染）：隐藏分页条，滚动到底逐批露出（哨兵 IntersectionObserver） */
  infinite?: boolean
  /** 列间竖向分割线（第一列无线；TEMU 六表同款类名模板） */
  columnDividers?: boolean
  /** 数据替换（编辑/出入库后 load 刷新）时保持滚动位置与已加载行数：
      调用方须在 setRows 的同一同步序列内把 ref 置 true（本组件消费后自动
      复位 false），不得在 await 之前提前置位——网络往返窗口内任何 data
      引用变化（筛选/搜索派生的新数组、交错请求先到的 setRows）都会消费/
      偷走该标志，导致保位丢失或位置错误恢复；
      缺省（筛选/搜索换数据集）数据变化仍从头露出并回顶 */
  preserveScrollRef?: React.RefObject<boolean>
  /** 挂载跳转顶部/底部悬浮按钮（贴滚动容器右下角；点按跳转/按住慢滚） */
  scrollJump?: boolean
}

export function DataTable<TData>({
  columns,
  data,
  containerClassName,
  initialSorting,
  empty,
  loading,
  onRowClick,
  pageSize: initialPageSize = 20,
  isRowSelected,
  infinite,
  columnDividers,
  preserveScrollRef,
  scrollJump,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting ?? [])
  const [clientPagination, setClientPagination] = React.useState({
    pageIndex: 0,
    pageSize: initialPageSize,
  })
  const [visibleCount, setVisibleCount] = React.useState(ROW_STEP)
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const table = useReactTable({
    data,
    columns,
    state: { sorting, pagination: clientPagination },
    onSortingChange: setSorting,
    onPaginationChange: setClientPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  const allRows = infinite ? table.getSortedRowModel().rows : table.getRowModel().rows
  const rows = infinite ? allRows.slice(0, visibleCount) : allRows
  const pageIndex = table.getState().pagination.pageIndex
  const pageSize = table.getState().pagination.pageSize
  const pageCount = table.getPageCount()
  const total = table.getFilteredRowModel().rows.length

  const gotoPage = (i: number) => table.setPageIndex(i)
  const changePageSize = (n: number) => setClientPagination({ pageIndex: 0, pageSize: n })

  // 无限加载·数据替换：preserveScrollRef 为真（编辑/出入库刷新）→ 保持
  // 滚动位置与已加载数；否则（筛选/搜索换数据集）→ 从头露出并回顶。
  // 必须用每渲染的 layoutEffect：data 变化的 commit 里浏览器已按新内容
  // clamp 过 scrollTop，旧位置只能取自上一轮记录的 posRef
  const prevDataRef = React.useRef(data)
  const posRef = React.useRef(0)
  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!infinite || !el) return
    if (prevDataRef.current === data) {
      posRef.current = el.scrollTop
      return
    }
    prevDataRef.current = data
    if (preserveScrollRef?.current) {
      preserveScrollRef.current = false
      el.scrollTop = Math.min(posRef.current, Math.max(0, el.scrollHeight - el.clientHeight))
      posRef.current = el.scrollTop
    } else {
      setVisibleCount(ROW_STEP)
      el.scrollTop = 0
      posRef.current = 0
    }
  })

  // 无限加载：排序变化时从头露出并回滚顶部
  React.useEffect(() => {
    if (!infinite) return
    setVisibleCount(ROW_STEP)
    scrollRef.current?.scrollTo({ top: 0 })
    posRef.current = 0
  }, [infinite, sorting])

  // 无限加载·滚动位置实时记录（passive）：data 替换的恢复值必须取自
  // 「最后一次滚动」而非「最后一次渲染」——渲染 commit 之间发生的滚动
  // 不会被 layoutEffect 察觉，过期 posRef 会把位置恢复到旧值
  React.useEffect(() => {
    const el = scrollRef.current
    if (!infinite || !el) return
    const onScroll = () => {
      posRef.current = el.scrollTop
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [infinite])

  // 无限加载：哨兵进入视口（200px 预载）→ 露出下一批
  React.useEffect(() => {
    if (!infinite) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisibleCount((prev) => prev + ROW_STEP)
      },
      { rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [infinite])

  return (
    // relative：ScrollJumpButtons 的 absolute 定位包含块（见下方挂载点说明）
    <div className={cn("relative flex min-h-0 flex-col gap-4", containerClassName)}>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-auto rounded-lg border scrollbar-hide"
      >
        <table
          className={cn(
            "w-full caption-bottom text-sm",
            columnDividers &&
              "[&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border",
          )}
        >
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  const align = header.column.columnDef.meta?.align
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        // 库存域表头不加粗（覆写 ui TableHead 基类 font-medium）
                        "sticky top-0 z-10 h-11 bg-muted px-3 font-normal",
                        canSort && "cursor-pointer select-none",
                        align === "right" && "text-right",
                        // 勾选框列：基类 [&:has([role=checkbox])]:pr-0 只去右内边距，
                        // 左 12px 残留会把勾选框顶到右缘——补对称 pl-0 才真居中
                        align === "center" &&
                          "text-center [&:has([role=checkbox])]:pl-0",
                      )}
                      onClick={
                        canSort ? header.column.getToggleSortingHandler() : undefined
                      }
                    >
                      {/* 块级 flex + h-full 垂直居中：勾选框表头不参与行内基线
                          （inline-flex 的纯勾选框基线=下边缘，会比文字列头上浮） */}
                      <span
                        className={cn(
                          "flex h-full items-center gap-1",
                          align === "right" && "justify-end",
                          align === "center" && "justify-center",
                        )}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && (
                          <>
                            {sorted === "asc" ? (
                              <ArrowUp className="size-3" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ArrowUpDown className="size-3 opacity-40" />
                            )}
                          </>
                        )}
                      </span>
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((row) => {
                const selected = isRowSelected?.(row.original) ?? false
                return (
                  <TableRow
                    key={row.id}
                    data-state={selected ? "selected" : undefined}
                    className={cn(onRowClick && "cursor-pointer")}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "px-3 py-2.5",
                          cell.column.columnDef.meta?.align === "right" && "text-right",
                          cell.column.columnDef.meta?.align === "center" &&
                            "text-center [&:has([role=checkbox])]:pl-0",
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            ) : loading ? (
              <TableSkeletonRows rows={5} cols={columns.length} />
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {empty ?? "暂无数据"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </table>
        {infinite ? (
          <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
            {allRows.length > 0 && visibleCount >= allRows.length
              ? `已全部加载 ${allRows.length} 条`
              : ""}
          </div>
        ) : null}
      </div>
      {/* 跳转按钮须挂在本层（滚动容器外）：容器 overflow-x-auto 双向滚动，
          sticky 的包含块是容器盒，宽表横滚时 sticky right 只能向左推入包含块、
          不能把按钮拉到视口右缘（随内容滚出视口）。改 absolute 贴外层右下角
          ——外层不横滚，纵横均贴视口缘；滚动行为仍绑 scrollRef */}
      {scrollJump && infinite ? (
        <ScrollJumpButtons
          containerRef={scrollRef}
          className="absolute z-10 ml-0 mr-0 mb-0"
        />
      ) : null}
      {!infinite ? (
        <TablePagination
          pageIndex={pageIndex}
          pageCount={pageCount}
          total={total}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={gotoPage}
          onPageSizeChange={changePageSize}
        />
      ) : null}
    </div>
  )
}
