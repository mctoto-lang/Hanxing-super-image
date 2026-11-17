import { redirect } from "next/navigation"

import { SELECTION_LANDING_URL } from "@/components/sidebar/sidebar-data"

export const dynamic = "force-dynamic"

/**
 * 选品工具入口：重定向到第一个子页（选品发现）。
 */
export default function SelectionRedirectPage() {
  redirect(SELECTION_LANDING_URL)
}
