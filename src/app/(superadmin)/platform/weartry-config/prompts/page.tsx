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
  PromptTemplateEditButton,
  PromptTemplateFormDialog,
  PromptTemplateToggleActiveButton,
  type PromptTemplateConfigRow,
} from "@/components/superadmin/prompt-template-config-dialogs"
import { WEARTRY_PROMPT_SCENE_LABELS } from "@/lib/weartry/prompt-defaults"

export const dynamic = "force-dynamic"

export default async function WeartryPromptTemplatesConfigPage() {
  await requireSuperAdmin()
  const all = (await listPromptTemplatesConfigAction()) as PromptTemplateConfigRow[]
  // 只展示穿戴场景（weartry.*）；商品场景归商品图片配置中心（两端完全分割）
  const templates = all.filter((t) => t.scene.startsWith("weartry."))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          穿戴图片各环节的预组装提示词（AI 帮写 / 模特形象 / 穿戴生图 /
          换色）；停用或缺失时回退内置默认
        </p>
        <PromptTemplateFormDialog variant="weartry" />
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border py-8 text-center text-sm text-muted-foreground">
          暂无模板，请点击右上角新增（或运行 pnpm seed:weartry）
        </div>
      ) : (
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
              {templates.map((t) => (
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
                      <PromptTemplateEditButton row={t} variant="weartry" />
                      <PromptTemplateToggleActiveButton
                        id={t.id}
                        isActive={t.isActive}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {templates.length < 5 && (
        <p className="text-xs text-muted-foreground">
          尚有场景未建模板（共 5 个：{Object.values(WEARTRY_PROMPT_SCENE_LABELS).join(" / ")}），
          缺失场景运行时使用内置默认模板
        </p>
      )}
    </div>
  )
}
