import type { Metadata } from "next"

import LandingPage from "@/components/marketing/landing-page"

export const metadata: Metadata = {
  title: "瀚星 Super Image — 企业级 AI 图片工作台",
}

/**
 * 营销首页（手册 §5.1）
 *
 * 对所有用户展示营销 Hero 页（proxy 白名单放行 /，见 src/proxy.ts）。
 * 已登录用户可从侧边栏企业徽章进入本页；
 * 点「登录」时因已有登录态会被 /login 直接送回工作台（见登录页）。
 */
export default function MarketingHomePage() {
  return <LandingPage />
}
