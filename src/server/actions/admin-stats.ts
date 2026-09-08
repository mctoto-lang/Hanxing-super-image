"use server"

import {
  requireEnterpriseAdmin,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import {
  getMemberUsageStats,
  getUsageBreakdown,
  normalizeBreakdownRange,
  type MemberUsageStats,
  type UsageBreakdown,
} from "@/server/services/member-stats-service"

/** 成员管理数据面板聚合（企业管理员，企业范围） */
export async function getMemberUsageStatsAction(): Promise<MemberUsageStats> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return getMemberUsageStats(enterpriseId)
}

/**
 * 数据看板明细（模块 / 模型 / 成员消耗），按日期范围聚合。
 * 日期为 YYYY-MM-DD（统计口径时区），服务端做格式与跨度收敛。
 */
export async function getUsageBreakdownAction(input: {
  from: string
  to: string
}): Promise<UsageBreakdown> {
  const ctx = await requireEnterpriseAdmin()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const { from, to } = normalizeBreakdownRange(input.from, input.to)
  return getUsageBreakdown(enterpriseId, from, to)
}
