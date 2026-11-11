"use client"
import { formatDateTime } from "@/lib/datetime"

import { useState, useCallback } from "react"
import { Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import {
  getPlatformTaskDetailAction,
  type PlatformTaskLogRow,
  type PlatformTaskLogDetail,
} from "@/server/actions/platform-logs"

export const SOURCE_LABELS: Record<string, string> = {
  create: "自由创作",
  workspace: "批量生图",
  product: "商品图片",
  weartry: "穿戴图片",
  mockup: "样机渲染",
  agent: "AI Agent",
}

export const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  completed: "default",
  processing: "secondary",
  queued: "outline",
  failed: "destructive",
}

export const STATUS_LABELS: Record<string, string> = {
  completed: "已完成",
  processing: "生成中",
  queued: "排队中",
  failed: "失败",
}

/**
 * 全平台生图日志表格（超管，只读：详情弹窗，无删除——跨企业数据删除
 * 走各企业管理端）。结构对齐企业侧 logs-task-table，多一列归属企业。
 */
export function PlatformLogsTaskTable({ tasks }: { tasks: PlatformTaskLogRow[] }) {
  const [detail, setDetail] = useState<PlatformTaskLogDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const openDetail = useCallback(async (task: PlatformTaskLogRow) => {
    setLoadingDetail(true)
    setDetailOpen(true)
    try {
      const res = await getPlatformTaskDetailAction(task.id)
      if (res.ok && res.detail) {
        setDetail(res.detail)
      } else {
        // 回退：用行数据构造无 apiCallLogs 的详情
        setDetail({ ...task, apiCallLogs: [] })
      }
    } catch {
      setDetail({ ...task, apiCallLogs: [] })
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead>归属企业</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>模块</TableHead>
            <TableHead>积分</TableHead>
            <TableHead>提示词</TableHead>
            <TableHead>时间</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={8}
                className="py-8 text-center text-muted-foreground"
              >
                暂无日志
              </TableCell>
            </TableRow>
          ) : (
            tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.username ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {t.enterpriseName ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANTS[t.status] ?? "outline"}>
                    {STATUS_LABELS[t.status] ?? t.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {SOURCE_LABELS[t.source] ?? t.source}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">
                  {t.creditsCharged}
                </TableCell>
                <TableCell
                  className="max-w-[200px] truncate text-xs text-muted-foreground"
                  title={t.prompt}
                >
                  {t.prompt}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDateTime(t.createdAt)}
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    onClick={() => openDetail(t)}
                  >
                    <Eye className="mr-1 size-3.5" />
                    详情
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* 任务详情弹窗（trap-focus：不锁页面滚动、不禁用侧边栏交互） */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen} modal="trap-focus">
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>任务详情</DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <div className="flex h-40 items-center justify-center">
              <MorphingInfinity className="size-5 text-muted-foreground" />
            </div>
          ) : detail ? (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Field label="用户" value={detail.username ?? "—"} />
                <Field label="归属企业" value={detail.enterpriseName ?? "—"} />
                <Field label="模型" value={detail.modelName ?? "—"} />
                <Field label="状态" value={STATUS_LABELS[detail.status] ?? detail.status} />
                <Field
                  label="模块"
                  value={SOURCE_LABELS[detail.source] ?? detail.source}
                />
                <Field
                  label="尺寸 / 数量"
                  value={`${detail.imageSize ?? "—"} · ${detail.imageCount} 张`}
                />
                <Field label="积分消耗" value={String(detail.creditsCharged)} />
                <Field
                  label="创建时间"
                  value={formatDateTime(detail.createdAt)}
                />
                <Field
                  label="完成时间"
                  value={
                    detail.completedAt
                      ? formatDateTime(detail.completedAt)
                      : "—"
                  }
                />
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">提示词</p>
                <p className="break-all rounded-md bg-muted p-3 text-sm">
                  {detail.prompt}
                </p>
              </div>

              {detail.errorMessage && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive">错误信息</p>
                  <p className="break-all rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {detail.errorMessage}
                  </p>
                </div>
              )}

              {detail.resultImages && detail.resultImages.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    生成结果（{detail.resultImages.length} 张）
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {detail.resultImages.map((img, idx) => (
                      <div
                        key={idx}
                        className="aspect-square overflow-hidden rounded-lg bg-muted"
                      >
                        <SmartImage
                          src={toImageSrc(img)}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detail.apiCallLogs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    API 调用记录（{detail.apiCallLogs.length} 次）
                  </p>
                  <div className="space-y-2">
                    {detail.apiCallLogs.map((log) => (
                      <div key={log.id} className="rounded-lg border p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">
                            {log.errorMessage ? "失败" : "成功"}
                          </span>
                          {log.durationMs != null && (
                            <span className="text-muted-foreground">
                              {(log.durationMs / 1000).toFixed(1)}s
                            </span>
                          )}
                        </div>
                        {log.errorMessage && (
                          <p className="mt-1 break-all font-mono text-destructive">
                            {log.errorMessage}
                          </p>
                        )}
                        <p className="mt-1 text-muted-foreground">
                          {formatDateTime(log.createdAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-all font-medium">{value}</p>
    </div>
  )
}
