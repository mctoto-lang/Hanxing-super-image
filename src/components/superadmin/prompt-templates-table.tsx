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
  PromptTemplateEditButton,
  PromptTemplateToggleActiveButton,
  type PromptTemplateConfigRow,
} from "@/components/superadmin/prompt-template-config-dialogs"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderPromptTemplatesConfigAction } from "@/server/actions/platform-product-config"

/** 单组（或全表不分组的）模板拖拽表格 */
function GroupTable({
  rows,
  variant,
}: {
  rows: PromptTemplateConfigRow[]
  variant: "product" | "weartry" | "mockup"
}) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: rows,
    commit: (ids) => reorderPromptTemplatesConfigAction(ids),
  })
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" aria-label="拖动排序" />
            <TableHead>模板名称</TableHead>
            <TableHead>场景（scene）</TableHead>
            <TableHead className="hidden md:table-cell">模板内容</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                暂无模板，请点击右上角新增
              </TableCell>
            </TableRow>
          ) : (
            ordered.map((t) => (
              <TableRow
                key={t.id}
                {...rowProps(t.id, t.isActive ? "" : "opacity-50")}
              >
                <TableCell className="w-8">
                  <DragHandle handleProps={handleProps(t.id)} />
                </TableCell>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="font-mono text-xs">{t.scene}</TableCell>
                <TableCell className="hidden max-w-[360px] truncate text-xs text-muted-foreground md:table-cell">
                  {t.template}
                </TableCell>
                <TableCell>
                  <Badge variant={t.isActive ? "default" : "outline"}>
                    {t.isActive ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <PromptTemplateEditButton row={t} variant={variant} />
                    <PromptTemplateToggleActiveButton id={t.id} isActive={t.isActive} />
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

/**
 * 提示词模板列表（行首手柄拖拽排序）。
 *
 * 传 groupLabels 时按 scene 前缀分组展示（商品端：套图/A+详情页/爆款复刻），
 * 每组独立拖拽（reorder 值重分配不影响其它组）；不传则单表全量拖拽
 * （穿戴/样机端）。运行时取值按 sortOrder 全表排序，组内顺序即生效顺序。
 */
export function PromptTemplatesTable({
  templates,
  variant,
  groupLabels,
  groupOrder,
}: {
  templates: PromptTemplateConfigRow[]
  variant: "product" | "weartry" | "mockup"
  /** scene 前缀 → 分组标题；不传 = 不分组单表 */
  groupLabels?: Record<string, string>
  /** 分组展示顺序（前缀数组） */
  groupOrder?: string[]
}) {
  if (!groupLabels) {
    return <GroupTable rows={templates} variant={variant} />
  }

  const groups = new Map<string, PromptTemplateConfigRow[]>()
  for (const t of templates) {
    const g = t.scene.split(".")[0] ?? "其他"
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(t)
  }
  const ordered = [...groups.entries()].sort(
    (a, b) =>
      (groupOrder?.indexOf(a[0]) ?? 99) - (groupOrder?.indexOf(b[0]) ?? 99),
  )

  return (
    <div className="space-y-4">
      {ordered.map(([group, rows]) => (
        <div key={group} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {groupLabels[group] ?? group}
          </h2>
          <GroupTable rows={rows} variant={variant} />
        </div>
      ))}
    </div>
  )
}
