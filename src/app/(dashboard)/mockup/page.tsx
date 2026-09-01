import { requireEnterpriseContext } from "@/lib/auth/session"
import { getMockupPageDataAction } from "@/server/actions/mockup"
import { MockupClient } from "@/components/mockup/mockup-client"

export const dynamic = "force-dynamic"

/**
 * 样机渲染页（批量渲染工作区，对接外部 psd-render-api）
 *
 * 页面即批量渲染区：顶栏 创建/渲染/模板管理 三按钮，下方按大模板建卡、
 * 卡片内小模板方块展示渲染状态。访问控制走模块链（侧边栏/模块开关控制
 * 入口），渲染服务地址/密钥/单价按企业在超管平台配置。
 */
export default async function MockupPage() {
  const ctx = await requireEnterpriseContext()
  const data = await getMockupPageDataAction()
  const isAdmin =
    ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"

  return <MockupClient initialData={data} isAdmin={isAdmin} />
}
