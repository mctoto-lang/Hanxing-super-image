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
  PresetModelEditButton,
  PresetModelToggleActiveButton,
} from "@/components/superadmin/preset-model-form-dialog"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import {
  reorderPresetModelsAction,
  type PresetModelRow,
} from "@/server/actions/platform-models"

const FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI 标准生图",
  jimeng: "即梦",
}

/**
 * 平台预置模型列表（行首手柄拖拽排序）。
 *
 * 列表分页 20/页：拖拽仅作用于当前页子集，reorder 按值重分配
 * （redistributeSortOrder）不改跨页相对顺序。拖动顺序即用户端
 * 创作页模型列表顺序。
 */
export function PresetModelsTable({ models }: { models: PresetModelRow[] }) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: models,
    commit: (ids) => reorderPresetModelsAction(ids),
  })

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" aria-label="拖动排序" />
          <TableHead>显示名</TableHead>
          <TableHead>接口</TableHead>
          <TableHead className="text-right">积分/张</TableHead>
          <TableHead>可见性</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((m) => (
          <TableRow key={m.id} {...rowProps(m.id)}>
            <TableCell className="w-8">
              <DragHandle handleProps={handleProps(m.id)} />
            </TableCell>
            <TableCell className="font-medium">{m.displayName}</TableCell>
            <TableCell className="text-sm">
              {FORMAT_LABEL[m.apiFormat] ?? m.apiFormat}
              {m.supportsReferenceImage ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  · 参考图
                </span>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {m.costPerImage}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {m.visibleInCreate ? (
                  <Badge variant="outline" className="text-xs">
                    创作
                  </Badge>
                ) : null}
                {m.visibleInWorkspace ? (
                  <Badge variant="outline" className="text-xs">
                    批量
                  </Badge>
                ) : null}
                {m.visibleInProduct ? (
                  <Badge variant="outline" className="text-xs">
                    商品
                  </Badge>
                ) : null}
                {m.visibleInWeartry ? (
                  <Badge variant="outline" className="text-xs">
                    穿戴
                  </Badge>
                ) : null}
                {m.visibleInMockup ? (
                  <Badge variant="outline" className="text-xs">
                    样机
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              {m.isActive ? (
                <Badge>启用</Badge>
              ) : (
                <Badge variant="outline">停用</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <PresetModelEditButton model={m} />
                <PresetModelToggleActiveButton model={m} />
              </div>
            </TableCell>
          </TableRow>
        ))}
        {ordered.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground">
              暂无平台预置模型，点击右上角新建
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}
