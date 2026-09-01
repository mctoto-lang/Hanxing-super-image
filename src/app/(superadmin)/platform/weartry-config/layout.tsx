import { WeartryConfigNav } from "@/components/superadmin/weartry-config-nav"

/**
 * 超管「穿戴图片管理」配置中心布局
 *
 * 与商品图片配置（/platform/product-config）完全分割的独立入口：
 * 场景预设（模特穿戴预置场景）/ 图片方向（服装组图）/ 提示词模板（weartry.*）。
 */
export default function WeartryConfigLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">穿戴图片管理</h1>
        <p className="text-sm text-muted-foreground">
          服装组图 / 模特穿戴 / AI万戴 / AI换色 的场景预设与提示词
        </p>
      </div>
      <WeartryConfigNav />
      {children}
    </div>
  )
}
