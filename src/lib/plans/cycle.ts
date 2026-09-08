/**
 * 订阅周期发放计算（纯函数，可单测）
 *
 * 周期语义：
 *   - 从订阅 startsAt 起，按套餐 cycleDays 滚动切分周期窗口
 *     [startsAt, startsAt+d)、[startsAt+d, startsAt+2d)、…；
 *   - 每期开始（periodStart <= now）即获得本期积分；
 *   - 最后一期可能不满整周期（periodEnd 被 expiresAt 截断），额度仍按整期发放；
 *   - 已发放进度由 lastGrantPeriodEnd 记录（null = 首期未发）；
 *   - worker 停机跨期时按台账逐期补发（幂等由 DB 唯一索引保证）。
 */

export interface PeriodWindow {
  periodStart: Date
  periodEnd: Date
}

export interface SubscriptionCycleInput {
  startsAt: Date
  expiresAt: Date
  /** 最近一次已发放周期的结束时刻（null = 首期未发放） */
  lastGrantPeriodEnd: Date | null
  cycleDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

/**
 * 计算当前应补发的所有周期窗口（按时间升序）。
 *
 * 从发放进度锚点（lastGrantPeriodEnd ?? startsAt）开始向后滚动，
 * 收集所有 periodStart <= now 且 periodStart < expiresAt 的窗口。
 * 无到期窗口返回空数组。
 */
export function computeDuePeriods(
  sub: SubscriptionCycleInput,
  now: Date = new Date(),
): PeriodWindow[] {
  if (sub.cycleDays <= 0) return []

  const out: PeriodWindow[] = []
  let anchor = sub.lastGrantPeriodEnd ?? sub.startsAt

  while (anchor.getTime() <= now.getTime() && anchor.getTime() < sub.expiresAt.getTime()) {
    const rawEnd = addDays(anchor, sub.cycleDays)
    const periodEnd = rawEnd.getTime() < sub.expiresAt.getTime() ? rawEnd : sub.expiresAt
    out.push({ periodStart: anchor, periodEnd })
    anchor = rawEnd // 下一期起点（可能已越过 expiresAt，循环自行退出）
  }
  return out
}

/**
 * 下次发放时刻（用于账户弹窗展示）：
 * 进度锚点 + cycleDays，且不超过 expiresAt；无后续发放返回 null。
 */
export function nextGrantAt(
  sub: SubscriptionCycleInput,
  now: Date = new Date(),
): Date | null {
  if (now.getTime() >= sub.expiresAt.getTime()) return null
  const anchor = sub.lastGrantPeriodEnd ?? sub.startsAt
  const next = addDays(anchor, sub.cycleDays)
  return next.getTime() < sub.expiresAt.getTime() ? next : null
}
