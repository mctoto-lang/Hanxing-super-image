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
  PlatformEditButton,
  PlatformToggleActiveButton,
  type PlatformConfigRow,
} from "@/components/superadmin/platform-config-dialogs"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderPlatformsConfigAction } from "@/server/actions/platform-product-config"

/** 上架平台列表（行首手柄拖拽排序；顺序即商品页平台下拉顺序） */
export function PlatformsConfigTable({
  platforms,
}: {
  platforms: PlatformConfigRow[]
}) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: platforms,
    commit: (ids) => reorderPlatformsConfigAction(ids),
  })
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" aria-label="拖动排序" />
            <TableHead>标识</TableHead>
            <TableHead>平台名称</TableHead>
            <TableHead className="hidden md:table-cell">主图规范提示词</TableHead>
            <TableHead className="hidden md:table-cell">通用偏好提示词</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                暂无平台，请点击右上角新增（或运行 pnpm seed:product-v2）
              </TableCell>
            </TableRow>
          ) : (
            ordered.map((p) => (
              <TableRow
                key={p.id}
                {...rowProps(p.id, p.isActive ? "" : "opacity-50")}
              >
                <TableCell className="w-8">
                  <DragHandle handleProps={handleProps(p.id)} />
                </TableCell>
                <TableCell className="font-mono text-xs">{p.key}</TableCell>
                <TableCell className="font-medium">{p.label}</TableCell>
                <TableCell className="hidden max-w-[220px] truncate text-xs text-muted-foreground md:table-cell">
                  {p.heroPromptSegment || "—"}
                </TableCell>
                <TableCell className="hidden max-w-[220px] truncate text-xs text-muted-foreground md:table-cell">
                  {p.generalPromptSegment || "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={p.isActive ? "default" : "outline"}>
                    {p.isActive ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <PlatformEditButton row={p} />
                    <PlatformToggleActiveButton id={p.id} isActive={p.isActive} />
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
