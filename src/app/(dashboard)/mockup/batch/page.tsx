import { requireEnterpriseContext } from "@/lib/auth/session"
import { getMockupBatchPageDataAction } from "@/server/actions/mockup"
import { MockupBatchClient } from "@/components/mockup/batch-client"

export const dynamic = "force-dynamic"

/**
 * 样机批量替换页（小模板级批量套版）
 *
 * 选小模板 → 配置替换源（图片文件夹轮换 + CSV 文字轮换 + 背景/固定绑定，
 * 支持图库选图与 AI 生成背景）→ 确认扣费提交 → 批次进度/重试/打包下载。
 * 支持从模板管理「批量替换」按钮带 templateId 直达。
 */
export default async function MockupBatchPage({
  searchParams,
}: {
  searchParams: Promise<{ templateId?: string }>
}) {
  const ctx = await requireEnterpriseContext()
  const [data, sp] = await Promise.all([
    getMockupBatchPageDataAction(),
    searchParams,
  ])

  const isAdmin =
    ctx.user.enterpriseRole === "owner" || ctx.user.enterpriseRole === "admin"

  return (
    <MockupBatchClient
      initialData={data}
      initialTemplateId={sp.templateId ?? null}
      isAdmin={isAdmin}
      currentUserId={ctx.user.id}
    />
  )
}
