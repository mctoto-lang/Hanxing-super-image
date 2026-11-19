import type { Metadata } from "next"

import ChangelogPage from "@/components/marketing/changelog-page"

export const metadata: Metadata = {
  title: "更新日志 — StarChart 瀚星星图",
}

/** 更新日志页（需登录：未登录由 proxy 重定向 /login；登录成功统一按
 * postLoginPath 进入工作台（/create 或 /platform），不回跳本页） */
export default function ChangelogPageRoute() {
  return <ChangelogPage />
}
