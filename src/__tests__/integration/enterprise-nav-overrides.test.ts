import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, users } from "@/db/schema"
import { updateEnterpriseNavAction } from "@/server/actions/platform"
import { getEnterpriseDetailAction } from "@/server/actions/platform"

/**
 * 企业导航名称自定义映射 + 测试企业开关（迁移 0100）集成回归：
 * - 超管专属：普通企业成员调用被拒；
 * - zod 键枚举（未知键拒绝）与长度上限；
 * - value trim 后空白剔除（= 恢复默认）；
 * - isTest + 覆盖落库可回读（getEnterpriseDetailAction 透出）。
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const runTag = randomUUID().slice(0, 8)

let entId: string
let superAdmin: string
let member: string

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "导航映射测试企业",
      slug: `nav-${runTag}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id

  const [s] = await db
    .insert(users)
    .values({
      username: `nav-super-${runTag}`,
      name: "nav 超管",
      passwordHash: "x",
      isSuperAdmin: true,
    })
    .returning()
  superAdmin = s!.id

  const [m] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `nav-member-${runTag}`,
      name: "nav 成员",
      passwordHash: "x",
    })
    .returning()
  member = m!.id
})

afterAll(async () => {
  await db.delete(users).where(eq(users.id, superAdmin))
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("updateEnterpriseNavAction", () => {
  it("非超管拒绝（requireSuperAdmin 抛 FORBIDDEN）", async () => {
    mockSession.userId = member
    await expect(
      updateEnterpriseNavAction({
        enterpriseId: entId,
        isTest: true,
        navTitleOverrides: {},
      }),
    ).rejects.toThrow("FORBIDDEN")
  })

  it("未知键拒绝（zod 枚举兜底）", async () => {
    mockSession.userId = superAdmin
    const res = await updateEnterpriseNavAction({
      enterpriseId: entId,
      isTest: false,
      navTitleOverrides: { nonexistent_key: "X" },
    })
    expect(res.ok).toBe(false)
  })

  it("超管保存：空白值剔除、显式映射与测试开关落库，详情可回读", async () => {
    mockSession.userId = superAdmin
    const res = await updateEnterpriseNavAction({
      enterpriseId: entId,
      isTest: true,
      navTitleOverrides: {
        temu: "数据港",
        chat: "  ", // 空白 → 剔除（恢复默认名）
        storeGroup: "  门店中心  ", // 前后空白 trim
      },
    })
    expect(res.ok).toBe(true)

    const detail = await getEnterpriseDetailAction(entId)
    expect(detail?.isTest).toBe(true)
    expect(detail?.navTitleOverrides).toEqual({
      temu: "数据港",
      storeGroup: "门店中心",
    })

    // 复位（防污染后续用例的库断言视角）
    const reset = await updateEnterpriseNavAction({
      enterpriseId: entId,
      isTest: false,
      navTitleOverrides: { temu: "数据港" },
    })
    expect(reset.ok).toBe(true)
    const after = await getEnterpriseDetailAction(entId)
    expect(after?.isTest).toBe(false)
    expect(after?.navTitleOverrides).toEqual({ temu: "数据港" })
  })

  it("超长值拒绝（max 20）", async () => {
    mockSession.userId = superAdmin
    const res = await updateEnterpriseNavAction({
      enterpriseId: entId,
      isTest: false,
      navTitleOverrides: { temu: "超".repeat(21) },
    })
    expect(res.ok).toBe(false)
  })
})
