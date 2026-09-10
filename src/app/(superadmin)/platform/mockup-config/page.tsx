import { requireSuperAdmin } from "@/lib/auth/session"
import { listPromptTemplatesConfigAction } from "@/server/actions/platform-product-config"
import { PromptTemplateFormDialog } from "@/components/superadmin/prompt-template-config-dialogs"
import type { PromptTemplateConfigRow } from "@/components/superadmin/prompt-template-config-dialogs"
import { PromptTemplatesTable } from "@/components/superadmin/prompt-templates-table"
import { MOCKUP_PROMPT_SCENE_LABELS } from "@/lib/mockup/prompt-defaults"

export const dynamic = "force-dynamic"

/**
 * 样机渲染提示词模板配置（平台级一份，product_prompt_template 按 mockup.* 前缀分割）
 *
 * AI背景：一键生成时以「当前渲染完成的样机图」为参考图、本模板为 prompt；
 * 停用或缺失时回退 src/lib/mockup/prompt-defaults.ts 内置默认。
 */
export default async function MockupPromptTemplatesConfigPage() {
  await requireSuperAdmin()
  const all = (await listPromptTemplatesConfigAction()) as PromptTemplateConfigRow[]
  const templates = all.filter((t) => t.scene.startsWith("mockup."))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          样机渲染 AI 功能的提示词（AI背景：参考图为样机渲染完成图）；
          停用或缺失时回退内置默认
        </p>
        <PromptTemplateFormDialog variant="mockup" />
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border py-8 text-center text-sm text-muted-foreground">
          暂无模板，请点击右上角新增；缺失场景运行时使用内置默认模板
        </div>
      ) : (
        <PromptTemplatesTable templates={templates} variant="mockup" />
      )}
      {templates.length < Object.keys(MOCKUP_PROMPT_SCENE_LABELS).length && (
        <p className="text-xs text-muted-foreground">
          尚有场景未建模板（共 {Object.keys(MOCKUP_PROMPT_SCENE_LABELS).length} 个：
          {Object.values(MOCKUP_PROMPT_SCENE_LABELS).join(" / ")}），
          缺失场景运行时使用内置默认模板
        </p>
      )}
    </div>
  )
}
