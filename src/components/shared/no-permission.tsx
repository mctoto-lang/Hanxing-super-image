import Link from "next/link"
import { ArrowLeft, ShieldX } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * 统一"无权访问"页面（各业务模块权限守卫共用）
 *
 * 替代两种历史处理：throw FORBIDDEN 走错误边界（用户看到原始英文错误串）、
 * 各页面自写一行灰字。统一视觉与文案：说明原因 + 返回入口 + 开通指引。
 */
export function NoPermission({
  module,
  description = "当前企业未开通该模块，请联系企业管理员开通后再试。",
}: {
  /** 模块中文名，如「AI 对话」 */
  module: string
  description?: string
}) {
  return (
    <div className="flex h-full min-h-64 w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <ShieldX className="size-6" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">无权访问「{module}」</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" render={<Link href="/create" />}>
        <ArrowLeft className="size-4" />
        返回自由创作
      </Button>
    </div>
  )
}
