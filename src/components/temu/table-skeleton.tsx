import { Skeleton } from "@/components/ui/skeleton"
import { TableCell, TableRow } from "@/components/ui/table"

/**
 * TEMU 各表统一加载骨架（shadcn Skeleton）：放进各表自己的 TableBody，
 * 返回 rows×cols 骨架行——列宽按（行序+列序）循环错落，比全宽更像真实数据；
 * colSpan 模式用于弹窗等整行合并场景。
 */

const CELL_WIDTHS = ["w-full", "w-4/5", "w-3/5", "w-2/3", "w-1/2"]

export function TableSkeletonRows({
  rows = 4,
  cols = 6,
  colSpan,
}: {
  /** 骨架行数 */
  rows?: number
  /** 每行列数（colSpan 模式忽略） */
  cols?: number
  /** 单条整行合并模式（列数未知/弹窗表） */
  colSpan?: number
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i} className="hover:bg-transparent">
          {colSpan ? (
            <TableCell colSpan={colSpan}>
              <Skeleton className="h-5 w-full" />
            </TableCell>
          ) : (
            Array.from({ length: cols }).map((__, j) => (
              <TableCell key={j}>
                <Skeleton className={`h-5 ${CELL_WIDTHS[(i + j) % CELL_WIDTHS.length]}`} />
              </TableCell>
            ))
          )}
        </TableRow>
      ))}
    </>
  )
}
