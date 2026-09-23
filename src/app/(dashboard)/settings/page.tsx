import { redirect } from "next/navigation"

/**
 * 个人设置已迁移至「账户管理」弹窗（nav-user 下拉 → 账户管理），
 * 本路由仅作历史链接兜底重定向。跳应用首页（登录后落地页），
 * 而非营销落地页——老书签/外链进来不应被带出工作台。
 */
export default async function SettingsPage() {
  redirect("/create")
}
