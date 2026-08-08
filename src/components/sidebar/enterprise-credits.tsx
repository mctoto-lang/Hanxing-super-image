"use client"

import { Coins } from "lucide-react"

/**
 * 企业积分余额展示（手册 §7.1、D8）
 *
 * 单一积分池，企业全员共享，醒目展示在侧边栏底部。
 */
export function EnterpriseCredits({ balance }: { balance: number }) {
  const low = balance < 50
  return (
    <div className="mx-2 mb-2 flex items-center gap-2 rounded-md border bg-sidebar-accent/40 px-3 py-2 text-sm">
      <Coins
        className={`size-4 ${low ? "text-destructive" : "text-primary"}`}
      />
      <div className="flex-1">
        <div className="text-xs text-muted-foreground">企业积分</div>
        <div
          className={`font-semibold tabular-nums ${
            low ? "text-destructive" : ""
          }`}
        >
          {balance.toLocaleString("zh-CN")}
        </div>
      </div>
    </div>
  )
}
