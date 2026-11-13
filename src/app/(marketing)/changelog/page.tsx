import type { Metadata } from "next"

import ChangelogPage from "@/components/marketing/changelog-page"

export const metadata: Metadata = {
  title: "更新日志 — StarChart 瀚星星图",
}

/** 公开更新日志页（proxy 白名单放行，未登录可浏览） */
export default function ChangelogPageRoute() {
  return <ChangelogPage />
}
