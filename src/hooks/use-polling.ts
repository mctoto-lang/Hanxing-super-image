"use client"

import { useEffect, useRef } from "react"

/**
 * 定长间隔轮询 hook（收敛各组件原先各写一套的 setInterval 轮询）。
 *
 * - active 驱动启停：false 时清理定时器，true 变化自动重启
 * - tick 经 ref 转发：tick 闭包变化不重建定时器（无需把 tick 加进依赖，
 *   规避大组件里的 exhaustive-deps 抑制）
 * - 页面不可见（document.hidden）自动跳过本轮，切回后照常（不计入次数上限）
 * - 重入保护：上一轮未结束（tick 返回的 Promise 未 settle）时跳过本轮
 * - maxTicks：实际执行次数上限（防 pending 永挂时无限轮询），达到后自动停止
 *
 * 注意：不提供首拍立即执行——需要时在挂载 effect 里自行先调一次。
 */
export function usePolling(
  active: boolean,
  intervalMs: number,
  tick: () => void | Promise<void>,
  opts?: { maxTicks?: number },
) {
  const tickRef = useRef(tick)
  useEffect(() => {
    tickRef.current = tick
  }, [tick])
  const maxTicks = opts?.maxTicks

  useEffect(() => {
    if (!active) return
    let busy = false
    let ticks = 0
    const timer = setInterval(() => {
      if (busy || document.hidden) return
      if (maxTicks != null && ticks >= maxTicks) {
        clearInterval(timer)
        return
      }
        ticks += 1
        busy = true
        // tick 延迟到微任务里执行：若同步调用且 tick 同步抛错，
        // finally 不会挂上、busy 永不清除，轮询将静默停摆
        void Promise.resolve()
          .then(() => tickRef.current())
          .finally(() => {
            busy = false
          })
    }, intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs, maxTicks])
}
