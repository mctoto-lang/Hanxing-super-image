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
import { PlanBadge } from "@/components/shared/plan-badge"
import { PlanEditButton } from "@/components/superadmin/plan-form-dialog"
import { PlanToggleButton } from "@/components/superadmin/plan-toggle-button"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import { reorderSubscriptionPlansAction } from "@/server/actions/platform-plans"

/** 行字段（listSubscriptionPlansAction items 的展示子集） */
export interface PlanTableRow {
  id: string
  name: string
  iconKey: string
  color: string
  creditsPerCycle: number
  cycleDays: number
  maxMembers: number | null
  sortOrder: number
  isActive: boolean
  enterpriseCount: number
}

/** 订阅套餐列表（行首手柄拖拽排序） */
export function PlansTable({ items }: { items: PlanTableRow[] }) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items,
    commit: (ids) => reorderSubscriptionPlansAction(ids),
  })

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" aria-label="拖动排序" />
          <TableHead>套餐 / 勋章</TableHead>
          <TableHead className="text-right">每周期积分</TableHead>
          <TableHead className="text-right">周期</TableHead>
          <TableHead className="text-right">人数上限</TableHead>
          <TableHead className="text-right">使用企业</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
              暂无套餐，点击右上角新建
            </TableCell>
          </TableRow>
        ) : (
          ordered.map((p) => (
            <TableRow key={p.id} {...rowProps(p.id)}>
              <TableCell className="w-8">
                <DragHandle handleProps={handleProps(p.id)} />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <PlanBadge
                    iconKey={p.iconKey}
                    color={p.color}
                    name={p.name}
                    size="md"
                  />
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.creditsPerCycle.toLocaleString("zh-CN")}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.cycleDays} 天
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.maxMembers ? `${p.maxMembers} 人` : "不限"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.enterpriseCount}
              </TableCell>
              <TableCell>
                <Badge variant={p.isActive ? "default" : "outline"}>
                  {p.isActive ? "启用" : "已停用"}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <PlanEditButton
                    plan={{
                      id: p.id,
                      name: p.name,
                      iconKey: p.iconKey,
                      color: p.color,
                      creditsPerCycle: p.creditsPerCycle,
                      cycleDays: p.cycleDays,
                      maxMembers: p.maxMembers,
                      sortOrder: p.sortOrder,
                      isActive: p.isActive,
                    }}
                  />
                  <PlanToggleButton
                    planId={p.id}
                    planName={p.name}
                    isActive={p.isActive}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
