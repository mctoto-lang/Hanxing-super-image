/**
 * Grok Ball 用户偏好（localStorage）
 *
 * 轻量客户端偏好沿用 AdBanner 惯例：SSR 首帧不渲染、挂载后读取，
 * 避免服务端/客户端 hydration 不一致。只能在客户端调用。
 */

export const GROK_BALL_ENABLED_KEY = "grok-ball:enabled"
export const GROK_BALL_EMOTION_KEY = "grok-ball:emotion"

/** 默认待机放空 */
export const DEFAULT_GROK_BALL_EMOTION = "02"

export function readGrokBallEnabled(): boolean {
  return localStorage.getItem(GROK_BALL_ENABLED_KEY) !== "0"
}

export function writeGrokBallEnabled(enabled: boolean): void {
  localStorage.setItem(GROK_BALL_ENABLED_KEY, enabled ? "1" : "0")
}

export function readGrokBallEmotion(): string {
  return localStorage.getItem(GROK_BALL_EMOTION_KEY) || DEFAULT_GROK_BALL_EMOTION
}

export function writeGrokBallEmotion(emotionId: string): void {
  localStorage.setItem(GROK_BALL_EMOTION_KEY, emotionId)
}

/** 球摆放位置（球心视口坐标，挂载时按当前视口钳制） */
export const GROK_BALL_POS_KEY = "grok-ball:pos"

export interface GrokBallPos {
  x: number
  y: number
}

export function readGrokBallPos(): GrokBallPos | null {
  try {
    const raw = localStorage.getItem(GROK_BALL_POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<GrokBallPos>
    if (
      typeof p.x !== "number" ||
      typeof p.y !== "number" ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y)
    ) {
      return null
    }
    return { x: p.x, y: p.y }
  } catch {
    return null
  }
}

export function writeGrokBallPos(pos: GrokBallPos): void {
  localStorage.setItem(GROK_BALL_POS_KEY, JSON.stringify(pos))
}
