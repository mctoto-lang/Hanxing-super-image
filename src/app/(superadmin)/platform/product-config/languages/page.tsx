import { requireSuperAdmin } from "@/lib/auth/session"
import { listLanguagesConfigAction } from "@/server/actions/platform-product-config"
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
  LanguageFormDialog,
  LanguageEditButton,
  LanguageToggleActiveButton,
  type LanguageConfigRow,
} from "@/components/superadmin/language-config-dialogs"

export const dynamic = "force-dynamic"

export default async function ProductLanguagesConfigPage() {
  await requireSuperAdmin()
  const languages = (await listLanguagesConfigAction()) as LanguageConfigRow[]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          控制生图图内文字语言与 AI 帮写输出语言；表空时回退内置常量
        </p>
        <LanguageFormDialog />
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>排序</TableHead>
              <TableHead>标识</TableHead>
              <TableHead>显示名称</TableHead>
              <TableHead>输出语言名</TableHead>
              <TableHead className="hidden md:table-cell">图内文字指令</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {languages.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  暂无语言，请点击右上角新增（或运行 pnpm seed:product-v2）
                </TableCell>
              </TableRow>
            ) : (
              languages.map((l) => (
                <TableRow key={l.id} className={l.isActive ? "" : "opacity-50"}>
                  <TableCell className="tabular-nums">{l.sortOrder}</TableCell>
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
    </div>
  )
}
