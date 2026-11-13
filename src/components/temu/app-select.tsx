"use client"

import { useRouter } from "next/navigation"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * TEMU 应用（主体）切换下拉（URL 驱动：选值跳转 /temu?tab=&app=，清 store 参数
 * 防跨应用残留；「全部主体」= 不筛选，店铺下拉与数据覆盖全部应用的店铺）。
 * 应用数 ≤1 时由页面隐藏本组件。
 */
export function TemuAppSelect({
  tab,
  current,
  apps,
}: {
  tab: string
  current?: string
  apps: { id: string; name: string; storeCount: number }[]
}) {
  const router = useRouter()
  return (
    <Select
      items={[
        { value: "__all__", label: "全部主体" },
        ...apps.map((a) => ({ value: a.id, label: `${a.name}（${a.storeCount}）` })),
      ]}
      value={current || "__all__"}
      onValueChange={(v) => {
        const p = new URLSearchParams({ tab })
        if (v && v !== "__all__") p.set("app", v)
        router.push(`/temu?${p.toString()}`)
      }}
    >
      <SelectTrigger className="h-8 w-40 text-xs" aria-label="切换应用（主体）">
        <SelectValue placeholder="全部主体" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">全部主体</SelectItem>
        {apps.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}（{a.storeCount}）
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
