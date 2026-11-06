import { redirect } from "next/navigation"

export const dynamic = "force-dynamic"

/**
 * 库存管理已拆为两个独立页面：生产规划 / 库存数据。
 * 旧地址（含 ?tab=）按 tab 重定向，历史链接/收藏继续可用。
 */

export default async function InventoryRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const rawTab = (Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) as string | undefined
  redirect(rawTab === "stock" ? "/inventory/stock" : "/inventory/production")
}
