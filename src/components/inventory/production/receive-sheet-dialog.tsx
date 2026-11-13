"use client"

import * as React from "react"
import { toast } from "sonner"
import { ImageDown } from "lucide-react"
import { DashRing } from "@/components/ui/dash-ring"
import { toPng } from "html-to-image"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/datetime"
import type { ProductionOrderRow } from "@/server/actions/inventory-production"

/** 入库核对单图片弹窗：多选生产单 → 预览单据 → 下载 PNG 发给仓库核对。
 *  仅生成图片不落库，实际入账仍逐单走「入库」弹窗；数量口径 = 剩余待入
 *  （生产数量 − 工厂直发 − 已入库，即列表「余量」列）。 */

/** 单据画布宽度（px，固定宽长图；pixelRatio 2 输出 1600px 宽 PNG） */
const SHEET_WIDTH = 800

/** 图片 URL → dataURL（成功即无 canvas 跨域污染）：先走同源图片代理
 *  （自有存储/COS/白名单域可达），失败回落原图直连（host 带 CORS 头才成），
 *  再失败返回 null（渲染「无图」占位）。顺带缩到最长边 128px 控制 PNG 体积。 */
function loadImageAsDataUrl(url: string): Promise<string | null> {
  const tryLoad = (src: string) =>
    new Promise<string | null>((resolve) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => {
        try {
          const scale = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight))
          const canvas = document.createElement("canvas")
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
          canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL("image/jpeg", 0.9))
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = src
    })
  return tryLoad(`/api/image/proxy?url=${encodeURIComponent(url)}`).then((r) => r ?? tryLoad(url))
}

export function ReceiveSheetDialog({
  open,
  onOpenChange,
  orders,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orders: ProductionOrderRow[]
}) {
  /** orderId → 主图 dataURL（null=无图占位）；加载完成后才允许下载 */
  const [images, setImages] = React.useState<Record<string, string | null>>({})
  const [loadingImages, setLoadingImages] = React.useState(false)
  const [pending, startDownload] = React.useTransition()
  const sheetRef = React.useRef<HTMLDivElement>(null)

  // 打开时预载全部主图（dataURL 化：捕获时无跨域污染、无加载闪烁；同 URL 去重）
  React.useEffect(() => {
    if (!open || orders.length === 0) return
    let cancelled = false
    setLoadingImages(true)
    setImages({})
    const jobs = new Map<string, Promise<string | null>>()
    const job = (u: string) => {
      const hit = jobs.get(u)
      if (hit) return hit
      const p = loadImageAsDataUrl(u)
      jobs.set(u, p)
      return p
    }
    void Promise.all(
      orders.map(async (o) => [o.id, o.imageUrl ? await job(o.imageUrl) : null] as const),
    ).then((entries) => {
      if (cancelled) return
      setImages(Object.fromEntries(entries))
      setLoadingImages(false)
    })
    return () => {
      cancelled = true
    }
  }, [open, orders])

  const totalQty = orders.reduce((s, o) => s + o.remainQty, 0)

  const download = () => {
    const node = sheetRef.current
    if (!node) return
    startDownload(async () => {
      try {
        const dataUrl = await toPng(node, { pixelRatio: 2, backgroundColor: "#ffffff" })
        const now = new Date()
        const p = (n: number) => String(n).padStart(2, "0")
        const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
        const a = document.createElement("a")
        a.href = dataUrl
        a.download = `入库核对单-${stamp}.png`
        a.click()
        toast.success("入库核对单图片已下载")
      } catch {
        toast.error("图片生成失败，请重试")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Sheet 宽度覆盖须带 sm: 前缀（基础类 sm:max-w-sm 会压住无前缀 max-w-*） */}
      <DialogContent className="sm:max-w-[880px]">
        <DialogHeader>
          <DialogTitle>生成入库单 · 已选 {orders.length} 单</DialogTitle>
          <DialogDescription>
            数量 = 剩余待入（生产数量 − 工厂直发 − 已入库）。图片仅供仓库核对收货，
            系统入账请逐单使用「入库」操作。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-auto rounded-lg border bg-muted/30 p-3">
          {/* 单据用固定浅色配色（不随主题变量走），保证 PNG 在任何主题下都是白底黑字 */}
          <div
            ref={sheetRef}
            style={{ width: SHEET_WIDTH }}
            className="mx-auto rounded-md bg-white p-6 text-gray-900 shadow-sm"
          >
            <div className="flex items-end justify-between">
              <div>
                <div className="text-2xl font-bold tracking-wide">入库核对单</div>
                <div className="mt-1 text-xs text-gray-500">共 {orders.length} 单</div>
              </div>
              <div className="text-xs text-gray-500">生成时间：{formatDateTime(new Date())}</div>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="border-b-2 border-gray-300 text-xs text-gray-500">
                  <th className="w-10 px-2 py-1.5 text-center font-medium">#</th>
                  <th className="w-20 px-2 py-1.5 text-left font-medium">图片</th>
                  <th className="px-2 py-1.5 text-left font-medium">货号</th>
                  <th className="px-2 py-1.5 text-left font-medium">款名</th>
                  <th className="w-28 px-2 py-1.5 text-right font-medium">待入库（件）</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={o.id} className="border-t border-gray-200">
                    <td className="px-2 py-2 text-center text-xs text-gray-400">{i + 1}</td>
                    <td className="px-2 py-2">
                      {images[o.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={images[o.id]!}
                          alt=""
                          className="size-14 rounded object-cover"
                        />
                      ) : (
                        <span className="flex size-14 items-center justify-center rounded bg-gray-100 text-[10px] text-gray-400">
                          {loadingImages ? "…" : "无图"}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 font-medium whitespace-nowrap">{o.productCode}</td>
                    <td className="px-2 py-2 text-gray-600">{o.productName}</td>
                    <td className="px-2 py-2 text-right text-lg font-bold whitespace-nowrap tabular-nums">
                      {o.remainQty}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300">
                  <td colSpan={4} className="px-2 py-2.5 text-right font-medium">
                    合计（{orders.length} 单）
                  </td>
                  <td className="px-2 py-2.5 text-right text-lg font-bold whitespace-nowrap tabular-nums">
                    {totalQty}
                  </td>
                </tr>
              </tfoot>
            </table>
            <div className="mt-3 text-xs text-gray-400">
              数量 = 剩余待入（生产数量 − 工厂直发 − 已入库）；本单仅供仓库核对收货。
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            关闭
          </Button>
          <Button onClick={download} disabled={pending || loadingImages}>
            {pending || loadingImages ? (
              <DashRing className="size-3.5" />
            ) : (
              <ImageDown className="size-3.5" />
            )}
            {loadingImages ? "图片加载中…" : "下载图片"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
