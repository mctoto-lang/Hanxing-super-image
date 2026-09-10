"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  LanguageEditButton,
  LanguageToggleActiveButton,
  type LanguageConfigRow,
} from "@/components/superadmin/language-config-dialogs"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderLanguagesConfigAction } from "@/server/actions/platform-product-config"

/** 语言列表（行首手柄拖拽排序；顺序即商品页语言下拉顺序） */
export function LanguagesConfigTable({
  languages,
}: {
  languages: LanguageConfigRow[]
}) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: languages,
    commit: (ids) => reorderLanguagesConfigAction(ids),
  })
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" aria-label="拖动排序" />
            <TableHead>标识</TableHead>
            <TableHead>显示名称</TableHead>
            <TableHead>输出语言名</TableHead>
            <TableHead className="hidden md:table-cell">图内文字指令</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                暂无语言，请点击右上角新增（或运行 pnpm seed:product-v2）
              </TableCell>
            </TableRow>
          ) : (
            ordered.map((l) => (
              <TableRow
                key={l.id}
                {...rowProps(l.id, l.isActive ? "" : "opacity-50")}
              >
                <TableCell className="w-8">
                  <DragHandle handleProps={handleProps(l.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs">{l.key}</TableCell>
                <TableCell className="font-medium">{l.label}</TableCell>
                <TableCell className="text-xs">{l.outputName}</TableCell>
                <TableCell className="hidden max-w-[260px] truncate text-xs text-muted-foreground md:table-cell">
                  {l.imageDirective || "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={l.isActive ? "default" : "outline"}>
                    {l.isActive ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <LanguageEditButton row={l} />
                    <LanguageToggleActiveButton id={l.id} isActive={l.isActive} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
