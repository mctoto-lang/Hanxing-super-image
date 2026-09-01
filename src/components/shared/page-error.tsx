"use client"

import { useEffect } from "react"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * 路由级错误边界（各路由组 error.tsx 共用）：
 * 服务端页面未捕获异常时显示品牌错误页 + 重试，替代 Next 默认错误页。
 * digest 便于在服务端日志中定位对应错误。
 */
export function PageError({
  error,
  reset,
  title = "页面出错了",
}: {
  error: Error & { digest?: string }
  reset: () => void
  title?: string
}) {
  useEffect(() => {
    console.error("[page-error]", error)
  }, [error])

  return (
    <div className="flex h-full min-h-64 w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-2xl font-bold text-destructive">
        !
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">
          {error.message || "发生未知错误，请稍后重试"}
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-muted-foreground/60">
            {error.digest}
          </p>
        ) : null}
      </div>
      <Button variant="outline" onClick={() => reset()}>
        <RotateCcw className="size-4" />
        重试
      </Button>
    </div>
  )
}
