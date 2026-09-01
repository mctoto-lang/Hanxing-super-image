import { redirect } from "next/navigation"

/** 平台尺寸规范已整合进「商品主图配置」中心，旧路由保留跳转 */
export default function SizeSpecsPage() {
  redirect("/platform/product-config/size-specs")
}
