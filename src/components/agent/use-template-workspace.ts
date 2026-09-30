"use client"

/**
 * 模板工作台轮询 hook：AI 团队处理中（queued / running）每 2s 拉取工作台数据，
 * 处理完成（回到 waiting_human 等终态）后自动停止；用户操作后可手动 refresh
 * 立即拉取并重新进入轮询。拉取入口经 workspace-actions 注入（预览页喂 mock）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { getTemplateWorkspaceAction } from "@/server/actions/agent-template"
import { useWorkspaceActions } from "./workspace-actions"

export type TemplateWorkspaceData = Awaited<ReturnType<typeof getTemplateWorkspaceAction>>

const BUSY_STATUSES = ["queued", "running"]
const POLL_INTERVAL_MS = 2000
/** 连续拉取失败容忍上限：超过则停止轮询（服务端长时间不可用时不再空转） */
const MAX_POLL_FAILURES = 10

export function isTemplateBusy(status: string | null | undefined): boolean {
  return !!status && BUSY_STATUSES.includes(status)
}

export function useTemplateWorkspace(initial: TemplateWorkspaceData) {
  const { getTemplateWorkspace } = useWorkspaceActions()
  const [data, setData] = useState<TemplateWorkspaceData>(initial)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runId = data.run.id
  const busy = isTemplateBusy(data.run.status)

  const refresh = useCallback(async () => {
    try {
      const next = await getTemplateWorkspace(runId)
      setData(next)
      return next
    } catch {
      return null
    }
  }, [runId, getTemplateWorkspace])

  useEffect(() => {
    if (!busy) return
    let stopped = false
    let failures = 0
    const tick = () => {
      timerRef.current = setTimeout(async () => {
        const next = await refresh()
        if (stopped) return
        if (next) {
          failures = 0
          // 仍在处理中才继续；回到终态（waiting_human 等）停止轮询
          if (isTemplateBusy(next.run.status)) tick()
        } else if (failures < MAX_POLL_FAILURES) {
          // 单次拉取失败不终止轮询：data 未更新时 busy 恒为 true，
          // 一停就会永久卡在「AI 团队处理中」且操作全部被禁用
          failures += 1
          tick()
        }
      }, POLL_INTERVAL_MS)
    }
    tick()
    return () => {
      stopped = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [busy, refresh])

  return { data, setData, refresh, busy }
}
