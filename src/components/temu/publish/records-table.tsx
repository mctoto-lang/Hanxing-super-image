"use client"

import * as React from "react"
import { Eye } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { TemuPublishRecordRow } from "@/server/actions/temu-publish"
import { cn, toImageSrc } from "@/lib/utils"
import { formatDateTime } from "@/lib/datetime"
import { EmptyHint } from "@/components/temu/products-table"

/** 发品记录表（商品发布面板复用；错误 Tooltip 看完整官方原因，
 *  「详情」弹窗看提交官方的请求/响应快照——排障回溯用） */
export function PublishRecordsTable({ rows }: { rows: TemuPublishRecordRow[] }) {
  const [detail, setDetail] = React.useState<TemuPublishRecordRow | null>(null)
  return (
    <>
      {/* overflow-clip 只按圆角裁剪（非滚动容器，sticky 表头仍锚定页侧 CardContent） */}
      <div className="w-max min-w-full overflow-clip rounded-md border">
      <table className="w-max min-w-full caption-bottom text-xs [&_td:not(:first-child)]:border-l [&_td:not(:first-child)]:border-border [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead>图片</TableHead>
            <TableHead>商品名</TableHead>
            <TableHead>模板</TableHead>
            <TableHead>店铺</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>创建人</TableHead>
            <TableHead>时间</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                暂无发品记录。
              </TableCell>
            </TableRow>
          )}
          {rows.map((rec) => (
            <TableRow key={rec.id}>
              <TableCell>
                <RecordThumbs imageUrls={rec.imageUrls} />
              </TableCell>
              <TableCell className="max-w-40">
                <span className="line-clamp-2 text-xs">{rec.title || rec.templateName}</span>
              </TableCell>
              <TableCell>
                <TruncTip text={rec.templateName} width="max-w-40 font-medium" />
              </TableCell>
              <TableCell>
                <TruncTip text={rec.storeName} width="max-w-36 text-muted-foreground" />
              </TableCell>
              <TableCell>
                <Badge
                  className={`rounded-[4px] ${
                    rec.status === "success"
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : rec.status === "failed"
                        ? "bg-red-500/15 text-red-700 dark:text-red-400"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  }`}
                >
                  {rec.status === "success" ? "成功" : rec.status === "failed" ? "失败" : "处理中"}
                </Badge>
              </TableCell>
              <TableCell className="max-w-md">
                {rec.status === "success" ? (
                  <span className="text-xs">
                    productId <span className="font-mono">{rec.productId}</span>
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="line-clamp-2 cursor-default text-xs text-destructive">
                          {rec.errorMsg ?? "未知错误"}
                        </span>
                      }
                    />
                    <TooltipContent className="max-w-sm">
                      {rec.errorCode ? `错误码 ${rec.errorCode}：` : ""}
                      {rec.errorMsg}
                    </TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell>
                <TruncTip text={rec.creatorName ?? ""} width="max-w-28" />
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(rec.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setDetail(rec)}
                >
                  <Eye className="size-3.5" /> 详情
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </table>
      </div>

      {detail && (
        <Dialog open onOpenChange={(v) => !v && setDetail(null)}>
          <DialogContent className="sm:max-w-[720px]">
            <DialogHeader>
              <DialogTitle>发品详情</DialogTitle>
              <DialogDescription>
                {detail.templateName} → {detail.storeName} · {formatDateTime(detail.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  提交官方的请求（requestSnapshot）
                </p>
                <pre className="overflow-x-auto rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed">
                  {prettyJson(detail.requestSnapshot)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  官方响应（responseSnapshot）
                </p>
                <pre className="overflow-x-auto rounded-md bg-muted/50 p-2.5 text-xs leading-relaxed">
                  {prettyJson(detail.responseSnapshot)}
                </pre>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** 限长列共用：单行截断 + Tooltip 悬浮看全文；空值显示感叹号占位 */
function TruncTip({ text, width }: { text: string; width?: string }) {
  if (!text) return <EmptyHint />
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("block max-w-32 truncate text-xs", width)}>
            {text}
          </span>
        }
      />
      <TooltipContent className="max-w-sm">{text}</TooltipContent>
    </Tooltip>
  )
}

/** 本次发品图源缩略条：前 3 张代理小图 + 剩余计数（旧记录无图源显示空值占位） */
function RecordThumbs({ imageUrls }: { imageUrls: string[] | null }) {
  if (!imageUrls || imageUrls.length === 0) {
    return <EmptyHint />
  }
  const shown = imageUrls.slice(0, 3)
  const rest = imageUrls.length - shown.length
  return (
    <div className="flex items-center gap-1">
      {shown.map((src, i) => (
        <div key={src.slice(0, 120) + i} className="size-9 overflow-hidden rounded border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={toImageSrc(src, { width: 96 })}
            alt={`图 ${i + 1}`}
            className="size-full object-cover"
            loading="lazy"
          />
        </div>
      ))}
      {rest > 0 && <span className="text-xs text-muted-foreground">+{rest}</span>}
    </div>
  )
}

function prettyJson(value: unknown): string {
  if (value == null) return "（无快照——早期记录未落档）"
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
