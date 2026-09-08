"use client"

import { useEffect, useRef, useState } from "react"
import type { GrokBallEngine } from "./engine/grok-ball"
import { subscribeGrokBall } from "@/lib/grok-ball-bus"
import {
  readGrokBallEmotion,
  readGrokBallEnabled,
  readGrokBallPos,
  writeGrokBallEmotion,
  writeGrokBallEnabled,
  writeGrokBallPos,
  type GrokBallPos,
} from "./grok-ball-prefs"
import { EmotionPickerPanel } from "./emotion-picker-panel"
import { cn } from "@/lib/utils"

/**
 * 桌面摆件式表情圆球（grok-ball 引擎的 React 包装，挂载于 DashboardShell）
 *
 * - 球固定停在摆放位置（默认右下角，位置存 localStorage），眼神跟鼠标
 * - 按住拖动重新摆放（视口钳制；面板打开时跟随球移动并实时重算展开方向）
 * - 单击开/关表情面板；快速双击 spin 甩彩带（拖动超过阈值不算点击）
 * - 无操作时经引擎 idle 进入放空(02)/睡眠(00)；引擎只切进不切回，
 *   恢复由本组件监听 change + 指针活动完成
 * - 订阅 grok-ball-bus：聊天等业务自动联动表情，duration 到期回退手动选择
 * - SSR 首帧不渲染（AdBanner 同款 hydration 约定）；触屏粗指针不渲染
 */

const BALL_SIZE = 56
/** 拖动判定阈值：按住移动超过该像素视为拖动而非点击 */
const DRAG_THRESHOLD = 5
/** 双击窗口期：期间第二次单击按双击处理（spin） */
const DBLCLICK_MS = 280
const IDLE_STANDBY_MS = 20_000
const IDLE_SLEEP_MS = 60_000
const IDLE_STANDBY_ID = "02"
const IDLE_SLEEP_ID = "00"
/** 面板预估高度：决定在球上方还是下方弹出 */
const PANEL_EST_HEIGHT = 420
/** 球心距视口边缘的最小间距 */
const EDGE_MARGIN = 8

interface PanelPlacement {
  vertical: "above" | "below"
  horizontal: "left" | "right"
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  posStart: GrokBallPos
  moved: boolean
}

function clampPos(pos: GrokBallPos): GrokBallPos {
  const maxX = window.innerWidth - BALL_SIZE / 2 - EDGE_MARGIN
  const maxY = window.innerHeight - BALL_SIZE / 2 - EDGE_MARGIN
  return {
    x: Math.min(Math.max(pos.x, BALL_SIZE / 2 + EDGE_MARGIN), maxX),
    y: Math.min(Math.max(pos.y, BALL_SIZE / 2 + EDGE_MARGIN), maxY),
  }
}

function computePlacement(pos: GrokBallPos): PanelPlacement {
  return {
    vertical: pos.y > PANEL_EST_HEIGHT ? "above" : "below",
    horizontal: pos.x > window.innerWidth / 2 ? "right" : "left",
  }
}

export function GrokBallCursor() {
  const [mounted, setMounted] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [finePointer, setFinePointer] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const [emotionId, setEmotionId] = useState("02")
  const [placement, setPlacement] = useState<PanelPlacement>({
    vertical: "above",
    horizontal: "right",
  })

  const wrapperRef = useRef<HTMLDivElement>(null)
  const ballHostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<GrokBallEngine | null>(null)
  const manualIdRef = useRef("02")
  const panelOpenRef = useRef(false)
  const posRef = useRef<GrokBallPos>({ x: 0, y: 0 })
  const dragRef = useRef<DragState | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTapRef = useRef(0)

  const applyTransform = (pos: GrokBallPos) => {
    if (!wrapperRef.current) return
    wrapperRef.current.style.transform = `translate3d(${Math.round(pos.x - BALL_SIZE / 2)}px, ${Math.round(pos.y - BALL_SIZE / 2)}px, 0)`
  }

  // 挂载后读偏好与环境（SSR 首帧 null，避免 hydration 不匹配）
  useEffect(() => {
    setMounted(true)
    setEnabled(readGrokBallEnabled())
    setFinePointer(window.matchMedia("(pointer: fine)").matches)
    const initial = readGrokBallEmotion()
    manualIdRef.current = initial
    setEmotionId(initial)
  }, [])

  useEffect(() => {
    panelOpenRef.current = panelOpen
  }, [panelOpen])

  // 显隐事件常驻订阅（组件隐藏期间也要能被 nav-user 开关唤醒）
  useEffect(
    () =>
      subscribeGrokBall((event) => {
        if (event.type !== "enabled") return
        setEnabled(event.enabled)
        if (!event.enabled) setPanelOpen(false)
      }),
    [],
  )

  // 引擎生命周期 + 眼神跟随 + 业务联动订阅
  useEffect(() => {
    if (!mounted || !enabled || !finePointer) return
    let disposed = false
    let engine: GrokBallEngine | null = null
    let revertTimer: ReturnType<typeof setTimeout> | null = null
    /** 业务自动联动占用中（期间压制 idle 待机） */
    let autoActive = false
    /** 引擎 idle 已自动切到放空/睡眠 */
    let idleAuto = false

    const saved = readGrokBallPos()
    const pos = clampPos(
      saved ?? {
        x: window.innerWidth - 88,
        y: window.innerHeight - 88,
      },
    )
    posRef.current = pos
    applyTransform(pos)
    setPlacement(computePlacement(pos))

    const applyManual = () => {
      autoActive = false
      idleAuto = false
      if (revertTimer) {
        clearTimeout(revertTimer)
        revertTimer = null
      }
      engine?.setEmotion(manualIdRef.current)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!engine) return
      engine.resetIdle()
      if (idleAuto) {
        // 从待机/睡眠醒来：恢复手动表情（autoActive 期间 idle 被压制，不会走到这）
        idleAuto = false
        engine.setEmotion(manualIdRef.current)
      }
      // 眼神看向指针（引擎内部弹簧平滑；幅度按半屏归一，保持含蓄）
      const pos = posRef.current
      const nx = Math.max(
        -1,
        Math.min(1, (e.clientX - pos.x) / (window.innerWidth / 2)),
      )
      const ny = Math.max(
        -1,
        Math.min(1, (e.clientY - pos.y) / (window.innerHeight / 2)),
      )
      engine.setGaze(nx, ny)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false)
    }

    const onResize = () => {
      const next = clampPos(posRef.current)
      posRef.current = next
      applyTransform(next)
      setPlacement((p) => {
        const np = computePlacement(next)
        return p.vertical === np.vertical && p.horizontal === np.horizontal
          ? p
          : np
      })
    }

    const onChange = (payload: unknown) => {
      const p = payload as { id?: string; auto?: boolean }
      if (p?.auto && (p.id === IDLE_STANDBY_ID || p.id === IDLE_SLEEP_ID)) {
        idleAuto = true
      }
    }

    const unsubscribeBus = subscribeGrokBall((event) => {
      if (event.type === "emotion") {
        if (!engine) return
        if (revertTimer) {
          clearTimeout(revertTimer)
          revertTimer = null
        }
        autoActive = true
        idleAuto = false
        engine.setEmotion(event.emotionId)
        if (event.duration > 0) {
          revertTimer = setTimeout(() => {
            revertTimer = null
            autoActive = false
            engine?.setEmotion(manualIdRef.current)
          }, event.duration)
        }
      } else if (event.type === "restore") {
        applyManual()
      }
    })

    void import("./engine/grok-ball").then(({ GrokBall }) => {
      if (disposed || !ballHostRef.current) return
      const known = new Set(GrokBall.EMOTIONS.map((e) => e.id as string))
      if (!known.has(manualIdRef.current)) manualIdRef.current = "02"
      engine = GrokBall.create(ballHostRef.current, {
        emotion: manualIdRef.current,
        label: "AI 表情圆球：单击切换表情，双击旋转，按住拖动",
        idle: {
          standbyAfter: IDLE_STANDBY_MS,
          sleepAfter: IDLE_SLEEP_MS,
          standbyId: IDLE_STANDBY_ID,
          sleepId: IDLE_SLEEP_ID,
        },
      })
      engine.on("change", onChange)
      engineRef.current = engine
    })

    window.addEventListener("pointermove", onPointerMove, { passive: true })
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("resize", onResize)
    return () => {
      disposed = true
      if (revertTimer) clearTimeout(revertTimer)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", onResize)
      unsubscribeBus()
      engine?.off("change", onChange)
      engine?.destroy()
      engineRef.current = null
    }
  }, [mounted, enabled, finePointer])

  const openPanel = () => {
    setPlacement(computePlacement(posRef.current))
    setPanelOpen(true)
  }

  const togglePanel = () => {
    if (panelOpenRef.current) setPanelOpen(false)
    else openPanel()
  }

  // ---- 按住拖动 / 单击 / 双击 ----

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      posStart: posRef.current,
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.moved = true
    const next = clampPos({ x: drag.posStart.x + dx, y: drag.posStart.y + dy })
    posRef.current = next
    applyTransform(next)
    if (panelOpenRef.current) {
      setPlacement((p) => {
        const np = computePlacement(next)
        return p.vertical === np.vertical && p.horizontal === np.horizontal
          ? p
          : np
      })
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 指针已释放时 release 会抛错，忽略
    }
    if (drag.moved) {
      writeGrokBallPos(posRef.current)
      return
    }
    // 单击 / 双击（窗口期内第二次单击 → spin）
    const now = performance.now()
    if (now - lastTapRef.current < DBLCLICK_MS) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      lastTapRef.current = 0
      setPanelOpen(false)
      engineRef.current?.spin()
      return
    }
    lastTapRef.current = now
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      togglePanel()
    }, DBLCLICK_MS)
  }

  const cancelDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  const handleSelect = (id: string) => {
    manualIdRef.current = id
    writeGrokBallEmotion(id)
    setEmotionId(id)
    engineRef.current?.setEmotion(id)
  }

  const handleHide = () => {
    setPanelOpen(false)
    writeGrokBallEnabled(false)
    setEnabled(false)
  }

  // 卸载时清掉未触发的单击定时器
  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    },
    [],
  )

  if (!mounted || !enabled || !finePointer) return null

  return (
    <>
      {/* 透明背板：点击面板外关闭 */}
      {panelOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setPanelOpen(false)} aria-hidden />
      )}
      <div
        ref={wrapperRef}
        className="pointer-events-none fixed left-0 top-0 z-40"
        style={{ width: BALL_SIZE, height: BALL_SIZE }}
      >
        <div
          ref={ballHostRef}
          role="button"
          tabIndex={0}
          aria-label="AI 表情圆球：单击切换表情，双击旋转，按住拖动"
          aria-expanded={panelOpen}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              togglePanel()
            }
          }}
          className={cn(
            "pointer-events-auto size-full touch-none select-none rounded-full outline-none",
            "cursor-grab active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        />
        {panelOpen && (
          <div
            className={cn(
              "pointer-events-auto absolute z-50 w-80 rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl",
              "animate-in fade-in-0 zoom-in-95 duration-150",
              placement.vertical === "above"
                ? "bottom-full mb-3"
                : "top-full mt-3",
              placement.horizontal === "right" ? "right-0" : "left-0",
            )}
          >
            <EmotionPickerPanel
              currentId={emotionId}
              onSelect={handleSelect}
              onHide={handleHide}
            />
          </div>
        )}
      </div>
    </>
  )
}
