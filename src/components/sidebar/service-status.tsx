"use client"

import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
} from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  HistoryPoint,
  ServiceHealth,
  ServiceKey,
  ServiceStatusItemView,
  ServiceStatusView,
} from "@/lib/service-status/types"

/**
 * 「服务状态检测」弹窗（EnterpriseBadge 下拉入口打开）
 *
 * 展示层复刻 SystemStatusBlock 参考模板：标题 + 事件历史按钮、
 * 服务列表（状态图标 + 名称 + 状态小字 + 右侧该服务最后更新时间）、
 * 30 根 h-6/w-1 uptime 历史条（Tooltip 悬停）、可折叠事件历史区块。
 *
 * 五服务（从上到下）：AI Chat API / AI Image API / Photoshop API /
 * 分布式存储（COS）/ 系统级服务（PostgreSQL + Redis）。
 *
 * 历史条按 5 分钟采样槽展示（检测间隔统一 5 分钟）：30 根 = 最近
 * 30 个采样槽（约 2.5 小时），Tooltip 显示「9月7日 10:35 · 运行正常」。
 *
 * 数据：GET /api/service-status（打开即拉取，打开期间每 5 分钟静默
 * 自动刷新）。AI 端点探测为只读 GET /models，不提交生图/对话任务。
 */

const SERVICE_META: Record<ServiceKey, { name: string }> = {
  chat: { name: "AI Chat API" },
  ai: { name: "AI Image API" },
  "ps-api": { name: "Photoshop API" },
  storage: { name: "分布式存储" },
  postgres: { name: "系统级服务" },
}

const STATUS_LABELS: Record<ServiceHealth, string> = {
  operational: "运行正常",
  degraded: "性能降级",
  down: "服务中断",
}

const BAR_COLORS: Record<ServiceHealth, string> = {
  operational: "bg-green-400",
  degraded: "bg-yellow-400",
  down: "bg-red-400",
}

function getStatusIcon(status: ServiceHealth, configured: boolean) {
  if (!configured) return <Circle className="size-4 text-muted-foreground" />
  if (status === "operational") {
    return <CheckCircle2 className="size-4 text-green-500" />
  }
  if (status === "degraded") {
    return <AlertTriangle className="size-4 text-yellow-500" />
  }
  return <Circle className="size-4 text-red-500" />
}

/** ISO 时间戳 → 「9月7日 10:35」 */
function formatSlot(iso: string): string {
  const date = new Date(iso)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function UptimeBar({ history }: { history: Array<HistoryPoint | null> }) {
  return (
    <div className="mt-1 flex gap-0.5">
      {history.map((point, i) => (
        <Tooltip key={i}>
          <TooltipTrigger
            render={
              <div
                className={cn(
                  "h-6 w-1 rounded-sm",
                  point ? BAR_COLORS[point.status] : "bg-muted",
                )}
              />
            }
          />
          <TooltipContent side="top">
            {point
              ? `${formatSlot(point.slot)} · ${STATUS_LABELS[point.status]}`
              : "无采样数据"}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

function ServiceRow({ service }: { service: ServiceStatusItemView }) {
  const meta = SERVICE_META[service.key]
  const metaText = [
    service.configured && service.latencyMs != null
      ? `${service.latencyMs}ms`
      : null,
    service.configured ? service.extra : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-4">
        {getStatusIcon(service.status, service.configured)}
        <span className="font-medium">{meta.name}</span>
        <span className="text-xs text-muted-foreground">
          {service.configured
            ? `${STATUS_LABELS[service.status]}${metaText ? ` · ${metaText}` : ""}`
            : "未配置"}
        </span>
        {service.configured && (
          <span className="ml-auto text-xs text-muted-foreground">
            最后更新 {formatClock(service.checkedAt)}
          </span>
        )}
      </div>
      {service.configured && <UptimeBar history={service.history} />}
    </div>
  )
}

interface IncidentItem {
  service: string
  time: string
  desc: string
}

/** 由可见采样槽推导事件列表（新 → 旧，上限 15 条） */
function deriveIncidents(services: ServiceStatusItemView[]): IncidentItem[] {
  const list: IncidentItem[] = []
  for (const service of services) {
    if (!service.configured) continue
    for (const point of service.history) {
      if (point && point.status !== "operational") {
        list.push({
          service: SERVICE_META[service.key].name,
          time: formatSlot(point.slot),
          desc:
            point.status === "down"
              ? "该时段检测到服务中断"
              : "该时段检测到性能降级",
        })
      }
    }
  }
  return list.reverse().slice(0, 15)
}

export function ServiceStatusDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = React.useState<ServiceStatusView | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [showIncidents, setShowIncidents] = React.useState(false)

  const load = React.useCallback(async () => {
    setFailed(false)
    try {
      const res = await fetch("/api/service-status", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as ServiceStatusView)
    } catch {
      setFailed(true)
    }
  }, [])

  // 打开即拉取；打开期间每 5 分钟静默自动刷新（检测间隔统一 5 分钟）
  React.useEffect(() => {
    if (!open) return
    void load()
    const id = setInterval(() => void load(), 300_000)
    return () => clearInterval(id)
  }, [open, load])

  const incidents = data ? deriveIncidents(data.services) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 p-6 sm:max-w-xl">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
            <DialogTitle className="font-semibold text-lg">
              服务状态检测
            </DialogTitle>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowIncidents((v) => !v)}
              aria-label={showIncidents ? "收起事件历史" : "展开事件历史"}
            >
              {showIncidents ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
              <span className="text-xs">
                {showIncidents ? "收起历史" : "事件历史"}
              </span>
            </Button>
          </div>
          {failed ? (
            <div className="flex flex-col gap-1 py-4 text-xs text-muted-foreground">
              <span>状态获取失败，请稍后重试</span>
              <button
                type="button"
                onClick={() => void load()}
                className="text-left text-primary underline-offset-2 hover:underline"
              >
                重新获取
              </button>
            </div>
          ) : !data ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
                  <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {data.services.map((service) => (
                <ServiceRow key={service.key} service={service} />
              ))}
            </div>
          )}
        </div>
        {showIncidents && (
          <div className="mt-2 flex flex-col gap-2 rounded-lg bg-accent p-4">
            <span className="mb-2 text-sm font-semibold">事件历史</span>
            {incidents.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                近 30 个采样内无异常
              </span>
            ) : (
              incidents.map((inc, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1 border-b border-muted-foreground/10 pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="text-xs font-medium">
                    {inc.service} - {inc.time}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {inc.desc}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
