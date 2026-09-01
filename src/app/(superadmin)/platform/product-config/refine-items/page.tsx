import { redirect } from "next/navigation"

/** 精修优化项已合并为「图片方向」的「产品精修」二级分类，旧路由保留跳转 */
export default function ProductRefineItemsConfigPage() {
  redirect("/platform/product-config/directions")
}
