import { MorphingInfinity } from "@/components/ui/morphing-infinity"

/**
 * 路由级加载占位（各路由组 loading.tsx 共用）：
 * 服务端页面拉取期间显示品牌加载指示，避免整页空白。
 */
export function PageLoading({ label = "加载中…" }: { label?: string }) {
  return (
    <div
      className="flex h-full min-h-64 w-full flex-col items-center justify-center gap-3 text-muted-foreground"
      role="status"
    >
      <MorphingInfinity className="size-10 text-primary" />
      <p className="text-sm">{label}</p>
    </div>
  )
}
