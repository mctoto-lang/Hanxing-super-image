import { ProductConfigNav } from "@/components/superadmin/product-config-nav"

/**
 * 超管「商品主图配置」中心布局
 *
 * 平台管理 → 商品主图配置 入口的内部子导航收纳：
 * 上架平台 / 语言 / 提示词模板 / 图片方向（含商品套图/A+详情页/产品精修二级分类）/ 尺寸规范。
 */
export default function ProductConfigLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">商品图片配置</h1>
        <p className="text-sm text-muted-foreground">
          商品套图 / A+详情页 / 爆款复刻 / 产品精修的平台规则与提示词
        </p>
      </div>
      <ProductConfigNav />
      {children}
    </div>
  )
}
