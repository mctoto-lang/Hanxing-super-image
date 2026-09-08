"use server"

import { creditTxTypeEnum } from "@/db/schema"
import {
  requireEnterpriseContext,
  getCurrentEnterpriseScope,
} from "@/lib/auth/session"
import { parseDayRange } from "@/lib/admin/table-filters"
import { listTransactions } from "@/server/services/credits-service"

/**
 * 积分流水查询 Server Actions（手册 M2）
 *
 * 企业成员可查本企业流水（手册 D8：共享积分池）。
 */

type CreditTxType = (typeof creditTxTypeEnum)["enumValues"][number]

/** 列出本企业积分流水（分页，可按用户 / 模块 / 日期筛选） */
export async function listTransactionsAction(opts?: {
  page?: number
  pageSize?: number
  type?: CreditTxType
  /** 用户关键词（username / 昵称模糊） */
  q?: string
  /** 模块：source 五枚举之一或 "chat" */
  module?: string
  /** 日期范围（YYYY-MM-DD，Asia/Shanghai 日界） */
  from?: string
  to?: string
}) {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts?.pageSize ?? 20)))
  const { from, toEnd } = parseDayRange(opts?.from, opts?.to)
  const result = await listTransactions({
    enterpriseId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    type: opts?.type,
    q: opts?.q?.trim() || undefined,
    module: opts?.module?.trim() || undefined,
    from,
    toEnd,
  })
  return { ...result, page, pageSize }
}

/**
 * 我的积分流水（账户弹窗「积分额度」页签）：
 * 按当前用户 userId 过滤（分配到账 / 个人消费 / 退还等），最新在前。
 */
export async function listMyTransactionsAction(opts?: {
  page?: number
  pageSize?: number
}) {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const pageSize = Math.min(20, Math.max(1, Math.floor(opts?.pageSize ?? 10)))
  const result = await listTransactions({
    enterpriseId,
    userId: ctx.user.id,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  })
  return { ...result, page, pageSize }
}
