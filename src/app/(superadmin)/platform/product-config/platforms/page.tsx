import { requireSuperAdmin } from "@/lib/auth/session"
import { listPlatformsConfigAction } from "@/server/actions/platform-product-config"
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
  PlatformFormDialog,
  PlatformEditButton,
  PlatformToggleActiveButton,
  type PlatformConfigRow,
} from "@/components/superadmin/platform-config-dialogs"

export const dynamic = "force-dynamic"

export default async function ProductPlatformsConfigPage() {
  await requireSuperAdmin()
  const platforms = (await listPlatformsConfigAction()) as PlatformConfigRow[]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          用户选择平台后，生图按此处预配置的提示词组织；表空时回退内置常量
        </p>
        <PlatformFormDialog />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>排序</TableHead>
              <TableHead>标识</TableHead>
              <TableHead>平台名称</TableHead>
              <TableHead className="hidden md:table-cell">主图规范提示词</TableHead>
              <TableHead className="hidden md:table-cell">通用偏好提示词</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {platforms.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  暂无平台，请点击右上角新增（或运行 pnpm seed:product-v2）
                </TableCell>
              </TableRow>
            ) : (
              platforms.map((p) => (
                <TableRow key={p.id} className={p.isActive ? "" : "opacity-50"}>
                  <TableCell className="tabular-nums">{p.sortOrder}</TableCell>
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
    </div>
  )
}
