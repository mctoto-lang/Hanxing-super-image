"use client"

import * as React from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"

/**
 * 成员搜索输入：无独立搜索按钮，300ms 防抖自动搜索（回车立即提交）；
 * 搜索条件变化时重置回第 1 页。
 */
export function MemberSearchInput({ defaultValue = "" }: { defaultValue?: string }) {
  const router = useRouter()
  const [value, setValue] = React.useState(defaultValue)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const navigate = React.useCallback(
    (q: string) => {
      router.replace(q ? `/admin/users?q=${encodeURIComponent(q)}` : "/admin/users")
    },
    [router],
  )

  // 外部值变化（翻页带回、清除筛选）时同步本地输入框
  React.useEffect(() => {
    setValue(defaultValue)
  }, [defaultValue])

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleChange = (v: string) => {
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => navigate(v.trim()), 300)
  }

  return (
    <div className="relative w-56 max-w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            if (timerRef.current) clearTimeout(timerRef.current)
            navigate(value.trim())
          }
        }}
        placeholder="搜索用户名 / 昵称 / 邮箱"
        className="pl-8"
      />
    </div>
  )
}
