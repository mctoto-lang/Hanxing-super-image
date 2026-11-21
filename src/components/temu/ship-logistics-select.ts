/**
 * 物流公司自动选择（自动预约发货 / 更换物流弹窗共用，纯函数）。
 *
 * 口径（从 AutoReserveDialog 抽出，行为不变）：
 * 1. 比价结果剔除黑名单（expressCompanyId 缺失项也不可自动选）；
 * 2. 取企业「优先顺序」中第一个本次比价可用的公司；
 * 3. 优先名单全不可用 → 回落平台常用（mostUsed，若本次可用）；
 * 4. 常用也不可用 → 取比价列表首个公司。
 * 全部在黑名单 / 空列表时不选，由调用方决定提示文案。
 */
export interface LogisticsOptionLike {
  expressCompanyId?: number | null
  expressCompanyName?: string | null
}

export interface LogisticsPrefLike {
  expressCompanyId: number
  expressCompanyName: string
}

export type LogisticsPickResult<T> =
  | { option: T; reason: "priority" | "most-used" | "first" }
  | { option: null; reason: "empty" | "all-blacklisted" }

export function pickLogisticsOption<T extends LogisticsOptionLike>(
  list: readonly T[],
  priority: readonly LogisticsPrefLike[],
  blacklist: readonly LogisticsPrefLike[],
  mostUsed?: { expressCompanyId?: number | null } | null,
): LogisticsPickResult<T> {
  if (list.length === 0) return { option: null, reason: "empty" }
  const blackIds = new Set(blacklist.map((b) => b.expressCompanyId))
  const candidates = list.filter((o) => o.expressCompanyId != null && !blackIds.has(o.expressCompanyId))
  if (candidates.length === 0) return { option: null, reason: "all-blacklisted" }
  const pick = priority
    .map((p) => candidates.find((o) => o.expressCompanyId === p.expressCompanyId))
    .find(Boolean)
  if (pick) return { option: pick, reason: "priority" }
  const used =
    mostUsed?.expressCompanyId != null
      ? candidates.find((o) => o.expressCompanyId === mostUsed.expressCompanyId)
      : undefined
  if (used) return { option: used, reason: "most-used" }
  return { option: candidates[0]!, reason: "first" }
}
