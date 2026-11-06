"use client"

import * as React from "react"
import { toast } from "sonner"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  exportInventoryOverviewExcelAction,
  exportProductionExcelAction,
} from "@/server/actions/inventory-batch-export"

/**
 * Excel 导出按钮（exceljs server 生成 base64 → 前端 Blob 下载）
 */

const ACTIONS = {
  overview: exportInventoryOverviewExcelAction,
  production: exportProductionExcelAction,
} as const

export function ExcelExportButton({
  kind,
  label = "导出 Excel",
  size = "sm",
}: {
  kind: keyof typeof ACTIONS
  label?: string
  size?: "sm" | "default"
}) {
  const [pending, start] = React.useTransition()
  return (
    <Button
      variant="outline"
      size={size}
      className={size === "sm" ? "h-8" : undefined}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await ACTIONS[kind]()
          if (!r.ok) {
            toast.error(r.error)
            return
          }
          const bin = atob(r.base64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }))
          const a = document.createElement("a")
          a.href = url
          a.download = r.filename
          a.click()
          // 延迟回收：Safari/Firefox 下同步 revoke 可能中断尚未开始的下载
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
          toast.success(`已导出 ${r.filename}`)
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {label}
    </Button>
  )
}
