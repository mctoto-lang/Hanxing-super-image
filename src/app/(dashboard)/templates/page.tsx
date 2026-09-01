import { requireEnterpriseContext } from "@/lib/auth/session"
import { PromptTemplateManager } from "@/components/templates/prompt-template-manager"

export const dynamic = "force-dynamic"

export default async function TemplatesPage() {
  const ctx = await requireEnterpriseContext()
  // 提示词模板仅被批量生图消费，跟随 workspace 模块权限（手册 §5.1）
  if (!ctx.canAccess("workspace")) {
    throw new Error("FORBIDDEN: 无权访问该模块（workspace）")
  }
  return <PromptTemplateManager />
}
