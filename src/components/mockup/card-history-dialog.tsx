"use client"

import * as React from "react"
import { AlertTriangle, History, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupHistoryBatch } from "@/lib/mockup/types"
import { listCardHistoryAction } from "@/server/actions/mockup"
import { toImageSrc } from "@/lib/utils"

/** 卡片历史批次弹窗（过往渲染结果，按批次倒序） */
export function CardHistoryDialog({
  cardId,
  cardTitle,
  open,
  onOpenChange,
}: {
  cardId: string
  cardTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [batches, setBatches] = React.useState<MockupHistoryBatch[]>([])
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let stop = false
    setLoading(true)
    void listCardHistoryAction(cardId)
      .then((res) => {
        if (!stop) setBatches(res.ok ? res.batches : [])
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
    }
  }, [open, cardId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            <History className="mr-1 inline size-4" />
            渲染历史 · {cardTitle}
          </DialogTitle>
          <DialogDescription>按批次倒序，最新批次在前</DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-3 overflow-y-auto">
          {loading ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
            </div>
          ) : batches.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              还没有渲染记录
            </div>
          ) : (
            batches.map((batch) => (
              <div key={batch.batchTag} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    批次 {new Date(batch.createdAt).toLocaleString("zh-CN")}
                  </span>
                  <span>
                    {batch.tasks.filter((t) => t.status === "completed").length}/
                    {batch.tasks.length} 成功
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {batch.tasks.map((t) => (
                    <div
                      key={t.taskId}
                      className="flex w-[104px] flex-col gap-1"
                      title={
                        t.status === "failed"
                          ? `${t.errorMessage ?? "渲染失败"}（已退款）`
                          : t.displayName
                      }
                    >
                      {t.resultImage ? (
                        <a
                          href={toImageSrc(t.resultImage)}
                          target="_blank"
                          rel="noreferrer"
                          className="block aspect-square overflow-hidden rounded-md border"
                        >
                          <SmartImage
                            src={toImageSrc(t.resultImage, { width: 200 })}
                            alt={t.displayName}
                            className="size-full object-cover"
                          />
                        </a>
                      ) : (
                        <span className="flex aspect-square items-center justify-center rounded-md border border-dashed text-muted-foreground">
                          {t.status === "failed" ? (
                            <AlertTriangle className="size-5 text-destructive" />
                          ) : (
                            t.displayName.slice(0, 4)
                          )}
                        </span>
                      )}
                      <span className="line-clamp-1 text-[10px] text-muted-foreground">
                        {t.displayName}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
