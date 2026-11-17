import { redirect } from "next/navigation"

import { VIDEO_LANDING_URL } from "@/components/sidebar/sidebar-data"

export const dynamic = "force-dynamic"

/**
 * 视频生成入口：重定向到第一个子页（视频创作）。
 */
export default function VideoRedirectPage() {
  redirect(VIDEO_LANDING_URL)
}
