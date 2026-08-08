import { Badge } from "@/components/ui/badge"
import { listMyTasksAction } from "@/server/actions/tasks"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getStorageProxyUrl } from "@/lib/storage/proxy"

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  processing: "生成中",
  completed: "完成",
  failed: "失败",
}

const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "outline",
  processing: "secondary",
  completed: "default",
  failed: "destructive",
}

/**
 * 历史任务列表（手册 §5.5）
 *
 * 服务端组件，查询当前用户最近任务。
 */
export async function HistoryList() {
  const tasks = await listMyTasksAction({ limit: 20 })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <h3 className="text-sm font-semibold">历史任务</h3>
        <p className="text-xs text-muted-foreground">最近 {tasks.length} 条</p>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-2 p-3">
          {tasks.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无历史任务
            </div>
          ) : null}
          {tasks.map((t) => {
            const imgs = (t.resultImages as string[] | null) ?? []
            return (
              <div
                key={t.id}
                className="rounded-md border p-2 transition-colors hover:bg-accent"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Badge variant={STATUS_VARIANTS[t.status] ?? "outline"}>
                    {STATUS_LABELS[t.status] ?? t.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(t.createdAt).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs">{t.prompt}</p>
                {imgs.length > 0 ? (
                  <div className="mt-2 flex gap-1 overflow-x-auto">
                    {imgs.slice(0, 4).map((url, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={getStorageProxyUrl(url)}
                        alt={`结果 ${i + 1}`}
                        className="size-12 flex-shrink-0 rounded object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                {t.errorMessage ? (
                  <p className="mt-1 text-xs text-destructive">
                    {t.errorMessage.slice(0, 60)}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
