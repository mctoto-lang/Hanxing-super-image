"use client"

import * as React from "react"
import { Power } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { toggleSubscriptionPlanAction } from "@/server/actions/platform-plans"

/** 套餐启用/停用（停用后不可新分配，存量订阅履约至到期） */
export function PlanToggleButton({
  planId,
  planName,
  isActive,
}: {
  planId: string
  planName: string
  isActive: boolean
}) {
  const [pending, setPending] = React.useState(false)
  const router = useRouter()

  async function handleToggle() {
    setPending(true)
    try {
      const res = await toggleSubscriptionPlanAction({
        id: planId,
        isActive: !isActive,
      })
      if (res.ok) {
        toast.success(`套餐「${planName}」已${isActive ? "停用" : "启用"}`)
        router.refresh()
      } else {
        toast.error(res.error ?? "操作失败")
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={isActive ? "停用" : "启用"}
      disabled={pending}
      onClick={handleToggle}
    >
      <Power className={isActive ? "size-4 text-muted-foreground" : "size-4 text-primary"} />
    </Button>
  )
}
