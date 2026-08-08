import { redirect } from "next/navigation"

/**
 * 主页 → 重定向到 /create（手册 §3）
 */
export default function HomePage() {
  redirect("/create")
}
