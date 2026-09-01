import { redirect } from "next/navigation"

/** 图片方向配置已整合进「商品主图配置」中心，旧路由保留跳转 */
export default function ProductDirectionsPage() {
  redirect("/platform/product-config/directions")
}
