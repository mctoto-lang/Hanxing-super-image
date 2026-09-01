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
  SceneEditButton,
  SceneFormDialog,
  SceneToggleActiveButton,
  type SceneRow,
} from "@/components/superadmin/scene-form-dialog"

/** 预置场景配置列表（模特穿戴 tab「场景选择」数据源） */
export function ScenesConfig({ scenes }: { scenes: SceneRow[] }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          场景选定后其注入提示词会拼进模特穿戴生图模板（提示词注入）；
          停用后立即从用户端下拉消失
        </p>
        <SceneFormDialog />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>排序</TableHead>
              <TableHead>标识</TableHead>
              <TableHead>名称</TableHead>
              <TableHead className="hidden md:table-cell">注入提示词</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scenes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  暂无场景，请点击右上角新增（或运行 pnpm seed:weartry）
                </TableCell>
              </TableRow>
            ) : (
              scenes.map((s) => (
                <TableRow key={s.id} className={s.isActive ? "" : "opacity-50"}>
                  <TableCell className="tabular-nums">{s.sortOrder}</TableCell>
                  <TableCell className="font-mono text-xs">{s.key}</TableCell>
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-muted-foreground">
                        {s.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-[280px] truncate text-xs text-muted-foreground md:table-cell">
                    {s.promptTemplate}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={s.isActive ? "default" : "outline"}
                      className="text-[10px]"
                    >
                      {s.isActive ? "启用" : "停用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <SceneEditButton row={s} />
                      <SceneToggleActiveButton id={s.id} isActive={s.isActive} />
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
