import { requireEnterpriseContext } from "@/lib/auth/session"
import { getMockupPageDataAction } from "@/server/actions/mockup"
import { MockupClient } from "@/components/mockup/mockup-client"

export const dynamic = "force-dynamic"

/**
 * 样机渲染页（模板渲染工作区，对接外部 psd-render-api）
 *
 * 页面即批量渲染区：顶栏 创建卡片/渲染/模板管理 三按钮，下方按大模板建卡、
 * 卡片内小模板方块展示渲染状态。模板管理对全员开放（归属人/管理员分级），
 * 渲染服务地址/密钥/单价按企业在超管平台配置。批量替换见 /mockup/batch。
 */
export default async function MockupPage() {
  const ctx = await requireEnterpriseContext()
  const data = await getMockupPageDataAction()
  const isAdmin =
    ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"

  return (
    <MockupClient
      initialData={data}
      isAdmin={isAdmin}
      currentUserId={ctx.user.id}
    />
  )
}
