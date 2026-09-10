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
  DirectionEditButton,
  DirectionFormDialog,
  DirectionToggleActiveButton,
  type DirectionRow,
} from "@/components/superadmin/direction-form-dialog"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderDirectionsAction } from "@/server/actions/platform-product"

/**
 * 穿戴图片-服装组图方向配置（单作用域 appliesTo="weartry"）
 *
 * 与商品图片的方向配置共用 product_direction 表但作用域互斥，
 * 两端配置页完全分割（此处只显示/新增 weartry 作用域行）；
 * 顺序由行首手柄拖拽维护。
 */
export function WeartryDirectionsConfig({
  directions,
}: {
  directions: DirectionRow[]
}) {
  const rows = directions.filter((d) => d.appliesTo.includes("weartry"))
  const { ordered, rowProps, handleProps } = useDragSort({
    items: rows,
    commit: (ids) => reorderDirectionsAction(ids),
  })
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          服装组图 tab「生成类型」卡片池；数量可调的方向支持 1~maxCount 张
        </p>
        <DirectionFormDialog
          variant="weartry"
          defaultScope="weartry"
          triggerLabel="新增方向"
          title="新增方向"
          description="方向池供服装组图 tab 的生成类型卡片选择"
        />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" aria-label="拖动排序" />
              <TableHead>标识</TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="hidden md:table-cell">提示词模板</TableHead>
              <TableHead>数量</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  暂无方向，请点击右上角新增（或运行 pnpm seed:weartry）
                </TableCell>
              </TableRow>
            ) : (
              ordered.map((d) => (
                <TableRow
                  key={d.id}
                  {...rowProps(d.id, d.isActive ? "" : "opacity-50")}
                >
                  <TableCell className="w-8">
                    <DragHandle handleProps={handleProps(d.id)} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{d.key}</TableCell>
                  <TableCell>
                    <div className="font-medium">{d.name}</div>
                    {d.description && (
                      <div className="text-xs text-muted-foreground">
                        {d.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-[280px] truncate text-xs text-muted-foreground md:table-cell">
                    {d.promptTemplate}
                  </TableCell>
                  <TableCell className="text-xs">
                    {d.supportsCount ? `1-${d.maxCount} 张` : "1 张"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge
                        variant={d.isActive ? "default" : "outline"}
                        className="text-[10px]"
                      >
                        {d.isActive ? "启用" : "停用"}
                      </Badge>
                      {d.isHidden && (
                        <Badge variant="secondary" className="text-[10px]">
                          前端隐藏
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <DirectionEditButton row={d} variant="weartry" />
                      <DirectionToggleActiveButton id={d.id} isActive={d.isActive} />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
