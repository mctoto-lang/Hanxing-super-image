import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { and, eq, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  permissionGroups,
  users,
} from "@/db/schema"
import {
  deductCredits,
  CreditsInsufficientError,
} from "@/server/services/credits-service"

/**
 * 积分并发扣减集成测试（手册 §10.6 测试铁律 —— 计费系统红线）
 *
 * 验证：N 个并发请求同时扣减同一企业，不会超扣，余额精确，流水一致。
 */

const TEST_SLUG = "test-concurrency-enterprise"
let testEnterpriseId: string
let testUserId: string

beforeAll(async () => {
  // 创建测试企业（带已知余额）
  const [enterprise] = await db
    .insert(enterprises)
    .values({
      name: "并发测试企业",
      slug: TEST_SLUG,
      creditsBalance: 1000,
      maxConcurrent: 100,
    })
    .returning()
  testEnterpriseId = enterprise!.id

  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: testEnterpriseId,
      name: "测试组",
      isDefault: true,
      maxConcurrent: 100,
    })
    .returning()

  const [user] = await db
    .insert(users)
    .values({
      username: `tester_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyhashfortestonlyxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: testEnterpriseId,
      groupId: group!.id,
    })
    .returning()
  testUserId = user!.id
})

afterAll(async () => {
  // 清理测试数据（cascade 会带走子表）
  if (testEnterpriseId) {
    await db.delete(creditTransactions).where(eq(creditTransactions.enterpriseId, testEnterpriseId))
    await db.delete(users).where(eq(users.enterpriseId, testEnterpriseId))
    await db.delete(permissionGroups).where(eq(permissionGroups.enterpriseId, testEnterpriseId))
    await db.delete(enterprises).where(eq(enterprises.id, testEnterpriseId))
  }
})

beforeEach(async () => {
  // 每个测试前重置余额为 1000
  await db
    .update(enterprises)
    .set({ creditsBalance: 1000 })
    .where(eq(enterprises.id, testEnterpriseId))
  await db
    .delete(creditTransactions)
    .where(eq(creditTransactions.enterpriseId, testEnterpriseId))
})

describe("积分并发扣减（手册 §10.6 红线）", () => {
  it("单次扣减应正确扣减并写流水", async () => {
    const { balanceAfter } = await deductCredits({
      enterpriseId: testEnterpriseId,
      amount: 100,
      userId: testUserId,
    })
    expect(balanceAfter).toBe(900)

    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.enterpriseId, testEnterpriseId))
    expect(txs).toHaveLength(1)
    expect(txs[0]!.amount).toBe(-100)
    expect(txs[0]!.balanceAfter).toBe(900)
    expect(txs[0]!.type).toBe("consumption")
  })

  it("★ 并发扣减 100 个 × 10 积分，余额精确为 0，无超扣", async () => {
    const CONCURRENT = 100
    const PER = 10
    const TOTAL = CONCURRENT * PER // 1000

    // 同时发起 100 个扣减请求
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () =>
        deductCredits({
          enterpriseId: testEnterpriseId,
          amount: PER,
          userId: testUserId,
        }),
      ),
    )

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    // 100 个请求都应成功（余额恰好够）
    expect(fulfilled).toHaveLength(CONCURRENT)
    expect(rejected).toHaveLength(0)

    // 最终余额必须精确为 0
    const [final] = await db
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, testEnterpriseId))
    expect(final!.balance).toBe(0)

    // 流水数量 = 100
    const txs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.enterpriseId, testEnterpriseId))
    expect(txs).toHaveLength(CONCURRENT)

    // 流水 balanceAfter 应恰好覆盖 990,980,...,0 这 100 个值（无重复、无遗漏）
    // 并发事务 commit 顺序 ≠ createdAt 顺序，所以用集合断言而非时序断言
    const balances = txs.map((t) => t.balanceAfter).sort((a, b) => b - a)
    const expected = Array.from({ length: CONCURRENT }, (_, i) => i * PER).reverse()
    // expected: [0,10,20,...,990]，balances 排序后应为 [0,10,...,990]
    expect(balances).toEqual(expected)
    expect(new Set(balances).size).toBe(CONCURRENT) // 无重复（无重复扣同一余额快照）
  })

  it("★ 余额不足时，多余的并发请求应抛 CreditsInsufficientError，绝不超扣", async () => {
    // 余额 1000，发起 150 个 × 10 扣减，应只有 100 个成功，50 个失败
    const CONCURRENT = 150
    const PER = 10

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () =>
        deductCredits({
          enterpriseId: testEnterpriseId,
          amount: PER,
          userId: testUserId,
        }).catch((err) => {
          if (err instanceof CreditsInsufficientError) throw err
          throw err
        }),
      ),
    )

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof CreditsInsufficientError,
    )

    expect(fulfilled).toHaveLength(100)
    expect(rejected).toHaveLength(50)

    // 余额必须恰好为 0，绝不超扣（核心红线）
    const [final] = await db
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, testEnterpriseId))
    expect(final!.balance).toBe(0)
    expect(final!.balance).toBeGreaterThanOrEqual(0) // 不可为负
  })
})
