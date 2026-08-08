import { eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  creditTxTypeEnum,
} from "@/db/schema"

type CreditTxType = (typeof creditTxTypeEnum.enumValues)[number]

/**
 * 积分服务（手册 §4.2、§10.6 测试铁律）
 *
 * 计费红线：扣减必须用 PG 事务 + SELECT ... FOR UPDATE 行锁，防止并发超扣。
 * 每次变动都写一条 credit_transactions 流水（含 balanceAfter 快照）。
 */

export class CreditsInsufficientError extends Error {
  constructor(
    message = "积分不足",
    public needed?: number,
    public balance?: number,
  ) {
    super(message)
    this.name = "CreditsInsufficientError"
  }
}

interface BaseTxInput {
  enterpriseId: string
  userId?: string | null
  taskId?: string | null
  remark?: string
}

/**
 * 原子扣减积分（手册 §4.2 核心）
 *
 * 流程（单事务）：
 *   1. SELECT ... FOR UPDATE 锁住企业行；
 *   2. 校验余额 ≥ amount，不足抛 CreditsInsufficientError；
 *   3. UPDATE 余额 -amount，RETURNING 新余额；
 *   4. INSERT 流水（balanceAfter 快照）。
 */
export async function deductCredits(
  input: BaseTxInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, taskId, remark } = input
  if (amount <= 0) throw new Error("扣减金额必须为正数")

  return await db.transaction(async (tx) => {
    // 行锁
    const [row] = await tx
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, enterpriseId))
      .for("update")

    if (!row) throw new Error("企业不存在")
    if (row.balance < amount) {
      throw new CreditsInsufficientError("积分不足", amount, row.balance)
    }

    const [updated] = await tx
      .update(enterprises)
      .set({
        creditsBalance: sql`${enterprises.creditsBalance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(enterprises.id, enterpriseId))
      .returning({ balance: enterprises.creditsBalance })

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId: userId ?? null,
      type: "consumption",
      amount: -amount,
      balanceAfter: updated!.balance,
      taskId: taskId ?? null,
      remark: remark ?? null,
    })

    return { balanceAfter: updated!.balance }
  })
}

/**
 * 退还积分（任务失败时，手册 §4.2）
 */
export async function refundCredits(
  input: BaseTxInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, taskId, remark } = input
  if (amount <= 0) throw new Error("退还金额必须为正数")

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(enterprises)
      .set({
        creditsBalance: sql`${enterprises.creditsBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(enterprises.id, enterpriseId))
      .returning({ balance: enterprises.creditsBalance })

    if (!updated) throw new Error("企业不存在")

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId: userId ?? null,
      type: "refund",
      amount,
      balanceAfter: updated.balance,
      taskId: taskId ?? null,
      remark: remark ?? "任务失败退还",
    })

    return { balanceAfter: updated.balance }
  })
}

/**
 * 充值积分（超管操作，手册 D8）
 */
export async function rechargeCredits(
  input: BaseTxInput & { amount: number; operatorRole?: string },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, remark } = input
  if (amount <= 0) throw new Error("充值金额必须为正数")

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(enterprises)
      .set({
        creditsBalance: sql`${enterprises.creditsBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(enterprises.id, enterpriseId))
      .returning({ balance: enterprises.creditsBalance })

    if (!updated) throw new Error("企业不存在")

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId: userId ?? null,
      type: "recharge",
      amount,
      balanceAfter: updated.balance,
      remark: remark ?? "充值",
    })

    return { balanceAfter: updated.balance }
  })
}

/**
 * 人工调整积分（可正可负，手册 creditTxType adjustment）
 */
export async function adjustCredits(
  input: BaseTxInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, remark } = input
  if (amount === 0) throw new Error("调整金额不能为 0")

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, enterpriseId))
      .for("update")

    if (!row) throw new Error("企业不存在")
    if (amount < 0 && row.balance < Math.abs(amount)) {
      throw new CreditsInsufficientError("积分不足以扣减", Math.abs(amount), row.balance)
    }

    const [updated] = await tx
      .update(enterprises)
      .set({
        creditsBalance: sql`${enterprises.creditsBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(enterprises.id, enterpriseId))
      .returning({ balance: enterprises.creditsBalance })

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId: userId ?? null,
      type: "adjustment",
      amount,
      balanceAfter: updated!.balance,
      remark: remark ?? "人工调整",
    })

    return { balanceAfter: updated!.balance }
  })
}

/** 流水查询（按企业，分页） */
export async function listTransactions(opts: {
  enterpriseId: string
  limit?: number
  offset?: number
  type?: CreditTxType
}) {
  const { enterpriseId, limit = 50, offset = 0, type } = opts
  let query = db
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.enterpriseId, enterpriseId))
    .$dynamic()

  if (type) {
    query = query.where(eq(creditTransactions.type, type))
  }

  return await query
    .orderBy(sql`${creditTransactions.createdAt} DESC`)
    .limit(limit)
    .offset(offset)
}
