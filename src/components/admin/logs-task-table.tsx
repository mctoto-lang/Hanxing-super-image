"use client"

import { useState, useCallback } from "react"
import { Eye, Trash2 } from "lucide-react"
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
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { toImageSrc } from "@/lib/utils"
import { SmartImage } from "@/components/ui/smart-image"
import {
  getTaskDetailAction,
  deleteTaskLogAction,
  type TaskLogRow,
  type TaskLogDetail,
} from "@/server/actions/admin-logs"

export const SOURCE_LABELS: Record<string, string> = {
  create: "自由创作",
  workspace: "批量生图",
  product: "商品图片",
  weartry: "穿戴图片",
  mockup: "样机渲染",
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
 * 生图日志表格（客户端：行操作 + 详情/删除弹窗）。
 * 数据与分页由服务端页面按 URL 参数取数后传入。
 */
export function LogsTaskTable({ tasks }: { tasks: TaskLogRow[] }) {
  const [tasksState, setTasksState] = useState<TaskLogRow[]>(tasks)
  const [detail, setDetail] = useState<TaskLogDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TaskLogRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const openDetail = useCallback(async (task: TaskLogRow) => {
    setLoadingDetail(true)
    setDetailOpen(true)
    try {
      const res = await getTaskDetailAction(task.id)
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

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await deleteTaskLogAction(deleteTarget.id)
      if (res.ok) {
        toast.success("日志已删除")
        setTasksState((prev) => prev.filter((t) => t.id !== deleteTarget.id))
        setDeleteTarget(null)
      } else {
        toast.error(res.error ?? "删除失败")
      }
    } catch {
      toast.error("删除失败")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>模块</TableHead>
            <TableHead className="text-right">积分</TableHead>
            <TableHead>提示词</TableHead>
            <TableHead>时间</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasksState.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="py-8 text-center text-muted-foreground"
              >
                暂无日志
              </TableCell>
            </TableRow>
          ) : (
            tasksState.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.username ?? "—"}</TableCell>
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
                <TableCell className="text-right tabular-nums">
                  {t.creditsCharged}
                </TableCell>
                <TableCell
                  className="max-w-[200px] truncate text-xs text-muted-foreground"
                  title={t.prompt}
                >
                  {t.prompt}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(t.createdAt).toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => openDetail(t)}
                    >
                      <Eye className="mr-1 size-3.5" />
                      详情
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(t)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* 任务详情弹窗（trap-focus：不锁页面滚动、不禁用侧边栏交互） */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen} modal="trap-focus">
        <DialogContent className="sm:max-w-2xl">
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
                  value={new Date(detail.createdAt).toLocaleString("zh-CN")}
                />
                <Field
                  label="完成时间"
                  value={
                    detail.completedAt
                      ? new Date(detail.completedAt).toLocaleString("zh-CN")
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
                          {new Date(log.createdAt).toLocaleString("zh-CN")}
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

      {/* 删除确认弹窗 */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              确认删除
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要删除这条日志记录吗？此操作不可撤销。
          </p>
          {deleteTarget && (
            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <p>用户：{deleteTarget.username ?? "—"}</p>
              <p>
                时间：{new Date(deleteTarget.createdAt).toLocaleString("zh-CN")}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "删除中..." : "确认删除"}
            </Button>
          </DialogFooter>
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
