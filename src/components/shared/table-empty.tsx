import { TableCell, TableRow } from "@/components/ui/table"

/**
 * 管理端表格空状态行（企业管理双侧统一口径）
 *
 * 两态文案：无筛选 = 「暂无X」；处于筛选/搜索 = 「没有符合筛选条件的X」。
 * 替换各页手写空行（此前写法四样：有无 py-8、位置 map 前后不一、文案粒度不一）。
 */
export function TableEmpty({
  colSpan,
  noun,
  filtered = false,
}: {
  colSpan: number
  /** 空态名词，如「成员」「权限组」「流水」 */
  noun: string
  /** 当前是否处于筛选/搜索状态（true 显示无结果文案） */
  filtered?: boolean
}) {
  return (
    <TableRow>
      <TableCell
        colSpan={colSpan}
        className="py-8 text-center text-muted-foreground"
      >
        {filtered ? `没有符合筛选条件的${noun}` : `暂无${noun}`}
      </TableCell>
    </TableRow>
  )
}
