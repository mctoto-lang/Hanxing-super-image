import { requireSuperAdmin } from "@/lib/auth/session"
import { listSizeSpecsAction } from "@/server/actions/platform-product"
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
  SizeSpecFormDialog,
  SizeSpecEditButton,
  SizeSpecToggleActiveButton,
  type SizeSpecRow,
} from "@/components/superadmin/size-spec-form-dialog"
import { getPlatformDef } from "@/lib/product/dictionaries"

export const dynamic = "force-dynamic"

export default async function SizeSpecsPage() {
  await requireSuperAdmin()
  const specs: SizeSpecRow[] = await listSizeSpecsAction()

  // 按平台分组
  const groups = new Map<string, SizeSpecRow[]>()
  for (const s of specs) {
    const list = groups.get(s.platformKey) ?? []
    list.push(s)
    groups.set(s.platformKey, list)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">平台尺寸规范</h2>
          <p className="text-sm text-muted-foreground">
            平台有具体尺寸规范的出图尺寸（如 Amazon A+ 模块）；「图片比例」下拉的数据源
          </p>
        </div>
        <SizeSpecFormDialog />
      </div>

      {[...groups.entries()].map(([platformKey, rows]) => (
        <div key={platformKey} className="space-y-2">
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
                  <TableHead>尺寸名称</TableHead>
                  <TableHead>宽 × 高</TableHead>
                  <TableHead>比例</TableHead>
                  <TableHead className="hidden md:table-cell">说明</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id} className={s.isActive ? "" : "opacity-50"}>
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
      ))}

      {groups.size === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无尺寸规范，请点击右上角新增（或运行 pnpm seed:product-v2）
        </div>
      )}
    </div>
  )
}
