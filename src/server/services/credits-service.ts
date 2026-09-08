import { and, eq, gte, ilike, lt, or, sql } from "drizzle-orm"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  generationTasks,
  taskSourceEnum,
  users,
  creditTxTypeEnum,
} from "@/db/schema"

type CreditTxType = (typeof creditTxTypeEnum.enumValues)[number]

/** 事务句柄类型（供调用方将多个积分变动并入同一事务） */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

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
  input: BaseTxInput & { amount: number; tx?: DbTx },
): Promise<{ balanceAfter: number }> {
  const {
    enterpriseId,
    amount,
    userId,
    taskId,
    remark,
    tx: externalTx,
  } = input
  if (amount <= 0) throw new Error("扣减金额必须为正数")
  if (!userId) throw new Error("扣减个人配额必须提供 userId")

  const run = async (tx: DbTx): Promise<{ balanceAfter: number }> => {
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
  }

  if (externalTx) return run(externalTx)
  return db.transaction(run)
}

/**
 * 退还积分到成员个人配额（需求 3：任务失败退还到个人配额）
 *
 * 可传入 tx 将退还并入调用方事务（如 refundFailedTask 的「认领+退款」
 * 原子提交）；不传则自开事务。
 */
export async function refundUserCredits(
  input: BaseTxInput & { amount: number; tx?: DbTx },
): Promise<{ balanceAfter: number }> {
  const { enterpriseId, amount, userId, taskId, remark, tx: externalTx } = input
  if (amount <= 0) throw new Error("退还金额必须为正数")
  if (!userId) throw new Error("退还个人配额必须提供 userId")

  const run = async (tx: DbTx): Promise<{ balanceAfter: number }> => {
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
  }

  if (externalTx) return run(externalTx)
  return db.transaction(run)
}

/**
 * 退款（任务失败时由队列消费者/回收通道调用，退还到成员个人配额）。
 * 按张退款：成功交付张数保留计费，失败张数退还；旧行无单价记录时全额退。
 *
 * 幂等保护：孤儿回收与消费端失败路径可能并发触发退款，这里用
 * creditsCharged 条件更新做「认领」——仅当值仍等于读取值时才执行退款，
 * 并发另一方认领失败直接返回，杜绝双倍退款（凭空增发积分）。
 *
 * 原子性：认领与退款在同一事务内提交。此前两步分离提交存在「认领成功、
 * 退款写入失败」的窗口，退款会永久丢失；现在任一步失败整体回滚，重试时
 * creditsCharged 仍是原值，可再次认领退款。
 *
 * 注意：本函数属于计费内部逻辑，绝不可放在 "use server" 文件中导出——
 * 那样会把它暴露为可 HTTP 调用的 Server Action 端点（无归属/状态校验，
 * 等于任意任务可退款，计费被绕过）。
 */
export async function refundFailedTask(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(generationTasks)
      .where(eq(generationTasks.id, taskId))
      .limit(1)
    if (!task || task.creditsCharged <= 0) return

    let refund = task.creditsCharged
    let remaining = 0
    if (task.costPerImage != null) {
      const succeededCount = task.succeededIndexes?.length ?? 0
      remaining = Math.min(
        task.creditsCharged,
        succeededCount * task.costPerImage,
      )
      refund = task.creditsCharged - remaining
    }

    // 认领：将 creditsCharged 原子地置为 remaining（仅当未被并发方改动）
    const claimed = await tx
      .update(generationTasks)
      .set({ creditsCharged: remaining })
      .where(
        and(
          eq(generationTasks.id, taskId),
          eq(generationTasks.creditsCharged, task.creditsCharged),
        ),
      )
      .returning({ id: generationTasks.id })
    if (claimed.length === 0) return // 已被并发调用方处理

    if (refund > 0) {
      const failedCount = task.costPerImage != null
        ? Math.floor(refund / task.costPerImage)
        : task.imageCount
      await refundUserCredits({
        enterpriseId: task.enterpriseId,
        amount: refund,
        userId: task.userId,
        taskId: task.id,
        remark: `任务失败退还（${failedCount} 张）`,
        tx,
      })
    }
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

/**
 * 流水查询（按企业，分页；可按用户关键词 / 模块 / 日期范围筛选）。
 *
 * 模块推导：taskId 关联 generation_task（无外键，任务删除后 source 为
 * null）；AI 对话流水的 taskId 存的是 assistant 消息 id，join 不到任务，
 * 靠备注前缀「AI 对话」识别，筛选时同样按备注前缀匹配。
 */
export async function listTransactions(opts: {
  enterpriseId: string
  limit?: number
  offset?: number
  type?: CreditTxType
  /** 用户关键词（username / 昵称模糊） */
  q?: string
  /** 精确按触发者过滤（个人积分流水：allocation/allocation_deduct 等的 userId） */
  userId?: string
  /** 模块筛选：source 五枚举之一，或 "chat"（AI 对话，按备注前缀） */
  module?: string
  /** 起始时刻（含） */
  from?: Date
  /** 排除上界（toEnd） */
  toEnd?: Date
}): Promise<{
  items: Array<
    (typeof creditTransactions.$inferSelect) & {
      /** 触发者显示名（昵称缺省回退用户名；userId 为空时无） */
      userName: string | null
      /** 关联生图任务的 source（对话 / 无任务流水为 null） */
      source: string | null
    }
  >
  total: number
}> {
  const {
    enterpriseId,
    limit = 50,
    offset = 0,
    type,
    q,
    userId,
    module,
    from,
    toEnd,
  } = opts

  const conds = [eq(creditTransactions.enterpriseId, enterpriseId)]
  if (type) conds.push(eq(creditTransactions.type, type))
  if (userId) conds.push(eq(creditTransactions.userId, userId))
  if (q) {
    const kw = `%${q}%`
    conds.push(or(ilike(users.username, kw), ilike(users.name, kw))!)
  }
  if (module === "chat") {
    conds.push(ilike(creditTransactions.remark, "AI 对话%"))
  } else if (module) {
    conds.push(
      eq(
        generationTasks.source,
        module as (typeof taskSourceEnum.enumValues)[number],
      ),
    )
  }
  if (from) conds.push(gte(creditTransactions.createdAt, from))
  if (toEnd) conds.push(lt(creditTransactions.createdAt, toEnd))
  const where = and(...conds)

  const joinUsers = () =>
    db
      .select({
        tx: creditTransactions,
        name: users.name,
        username: users.username,
        source: generationTasks.source,
      })
      .from(creditTransactions)
      .leftJoin(users, eq(creditTransactions.userId, users.id))
      .leftJoin(generationTasks, eq(creditTransactions.taskId, generationTasks.id))

  const [rows, [{ count }]] = await Promise.all([
    joinUsers()
      .where(where)
      .orderBy(sql`${creditTransactions.createdAt} DESC`)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(creditTransactions)
      .leftJoin(users, eq(creditTransactions.userId, users.id))
      .leftJoin(generationTasks, eq(creditTransactions.taskId, generationTasks.id))
      .where(where),
  ])

  return {
    items: rows.map((r) => ({
      ...r.tx,
      userName: r.name || r.username || null,
      source: r.source ?? null,
    })),
    total: count,
  }
}
