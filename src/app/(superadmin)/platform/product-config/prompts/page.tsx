import { requireSuperAdmin } from "@/lib/auth/session"
import { listPromptTemplatesConfigAction } from "@/server/actions/platform-product-config"
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
  PromptTemplateFormDialog,
  PromptTemplateEditButton,
  PromptTemplateToggleActiveButton,
  type PromptTemplateConfigRow,
} from "@/components/superadmin/prompt-template-config-dialogs"
import { PROMPT_SCENE_GROUP_LABELS } from "@/lib/product/prompt-defaults"

export const dynamic = "force-dynamic"

const groupOf = (scene: string) => scene.split(".")[0] ?? "其他"
const groupOrder = ["suite", "detail", "replicate"]

export default async function ProductPromptTemplatesConfigPage() {
  await requireSuperAdmin()
  const all = (await listPromptTemplatesConfigAction()) as PromptTemplateConfigRow[]
  // 穿戴场景（weartry.*）归「穿戴图片管理」配置中心，此处不展示（两端完全分割）
  const templates = all.filter((t) => !t.scene.startsWith("weartry."))

  // 按子功能分组展示（套图 / A+详情页 / 爆款复刻）
  const groups = new Map<string, PromptTemplateConfigRow[]>()
  for (const t of templates) {
    const g = groupOf(t.scene)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(t)
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => (groupOrder.indexOf(a[0]) ?? 99) - (groupOrder.indexOf(b[0]) ?? 99),
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          商品图片各环节的预组装提示词（AI 帮写 / 智能匹配 / 风格基座 / 复刻程度）；停用或缺失时回退内置默认
        </p>
        <PromptTemplateFormDialog />
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border py-8 text-center text-sm text-muted-foreground">
          暂无模板，请点击右上角新增（或运行 pnpm seed:product-v2）
        </div>
      ) : (
        ordered.map(([group, rows]) => (
          <div key={group} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {PROMPT_SCENE_GROUP_LABELS[group] ?? group}
            </h2>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>模板名称</TableHead>
                    <TableHead>场景（scene）</TableHead>
                    <TableHead className="hidden md:table-cell">模板内容</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((t) => (
                    <TableRow key={t.id} className={t.isActive ? "" : "opacity-50"}>
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
                          <PromptTemplateEditButton row={t} />
                          <PromptTemplateToggleActiveButton id={t.id} isActive={t.isActive} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
