import type { ModuleName } from "@/db/schema"
import { requireUserContext } from "@/lib/auth/session"
import { NoPermission } from "@/components/shared/no-permission"
import { ComingSoon02 } from "@/components/ui/coming-soon-02"

/**
 * 模块占位页统一守卫 + Coming Soon 渲染（视频生成/选品工具 11 个占位子页共用）：
 * 内置 requireUserContext + canAccess 无权限拦截（NoPermission 文案随模块名），
 * 各占位页退化为单行调用；模块转正式功能时直接在页面侧替换实现。
 */
export async function ModuleComingSoon({
  module,
  moduleLabel,
  title,
  description,
}: {
  module: ModuleName
  /** 模块中文名（无权限文案用，如「视频生成」） */
  moduleLabel: string
  title: string
  description?: string
}) {
  const ctx = await requireUserContext()
  if (!ctx.canAccess(module)) {
    return (
      <NoPermission
        module={moduleLabel}
        description={`当前企业未开通${moduleLabel}模块，请联系平台管理员在企业管理中启用。`}
      />
    )
  }

  return <ComingSoon02 title={title} description={description} />
}
