import { and, eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  users,
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

/**
 * 分配积分给企业成员（需求 3：企业池 → 成员个人配额）
 *
 * 单事务 + 行锁：
 *   1. 锁 enterprise 行，校验企业池余额 ≥ amount，扣减企业池；
 *   2. 锁 target user 行，累加到其个人配额 credits_balance；
 *   3. 写一条 allocation 流水（amount 负，userId=target，记录分配对象）。
 *
 * 流水记在企业维度（balanceAfter = 企业池扣减后余额），保持企业池审计完整；
 * 用户配额的变动可通过同一流水的 userId 字段追溯。
 */
export async function allocateCreditsToUser(input: {
  enterpriseId: string
  operatorUserId: string // 操作的企业管理员
  targetUserId: string // 被分配的成员
  amount: number
  remark?: string
}): Promise<{ balanceAfter: number; userBalanceAfter: number }> {
  const {
    enterpriseId,
    operatorUserId,
    targetUserId,
    amount,
    remark,
  } = input
  if (amount <= 0) throw new Error("分配金额必须为正数")

  return await db.transaction(async (tx) => {
    // 1. 锁企业池 + 扣减
    const [ent] = await tx
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, enterpriseId))
      .for("update")
    if (!ent) throw new Error("企业不存在")
    if (ent.balance < amount) {
      throw new CreditsInsufficientError(
        "企业池积分不足以分配",
        amount,
        ent.balance,
      )
    }
    const [entUpdated] = await tx
      .update(enterprises)
      .set({
        creditsBalance: sql`${enterprises.creditsBalance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(enterprises.id, enterpriseId))
      .returning({ balance: enterprises.creditsBalance })

    // 2. 锁成员个人配额 + 累加
    const [user] = await tx
      .select({ balance: users.creditsBalance, enterpriseId: users.enterpriseId })
      .from(users)
      .where(eq(users.id, targetUserId))
      .for("update")
    if (!user) throw new Error("成员不存在")
    if (user.enterpriseId !== enterpriseId) {
      throw new Error("目标成员不属于本企业")
    }
    const [userUpdated] = await tx
      .update(users)
      .set({
        creditsBalance: sql`${users.creditsBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetUserId))
      .returning({ balance: users.creditsBalance })

    // 3. 写流水（企业维度，balanceAfter = 企业池扣减后；userId=target 记录分配对象）
    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId: targetUserId,
      type: "allocation",
      amount: -amount,
      balanceAfter: entUpdated!.balance,
      remark: remark ?? `分配给成员（操作人 ${operatorUserId}）`,
    })

    return {
      balanceAfter: entUpdated!.balance,
      userBalanceAfter: userUpdated!.balance,
    }
  })
}

/**
 * 从成员个人配额扣减积分（需求 3：成员生图扣个人配额）
 *
 * 单事务 + 行锁：
 *   1. 锁 user 行，校验个人配额余额 ≥ amount；
 *   2. UPDATE 个人配额 -amount；
 *   3. 写一条 allocation_deduct 流水（关联 enterpriseId+userId+taskId）。
 */
export async function deductUserCredits(
  input: BaseTxInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, taskId, remark } = input
  if (amount <= 0) throw new Error("扣减金额必须为正数")
  if (!userId) throw new Error("扣减个人配额必须提供 userId")

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        balance: users.creditsBalance,
        enterpriseId: users.enterpriseId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")

    if (!row) throw new Error("用户不存在")
    if (row.enterpriseId !== enterpriseId) {
      throw new Error("用户不属于该企业")
    }
    if (row.balance < amount) {
      throw new CreditsInsufficientError("个人配额不足", amount, row.balance)
    }

    const [updated] = await tx
      .update(users)
      .set({
        creditsBalance: sql`${users.creditsBalance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ balance: users.creditsBalance })

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId,
      type: "allocation_deduct",
      amount: -amount,
      balanceAfter: updated!.balance,
      taskId: taskId ?? null,
      remark: remark ?? "生图消费（个人配额）",
    })

    return { balanceAfter: updated!.balance }
  })
}

/**
 * 退还积分到成员个人配额（需求 3：任务失败退还到个人配额）
 */
export async function refundUserCredits(
  input: BaseTxInput & { amount: number },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, taskId, remark } = input
  if (amount <= 0) throw new Error("退还金额必须为正数")
  if (!userId) throw new Error("退还个人配额必须提供 userId")

  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({
        creditsBalance: sql`${users.creditsBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({ balance: users.creditsBalance })

    if (!updated) throw new Error("用户不存在")

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId,
      type: "allocation_refund",
      amount,
      balanceAfter: updated.balance,
      taskId: taskId ?? null,
      remark: remark ?? "任务失败退还（个人配额）",
    })

    return { balanceAfter: updated.balance }
  })
}

/**
 * 将成员个人配额直接设为新余额（企业管理员人工调整）
 *
 * 单事务 + 行锁：
 *   1. 锁 target user 行，校验属于本企业；
 *   2. 按差额 delta = newBalance - 当前余额 更新（delta 可正可负）；
 *   3. 写一条 adjustment 流水（amount=delta，balanceAfter=新余额快照）。
 *
 * 与企业池无关：不触碰 enterprises.creditsBalance。
 */
export async function setUserCreditsBalance(input: {
  enterpriseId: string
  operatorUserId: string
  targetUserId: string
  newBalance: number
  remark?: string
}): Promise<{ balanceAfter: number; delta: number }> {
  const { enterpriseId, operatorUserId, targetUserId, newBalance, remark } =
    input
  if (!Number.isInteger(newBalance) || newBalance < 0) {
    throw new Error("新余额必须是不小于 0 的整数")
  }

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        balance: users.creditsBalance,
        enterpriseId: users.enterpriseId,
      })
      .from(users)
      .where(eq(users.id, targetUserId))
      .for("update")

    if (!row) throw new Error("成员不存在")
    if (row.enterpriseId !== enterpriseId) {
      throw new Error("目标成员不属于本企业")
    }

    const delta = newBalance - row.balance
    if (delta === 0) {
      return { balanceAfter: row.balance, delta: 0 }
    }

    const [updated] = await tx
      .update(users)
      .set({
        creditsBalance: sql`${users.creditsBalance} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetUserId))
      .returning({ balance: users.creditsBalance })

    await tx.insert(creditTransactions).values({
      enterpriseId,
      userId: targetUserId,
      type: "adjustment",
      amount: delta,
      balanceAfter: updated!.balance,
      remark:
        remark ??
        `个人配额调整：${row.balance} → ${newBalance}（操作人 ${operatorUserId}）`,
    })

    return { balanceAfter: updated!.balance, delta }
  })
}

/** 流水查询（按企业，分页） */
export async function listTransactions(opts: {
  enterpriseId: string
  limit?: number
  offset?: number
  type?: CreditTxType
}): Promise<{
  items: (typeof creditTransactions.$inferSelect)[]
  total: number
}> {
  const { enterpriseId, limit = 50, offset = 0, type } = opts

  const where = type
    ? and(
        eq(creditTransactions.enterpriseId, enterpriseId),
        eq(creditTransactions.type, type),
      )
    : eq(creditTransactions.enterpriseId, enterpriseId)

  const [items, [{ count }]] = await Promise.all([
    db
      .select()
      .from(creditTransactions)
      .where(where)
      .orderBy(sql`${creditTransactions.createdAt} DESC`)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creditTransactions)
      .where(where),
  ])

  return { items, total: count }
}
