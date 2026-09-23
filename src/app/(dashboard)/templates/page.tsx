import { requireEnterpriseContext } from "@/lib/auth/session"
import { PromptTemplateManager } from "@/components/templates/prompt-template-manager"
import { NoPermission } from "@/components/shared/no-permission"

export const dynamic = "force-dynamic"

export default async function TemplatesPage() {
  const ctx = await requireEnterpriseContext()
  // 提示词模板仅被批量生图消费，跟随 workspace 模块权限（手册 §5.1）
  if (!ctx.canAccess("workspace")) {
    return <NoPermission module="模板管理" description="提示词模板跟随「批量生图」模块权限，请联系企业管理员开通后再试。" />
  }
  return <PromptTemplateManager />
}
