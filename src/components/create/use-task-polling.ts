"use client"

import { useEffect, useRef } from "react"

/**
 * 提交后任务结果轮询 hook（create-prompt-input 从组件内提取）。
 *
 * 3s × 400 = 20 分钟：覆盖最慢任务（taskTimeout 默认 300s + 自动重试排队）。
 * 会话过期（fetch 被代理重定向到 /login 返回 200 HTML）立即停止，不再无限轮询。
 *
 * 回调经 ref 转发：组件每次渲染产生新回调不会重建轮询定时器。
 */
export function useTaskPolling({
  taskId,
  intervalMs = 3000,
  maxAttempts = 400,
  onCompleted,
  onFailed,
  onStopped,
}: {
  taskId: string | null
  intervalMs?: number
  maxAttempts?: number
  onCompleted: () => void
  onFailed: (errorMessage?: string | null) => void
  /** 次数超限 / 登录过期等主动停止 */
  onStopped: (message: string) => void
}) {
  const handlersRef = useRef({ onCompleted, onFailed, onStopped })

  // 每次渲染后同步最新回调：render 期间写 ref 违反 React 规则
  // （react-hooks/refs），放到无依赖 effect 中写值语义等价且安全
  useEffect(() => {
    handlersRef.current = { onCompleted, onFailed, onStopped }
  })

  useEffect(() => {
    if (!taskId) return
    let stopped = false
    let attempts = 0

    const poll = async () => {
      attempts++
      if (attempts > maxAttempts) {
        handlersRef.current.onStopped("任务状态查询超时，请稍后刷新页面查看结果")
        return
      }
      try {
        const resp = await fetch(`/api/tasks/${taskId}/result`)
        // 中间件把未登录请求重定向到 /login 时，fetch 跟随后返回 200 HTML
        const contentType = resp.headers.get("content-type") ?? ""
        if (contentType.includes("text/html")) {
          handlersRef.current.onStopped("登录状态已过期，请重新登录")
          return
        }
        if (!resp.ok) return
        const data = (await resp.json()) as {
          status: string
          errorMessage?: string | null
        }
        if (stopped) return

        if (data.status === "completed") {
          handlersRef.current.onCompleted()
        } else if (data.status === "failed") {
          handlersRef.current.onFailed(data.errorMessage)
        }
      } catch {
        // 网络抖动忽略，由次数上限兜底
      }
    }

    void poll()
    const timer = setInterval(poll, intervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [taskId, intervalMs, maxAttempts])
}
