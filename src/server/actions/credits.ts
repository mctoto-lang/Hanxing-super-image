"use server"

import { creditTxTypeEnum } from "@/db/schema"
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

type CreditTxType = (typeof creditTxTypeEnum)["enumValues"][number]

/** 列出本企业积分流水（分页） */
export async function listTransactionsAction(opts?: {
  page?: number
  pageSize?: number
  type?: CreditTxType
}) {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts?.pageSize ?? 20)))
  const result = await listTransactions({
    enterpriseId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    type: opts?.type,
  })
  return { ...result, page, pageSize }
}
