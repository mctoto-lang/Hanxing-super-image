import { requireSuperAdmin } from "@/lib/auth/session"
import { listPromptTemplatesConfigAction } from "@/server/actions/platform-product-config"
import { PromptTemplateFormDialog } from "@/components/superadmin/prompt-template-config-dialogs"
import type { PromptTemplateConfigRow } from "@/components/superadmin/prompt-template-config-dialogs"
import { PromptTemplatesTable } from "@/components/superadmin/prompt-templates-table"
import { PROMPT_SCENE_GROUP_LABELS } from "@/lib/product/prompt-defaults"

export const dynamic = "force-dynamic"

const groupOrder = ["suite", "detail", "replicate"]

export default async function ProductPromptTemplatesConfigPage() {
  await requireSuperAdmin()
  const all = (await listPromptTemplatesConfigAction()) as PromptTemplateConfigRow[]
  // 穿戴场景（weartry.*）归「穿戴图片管理」配置中心，此处不展示（两端完全分割）
  const templates = all.filter((t) => !t.scene.startsWith("weartry."))

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
        <PromptTemplatesTable
          templates={templates}
          variant="product"
          groupLabels={PROMPT_SCENE_GROUP_LABELS}
          groupOrder={groupOrder}
        />
      )}
    </div>
  )
}
