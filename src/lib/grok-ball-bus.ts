/**
 * Grok Ball 表情事件总线（模块级单例，零依赖）
 *
 * 业务侧（聊天流等）只负责 emit；浮球组件订阅后决定如何应用与回退。
 * 自动表情带 duration（ms）：到期回退到用户手动选择的表情；
 * duration 为 0 表示持续状态，直到下一个事件或显式 restore。
 */

export interface GrokBallEmotionEvent {
  type: "emotion"
  emotionId: string
  /** 多久后回退到手动表情；0 = 持续到下一个事件 */
  duration: number
}

export interface GrokBallRestoreEvent {
  type: "restore"
}

export interface GrokBallEnabledEvent {
  type: "enabled"
  enabled: boolean
}

export type GrokBallBusEvent =
  | GrokBallEmotionEvent
  | GrokBallRestoreEvent
  | GrokBallEnabledEvent

type Listener = (event: GrokBallBusEvent) => void

const listeners = new Set<Listener>()

export function subscribeGrokBall(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function dispatch(event: GrokBallBusEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // 订阅方异常不能影响发送方
    }
  }
}

/** 请求浮球切换表情（自动联动用，duration 到期回退手动表情）。 */
export function emitGrokEmotion(emotionId: string, duration = 0): void {
  dispatch({ type: "emotion", emotionId, duration })
}

/** 立即回退到用户手动选择的表情。 */
export function restoreGrokEmotion(): void {
  dispatch({ type: "restore" })
}

/** 表情圆球显隐变化（nav-user 开关等入口发出；同时由发送方负责写 localStorage）。 */
export function emitGrokBallEnabled(enabled: boolean): void {
  dispatch({ type: "enabled", enabled })
}
