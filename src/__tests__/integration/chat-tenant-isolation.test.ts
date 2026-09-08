import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  chatConversations,
  chatMessages,
  creditTransactions,
  enterprises,
  permissionGroups,
  users,
} from "@/db/schema"
import { encrypt } from "@/lib/crypto"
import {
  checkChatModelAccess,
  createChatConversation,
  getOwnedChatConversation,
  listAccessibleChatModels,
  settleChatUsage,
} from "@/server/services/chat-service"
import type { UserContext } from "@/lib/auth/session"

type EnterpriseRow = typeof enterprises.$inferSelect
type PermissionGroupRow = typeof permissionGroups.$inferSelect

/**
 * AI 对话租户隔离 + 厘级计费结算集成测试
 *
 * 覆盖：
 * - 平台预置/企业私有模型的可见性与白名单过滤；
 * - 会话归属校验（跨用户/跨企业不可见）；
 * - settleChatUsage 厘级累计器边界（不足 1 积分不扣、满 1 积分扣整数、
 *   余额不足挂账自愈、流水 remark 正确）。
 */

let entA: string
let entB: string
let userA: string
let userA2: string
let presetModelId: string
let privateModelBId: string

function makeCtx(
  user: { id: string; enterpriseId: string },
  enterprise: EnterpriseRow,
  group: PermissionGroupRow | null,
): UserContext {
  return {
    user: {
      id: user.id,
      username: "test",
      name: null,
      email: null,
      image: null,
      isSuperAdmin: false,
      enterpriseId: user.enterpriseId,
      enterpriseRole: "member",
      groupId: group?.id ?? null,
      creditsBalance: 0,
    },
    enterprise,
    group,
    accessibleModules: ["chat"],
    canAccess: (m) => m === "chat",
  }
}

beforeAll(async () => {
  const [a] = await db
    .insert(enterprises)
    .values({ name: "对话企业A", slug: `chat-iso-a-${randomUUID().slice(0, 8)}`, creditsBalance: 0 })
    .returning()
  entA = a!.id
  const [b] = await db
    .insert(enterprises)
    .values({ name: "对话企业B", slug: `chat-iso-b-${randomUUID().slice(0, 8)}`, creditsBalance: 0 })
    .returning()
  entB = b!.id

  const [gA] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entA, name: "默认组A", isDefault: true })
    .returning()

  const [u1] = await db
    .insert(users)
    .values({
      username: `chatuser1_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entA,
      groupId: gA!.id,
      creditsBalance: 10,
    })
    .returning()
  userA = u1!.id
  const [u2] = await db
    .insert(users)
    .values({
      username: `chatuser2_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entA,
      groupId: gA!.id,
      creditsBalance: 10,
    })
    .returning()
  userA2 = u2!.id

  // 平台预置（enterpriseId NULL）+ 企业 B 私有
  const [preset] = await db
    .insert(chatApiConfigs)
    .values({
      enterpriseId: null,
      name: `gpt-test-${randomUUID().slice(0, 6)}`,
      displayName: "平台预置对话模型",
      apiEndpoint: "https://api.example.com/v1",
      apiKeyEncrypted: encrypt("test-key"),
      formatType: "openai",
      inputPriceCenticredits: 250,
      outputPriceCenticredits: 1000,
      maxContextTokens: 128000,
      maxOutputTokens: 8192,
    })
    .returning()
  presetModelId = preset!.id

  const [privateB] = await db
    .insert(chatApiConfigs)
    .values({
      enterpriseId: entB,
      name: `claude-test-${randomUUID().slice(0, 6)}`,
      displayName: "企业B私有对话模型",
      apiEndpoint: "https://api.anthropic.com",
      apiKeyEncrypted: encrypt("test-key"),
      formatType: "claude",
    })
    .returning()
  privateModelBId = privateB!.id

  return { a, b, gA, u1, u2, preset, privateB }
})

afterAll(async () => {
  for (const id of [entA, entB]) {
    await db.delete(chatMessages).where(eq(chatMessages.enterpriseId, id))
    await db.delete(chatConversations).where(eq(chatConversations.enterpriseId, id))
    await db.delete(creditTransactions).where(eq(creditTransactions.enterpriseId, id))
    await db.delete(users).where(eq(users.enterpriseId, id))
    await db.delete(permissionGroups).where(eq(permissionGroups.enterpriseId, id))
    await db.delete(enterprises).where(eq(enterprises.id, id))
  }
  await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, presetModelId))
  await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, privateModelBId))
})

describe("对话模型可见性（租户双轨 + 白名单）", () => {
  it("企业 A 可见平台预置，看不见企业 B 私有模型", async () => {
    const [entARow] = await db.select().from(enterprises).where(eq(enterprises.id, entA))
    const [groupRow] = await db.select().from(permissionGroups).where(eq(permissionGroups.enterpriseId, entA))
    const ctx = makeCtx({ id: userA, enterpriseId: entA }, entARow!, groupRow!)

    const models = await listAccessibleChatModels(ctx)
    const ids = models.map((m) => m.id)
    expect(ids).toContain(presetModelId)
    expect(ids).not.toContain(privateModelBId)

    // checkChatModelAccess：跨企业私有模型拒绝
    const [privateBRow] = await db.select().from(chatApiConfigs).where(eq(chatApiConfigs.id, privateModelBId))
    expect(checkChatModelAccess(ctx, privateBRow!)).toContain("未在企业可用范围")
  })

  it("白名单非空时：不在白名单内的平台预置被过滤", async () => {
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [randomUUID()] })
      .where(eq(enterprises.id, entA))
    const [entARow] = await db.select().from(enterprises).where(eq(enterprises.id, entA))
    const [groupRow] = await db.select().from(permissionGroups).where(eq(permissionGroups.enterpriseId, entA))
    const ctx = makeCtx({ id: userA, enterpriseId: entA }, entARow!, groupRow!)

    const models = await listAccessibleChatModels(ctx)
    expect(models.map((m) => m.id)).not.toContain(presetModelId)

    // 还原：空 = 全部可见
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [] })
      .where(eq(enterprises.id, entA))
  })
})

describe("会话归属隔离", () => {
  it("A 用户创建的会话，同企业其他用户 / 跨企业均不可见", async () => {
    const [entARow] = await db.select().from(enterprises).where(eq(enterprises.id, entA))
    const [groupRow] = await db.select().from(permissionGroups).where(eq(permissionGroups.enterpriseId, entA))
    const ctxA = makeCtx({ id: userA, enterpriseId: entA }, entARow!, groupRow!)

    const created = await createChatConversation({
      ctx: ctxA,
      title: "隔离测试会话",
      modelId: presetModelId,
      thinkingLevel: "off",
    })

    expect(await getOwnedChatConversation(ctxA, created.id)).not.toBeNull()

    const ctxA2 = makeCtx({ id: userA2, enterpriseId: entA }, entARow!, groupRow!)
    expect(await getOwnedChatConversation(ctxA2, created.id)).toBeNull()

    const [entBRow] = await db.select().from(enterprises).where(eq(enterprises.id, entB))
    const ctxB = makeCtx({ id: userA, enterpriseId: entB }, entBRow!, null)
    expect(await getOwnedChatConversation(ctxB, created.id)).toBeNull()
  })
})

describe("厘级计费结算 settleChatUsage", () => {
  async function setUserBalances(balance: number, unbilled: number) {
    await db
      .update(users)
      .set({ creditsBalance: balance, chatUnbilledCenticredits: unbilled })
      .where(eq(users.id, userA))
  }
  async function readUser() {
    const [row] = await db
      .select({
        balance: users.creditsBalance,
        unbilled: users.chatUnbilledCenticredits,
      })
      .from(users)
      .where(eq(users.id, userA))
    return row!
  }

  const model = { displayName: "平台预置对话模型", inputPriceCenticredits: 250, outputPriceCenticredits: 1000 }

  it("零价格模型免费（0 厘、不动余额）", async () => {
    await setUserBalances(10, 0)
    const r = await settleChatUsage({
      enterpriseId: entA,
      userId: userA,
      model: { displayName: "免费模型", inputPriceCenticredits: 0, outputPriceCenticredits: 0 },
      inputTokens: 12345,
      outputTokens: 678,
    })
    expect(r.costCenticredits).toBe(0)
    expect((await readUser()).balance).toBe(10)
  })

  it("累计不足 1 积分不扣余额，零头留在累计器", async () => {
    await setUserBalances(10, 0)
    // 3500 输入 + 800 输出 = 1.675 厘 → 2 厘
    const r = await settleChatUsage({ enterpriseId: entA, userId: userA, model, inputTokens: 3500, outputTokens: 800 })
    expect(r.costCenticredits).toBe(2)
    expect(r.chargedCredits).toBe(0)
    expect((await readUser()).unbilled).toBe(2)
    expect((await readUser()).balance).toBe(10)
  })

  it("累计满 100 厘扣 1 积分并写流水，余数保留", async () => {
    await setUserBalances(10, 99)
    const r = await settleChatUsage({ enterpriseId: entA, userId: userA, model, inputTokens: 3500, outputTokens: 800 })
    expect(r.chargedCredits).toBe(1)
    const u = await readUser()
    expect(u.balance).toBe(9)
    expect(u.unbilled).toBe(1) // 99 + 2 - 100

    const [tx] = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userA))
      .orderBy(creditTransactions.createdAt)
      .limit(1)
    expect(tx!.type).toBe("allocation_deduct")
    expect(tx!.amount).toBe(-1)
    expect(tx!.remark).toContain("AI 对话消耗")
  })

  it("累计跨多积分（250 厘 → 扣 2 余 50）", async () => {
    await setUserBalances(10, 0)
    // 500k 输入 × 250/1M = 125 厘 + 125k 输出 × 1000/1M = 125 厘 = 250 厘
    const r = await settleChatUsage({ enterpriseId: entA, userId: userA, model, inputTokens: 500_000, outputTokens: 125_000 })
    expect(r.costCenticredits).toBe(250)
    expect(r.chargedCredits).toBe(2)
    const u = await readUser()
    expect(u.balance).toBe(8)
    expect(u.unbilled).toBe(50)
  })

  it("余额不足以覆盖整扣时挂账不透支，余额恢复后自动补扣（自愈）", async () => {
    await setUserBalances(0, 0)
    // 需扣 7 积分但余额 0：不扣，零头全挂账
    const r = await settleChatUsage({ enterpriseId: entA, userId: userA, model, inputTokens: 1_000_000, outputTokens: 500_000 })
    expect(r.costCenticredits).toBe(750)
    expect(r.chargedCredits).toBe(0)
    expect((await readUser()).balance).toBe(0)
    expect((await readUser()).unbilled).toBe(750)

    // 余额 5 仍 < 7：继续挂账
    await setUserBalances(5, 750)
    const r2 = await settleChatUsage({ enterpriseId: entA, userId: userA, model, inputTokens: 3500, outputTokens: 800 })
    expect(r2.chargedCredits).toBe(0)
    const u = await readUser()
    expect(u.balance).toBe(5)
    expect(u.unbilled).toBe(752)

    // 余额 10 ≥ 7：下条消息结算时一次性补扣
    await setUserBalances(10, 752)
    const r3 = await settleChatUsage({ enterpriseId: entA, userId: userA, model, inputTokens: 3500, outputTokens: 800 })
    expect(r3.chargedCredits).toBe(7)
    const u2 = await readUser()
    expect(u2.balance).toBe(3)
    expect(u2.unbilled).toBe(54) // 752 + 2 - 700
  })
})
