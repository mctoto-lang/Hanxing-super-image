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
  SizeSpecEditButton,
  SizeSpecToggleActiveButton,
  type SizeSpecRow,
} from "@/components/superadmin/size-spec-form-dialog"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderSizeSpecsAction } from "@/server/actions/platform-product"
import { getPlatformDef } from "@/lib/product/dictionaries"

/** 单平台组的尺寸规范拖拽表格（组内顺序即「图片比例」下拉顺序） */
function PlatformGroup({ platformKey, rows }: { platformKey: string; rows: SizeSpecRow[] }) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: rows,
    commit: (ids) => reorderSizeSpecsAction(ids),
  })
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">
        {getPlatformDef(platformKey)?.label ?? platformKey}
        <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
          {platformKey}
        </span>
      </h3>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" aria-label="拖动排序" />
              <TableHead>尺寸名称</TableHead>
              <TableHead>宽 × 高</TableHead>
              <TableHead>比例</TableHead>
              <TableHead className="hidden md:table-cell">说明</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((s) => (
              <TableRow
                key={s.id}
                {...rowProps(s.id, s.isActive ? "" : "opacity-50")}
              >
                <TableCell className="w-8">
                  <DragHandle handleProps={handleProps(s.id)} />
                </TableCell>
                <TableCell className="font-medium">{s.label}</TableCell>
                <TableCell className="tabular-nums">
                  {s.width} × {s.height}
                </TableCell>
                <TableCell>{s.ratioLabel ?? "—"}</TableCell>
                <TableCell className="hidden max-w-[300px] truncate text-xs text-muted-foreground md:table-cell">
                  {s.note ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={s.isActive ? "default" : "outline"}>
                    {s.isActive ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <SizeSpecEditButton row={s} />
                    <SizeSpecToggleActiveButton id={s.id} isActive={s.isActive} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/** 平台尺寸规范列表（按平台分组，组内行首手柄拖拽排序） */
export function SizeSpecsTable({ specs }: { specs: SizeSpecRow[] }) {
  const groups = new Map<string, SizeSpecRow[]>()
  for (const s of specs) {
    const list = groups.get(s.platformKey) ?? []
    list.push(s)
    groups.set(s.platformKey, list)
  }
  return (
    <>
      {[...groups.entries()].map(([platformKey, rows]) => (
        <PlatformGroup key={platformKey} platformKey={platformKey} rows={rows} />
      ))}
    </>
  )
}
