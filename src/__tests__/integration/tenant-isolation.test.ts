import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  creditTransactions,
  enterprises,
  generationTasks,
  permissionGroups,
  users,
} from "@/db/schema"
import { deductCredits } from "@/server/services/credits-service"

/**
 * 多租户隔离测试（手册 §10.6）
 *
 * 验证：A 企业的扣减只产生 A 企业的流水，B 企业查不到 A 企业的数据。
 */

let entA: string
let entB: string
let userA: string

beforeAll(async () => {
  const [a] = await db
    .insert(enterprises)
    .values({
      name: "企业A",
      slug: `iso-a-${randomUUID().slice(0, 8)}`,
      creditsBalance: 500,
    })
    .returning()
  entA = a!.id

  const [b] = await db
    .insert(enterprises)
    .values({
      name: "企业B",
      slug: `iso-b-${randomUUID().slice(0, 8)}`,
      creditsBalance: 500,
    })
    .returning()
  entB = b!.id

  const [gA] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entA,
      name: "默认A",
      isDefault: true,
    })
    .returning()

  const [u] = await db
    .insert(users)
    .values({
      username: `userA_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entA,
      groupId: gA!.id,
    })
    .returning()
  userA = u!.id
})

afterAll(async () => {
  for (const id of [entA, entB]) {
    await db.delete(generationTasks).where(eq(generationTasks.enterpriseId, id))
    await db.delete(creditTransactions).where(eq(creditTransactions.enterpriseId, id))
    await db.delete(users).where(eq(users.enterpriseId, id))
    await db.delete(permissionGroups).where(eq(permissionGroups.enterpriseId, id))
    await db.delete(enterprises).where(eq(enterprises.id, id))
  }
})

describe("多租户隔离（手册 §10.6 / §10.2 铁律）", () => {
  it("A 企业扣减只产生 A 企业流水，B 企业查不到", async () => {
    await deductCredits({
      enterpriseId: entA,
      amount: 100,
      userId: userA,
    })

    const txsA = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.enterpriseId, entA))
    const txsB = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.enterpriseId, entB))

    expect(txsA.length).toBeGreaterThan(0)
    expect(txsB).toHaveLength(0)
  })

  it("A 企业扣减不影响 B 企业余额", async () => {
    const [b] = await db
      .select({ balance: enterprises.creditsBalance })
      .from(enterprises)
      .where(eq(enterprises.id, entB))
    expect(b!.balance).toBe(500) // B 余额不变
  })
})
