import { redirect } from "next/navigation"

/**
 * 个人设置已迁移至「账户管理」弹窗（nav-user 下拉 → 账户管理），
 * 本路由仅作历史链接兜底重定向。
 */
export default async function SettingsPage() {
  redirect("/")
}
