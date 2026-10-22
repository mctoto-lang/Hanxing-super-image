"use client"

/**
 * 方形 Grok Agent 头像（复用项目内置 grok-ball 表情引擎）
 *
 * 层级树 / 抽屉头部的 Agent 身份图标：lite 模式 + square（圆角方形）身形，
 * 表情随节点运行状态自动切换，与侧边栏 AI 表情圆球同一生态：
 * 待命=待机放空(02) / 工作中=专注(16) / 完成=开心(10) / 失败=失落(12) / 跳过=睡眠(00)
 *
 * 纯展示（pointer-events-none，不拦截树节点点击）；客户端动态 import 引擎
 * （其模块顶层依赖 window），卸载 destroy。
 */
import { useEffect, useRef } from "react"
import type { GrokBallEngine } from "@/components/grok-ball/engine/grok-ball"
import { cn } from "@/lib/utils"

const STATUS_EMOTION: Record<string, string> = {
  idle: "02",
  running: "16",
  done: "10",
  failed: "12",
  skipped: "00",
}

export function GrokAgentAvatar({
  status,
  color,
  size = 36,
  className,
}: {
  status?: string | null
  /** Grok 身体色（区分不同 Agent；如 #8b5cf6），仅创建时生效 */
  color?: string
  size?: number
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<GrokBallEngine | null>(null)

  // 创建一次（客户端动态 import；lite + gem 方形身形；可选身体色）
  useEffect(() => {
    let disposed = false
    void (async () => {
      const mod = await import("@/components/grok-ball/engine/grok-ball")
      if (disposed || !hostRef.current) return
      const engine = mod.GrokBall.create(hostRef.current, {
        emotion: STATUS_EMOTION[status ?? "idle"] ?? "02",
        ...(color ? { color: color as `#${string}` } : {}),
        shape: "square",
        lite: true,
        idle: false,
      })
      engineRef.current = engine
    })()
    return () => {
      disposed = true
      engineRef.current?.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 状态变化 → 切表情
  useEffect(() => {
    engineRef.current?.setEmotion(STATUS_EMOTION[status ?? "idle"] ?? "02")
  }, [status])

  return (
    <div
      ref={hostRef}
      aria-hidden
      className={cn("pointer-events-none shrink-0", className)}
      style={{ width: size, height: size }}
    />
  )
}
