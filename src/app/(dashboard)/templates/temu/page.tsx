import { requireEnterpriseContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { TemuTemplateManager } from "@/components/temu/publish/template-manager"

export const dynamic = "force-dynamic"

export default async function TemuPublishTemplatesPage() {
  const ctx = await requireEnterpriseContext()
  // TEMU 刊登模板跟随 temu 模块权限（与 /temu 数据面板同口径）
  if (!ctx.canAccess("temu")) {
    return (
      <NoPermission
        module="TEMU刊登模板"
        description="当前企业未开通 TEMU 模块，请联系平台管理员在企业管理中启用。"
      />
    )
  }
  // 可查看 TEMU 商品发布页（temu_publish tab）即可创建/编辑/删除模板（2026-10-22 口径）
  const canManage = ctx.canAccess("temu_publish")
  return <TemuTemplateManager canManage={canManage} />
}
