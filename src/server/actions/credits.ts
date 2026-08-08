"use server"

import {
  requireEnterpriseContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { listTransactions } from "@/server/services/credits-service"

/**
 * 积分流水查询 Server Actions（手册 M2）
 *
 * 企业成员可查本企业流水（手册 D8：共享积分池）。
 */

export async function listTransactionsAction(opts?: {
  limit?: number
  offset?: number
}) {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  return await listTransactions({
    enterpriseId,
    limit: opts?.limit ?? 50,
    offset: opts?.offset ?? 0,
  })
}
