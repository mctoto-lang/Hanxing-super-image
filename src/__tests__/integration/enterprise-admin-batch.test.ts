import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  users,
  generationTasks,
} from "@/db/schema"
import { verifyPassword } from "@/lib/crypto"
import {
  updateEnterpriseInfoAction,
  setEnterpriseStatusAction,
  getEnterpriseDetailAction,
  listEnterprisesAction,
  listEnterpriseMembersAction,
  listEnterpriseGroupsAction,
  listEnterpriseTransactionsAction,
} from "@/server/actions/platform"
import {
  setMemberStatusAction,
  resetMemberPasswordAction,
  updateMemberProfileAction,
} from "@/server/actions/admin-users"
import {
  listGroupMembersAction,
  moveGroupMembersAction,
  deleteGroupAction,
  listAllGroupsAction,
} from "@/server/actions/admin-groups"

/**
 * 企业管理双侧优化批次集成测试（真实本地 PG）。
 *
 * 覆盖：
 * - 成员生命周期：禁用/启用（跨企业隔离 / owner 保护 / 自我保护 / 成功翻转）、
 *   管理员重置密码（owner 保护、hash 落库校验）、昵称/邮箱编辑；
 * - 企业信息编辑：slug 撞他人拒绝 / 自身不变成功；停用语义（成员企业作用域失效）；
 * - 企业列表：状态/免费版筛选、默认排序（最新在前）、成员数/任务数统计列；
 * - 权限组：组内成员查看、整组转移（为删除组清障）、转移后删除空组。
 */

// action 鉴权链走 auth()；vitest 无法加载 next-auth，mock 成可控 session
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const runTag = randomUUID().slice(0, 8)

let entA: string // 主测试企业（active）
let entB: string // 跨企业攻击方企业
let entC: string // 已停用企业（列表筛选用，创建晚于 A 验证默认排序）
let superAdmin: string
let ownerA: string // A 企业 owner（管理员视角）
let ownerA2: string // A 企业第二名 owner（owner 保护用）
let adminA: string // A 企业 admin（admin→owner 越权防护用例）
let memberA: string // A 企业普通成员（主要操作对象）
let memberA2: string // A 企业普通成员（整组转移用）
let adminB: string // B 企业 admin（跨企业用）
let defaultGroupA: string
let customGroupA: string
let defaultGroupB: string

beforeAll(async () => {
  const [a] = await db
    .insert(enterprises)
    .values({ name: "管理批次企业A", slug: `ea-${runTag}` })
    .returning()
  entA = a!.id
  const [b] = await db
    .insert(enterprises)
    .values({ name: "管理批次企业B", slug: `eb-${runTag}` })
    .returning()
  entB = b!.id

  const [ga] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entA,
      name: "A默认组",
      isDefault: true,
      allowedPages: [],
      allowedModels: [],
    })
    .returning()
  defaultGroupA = ga!.id
  const [gc] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entA,
      name: "A自定义组",
      isDefault: false,
      allowedPages: [],
      allowedModels: [],
    })
    .returning()
  customGroupA = gc!.id
  const [gb] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entB,
      name: "B默认组",
      isDefault: true,
      allowedPages: [],
      allowedModels: [],
    })
    .returning()
  defaultGroupB = gb!.id

  const mkUser = (over: {
    username: string
    enterpriseId: string | null
    enterpriseRole?: "owner" | "admin" | "member"
    groupId?: string
    isSuperAdmin?: boolean
  }) =>
    db
      .insert(users)
      .values({
        username: over.username,
        name: over.username,
        passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        enterpriseId: over.enterpriseId,
        enterpriseRole: over.enterpriseRole ?? "member",
        groupId: over.groupId,
        isSuperAdmin: over.isSuperAdmin ?? false,
      })
      .returning()

  const [s] = await mkUser({
    username: `eab-super-${runTag}`,
    enterpriseId: null,
    isSuperAdmin: true,
  })
  superAdmin = s!.id
  const [o1] = await mkUser({
    username: `eab-owner-${runTag}`,
    enterpriseId: entA,
    enterpriseRole: "owner",
    groupId: defaultGroupA,
  })
  ownerA = o1!.id
  const [o2] = await mkUser({
    username: `eab-owner2-${runTag}`,
    enterpriseId: entA,
    enterpriseRole: "owner",
    groupId: defaultGroupA,
  })
  ownerA2 = o2!.id
  const [aa] = await mkUser({
    username: `eab-admina-${runTag}`,
    enterpriseId: entA,
    enterpriseRole: "admin",
    groupId: defaultGroupA,
  })
  adminA = aa!.id
  const [m1] = await mkUser({
    username: `eab-m1-${runTag}`,
    enterpriseId: entA,
    groupId: customGroupA,
  })
  memberA = m1!.id
  const [m2] = await mkUser({
    username: `eab-m2-${runTag}`,
    enterpriseId: entA,
    groupId: customGroupA,
  })
  memberA2 = m2!.id
  const [ab] = await mkUser({
    username: `eab-adminb-${runTag}`,
    enterpriseId: entB,
    enterpriseRole: "admin",
    groupId: defaultGroupB,
  })
  adminB = ab!.id

  // A 企业一条生图任务（taskCount 统计列用）
  await db.insert(generationTasks).values({
    enterpriseId: entA,
    userId: memberA,
    prompt: "管理批次统计用任务",
  })

  // C 企业最后创建（验证默认排序最新在前）且直接停用（状态筛选用）
  const [c] = await db
    .insert(enterprises)
    .values({ name: "管理批次企业C", slug: `ec-${runTag}`, status: "suspended" })
    .returning()
  entC = c!.id
})

afterAll(async () => {
  // users.enterpriseId 为 set null 不级联，需先删成员（级联其任务）；超管无企业需单独删
  await db.delete(users).where(eq(users.enterpriseId, entA))
  await db.delete(users).where(eq(users.enterpriseId, entB))
  await db.delete(enterprises).where(eq(enterprises.id, entA))
  await db.delete(enterprises).where(eq(enterprises.id, entB))
  await db.delete(enterprises).where(eq(enterprises.id, entC))
  await db.delete(users).where(eq(users.id, superAdmin))
})

describe("成员生命周期 setMemberStatusAction", () => {
  it("跨企业管理员操作他企成员 → 拒绝", async () => {
    mockSession.userId = adminB
    const res = await setMemberStatusAction({
      userId: memberA,
      status: "disabled",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("成员不存在")
  })

  it("操作 owner → 拒绝（owner 由超管处理）", async () => {
    mockSession.userId = ownerA
    const res = await setMemberStatusAction({
      userId: ownerA2,
      status: "disabled",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("平台超管")
  })

  it("操作自己 → 拒绝", async () => {
    mockSession.userId = ownerA
    const res = await setMemberStatusAction({
      userId: ownerA,
      status: "disabled",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("自己")
  })

  it("禁用 → 落库 → 启用恢复", async () => {
    mockSession.userId = ownerA
    const off = await setMemberStatusAction({
      userId: memberA,
      status: "disabled",
    })
    expect(off.ok).toBe(true)
    let [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.status).toBe("disabled")

    const on = await setMemberStatusAction({
      userId: memberA,
      status: "active",
    })
    expect(on.ok).toBe(true)
    ;[row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.status).toBe("active")
  })
})

describe("管理员重置成员密码 resetMemberPasswordAction", () => {
  const oldHashPrelude = "$2a$10$dummy"

  it("重置自己 → 拒绝并引导个人设置", async () => {
    mockSession.userId = ownerA
    const res = await resetMemberPasswordAction({
      userId: ownerA,
      newPassword: "new-pass-123",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("个人设置")
  })

  it("跨企业重置 → 拒绝", async () => {
    mockSession.userId = adminB
    const res = await resetMemberPasswordAction({
      userId: memberA,
      newPassword: "new-pass-123",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("成员不存在")
  })

  it("重置普通成员 → 新 hash 落库且可校验", async () => {
    mockSession.userId = ownerA
    const res = await resetMemberPasswordAction({
      userId: memberA,
      newPassword: "eab-new-pass-1",
    })
    expect(res.ok).toBe(true)

    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.passwordHash).toBeTruthy()
    expect(row!.passwordHash.startsWith(oldHashPrelude)).toBe(false)
    await expect(verifyPassword("eab-new-pass-1", row!.passwordHash)).resolves.toBe(
      true,
    )
    await expect(verifyPassword("wrong-pass", row!.passwordHash)).resolves.toBe(
      false,
    )
  })

  it("重置 owner → 拒绝（owner 密码需由平台超管重置，防 admin 接管）", async () => {
    mockSession.userId = ownerA
    const res = await resetMemberPasswordAction({
      userId: ownerA2,
      newPassword: "owner-new-pass",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("平台超管")

    // owner 密码未被改动
    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, ownerA2))
    expect(row!.passwordHash).toBe("$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
  })

  it("本企业 admin 重置 owner → 拒绝（实际风险路径：admin 冒充 owner 登录）", async () => {
    mockSession.userId = adminA
    const res = await resetMemberPasswordAction({
      userId: ownerA2,
      newPassword: "evil-pass-123",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("平台超管")

    // owner 密码未被改动
    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, ownerA2))
    expect(row!.passwordHash).toBe("$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
  })
})

describe("成员资料编辑 updateMemberProfileAction", () => {
  it("跨企业 → 拒绝；本企业成功改昵称/邮箱", async () => {
    mockSession.userId = adminB
    const cross = await updateMemberProfileAction({
      userId: memberA,
      name: "越权改名",
    })
    expect(cross.ok).toBe(false)

    mockSession.userId = ownerA
    const res = await updateMemberProfileAction({
      userId: memberA,
      name: "改后昵称",
      email: `eab-${runTag}@test.local`,
    })
    expect(res.ok).toBe(true)
    const [row] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.name).toBe("改后昵称")
    expect(row!.email).toBe(`eab-${runTag}@test.local`)
  })

  it("清空/空白昵称 → 落 null（触发 ?? username 展示回退）；带空格昵称 → trim 落库", async () => {
    mockSession.userId = ownerA

    const blank = await updateMemberProfileAction({ userId: memberA, name: "   " })
    expect(blank.ok).toBe(true)
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.name).toBeNull()

    const padded = await updateMemberProfileAction({
      userId: memberA,
      name: "  带空格昵称  ",
    })
    expect(padded.ok).toBe(true)
    const [row2] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row2!.name).toBe("带空格昵称")
  })

  it("非法邮箱 → zod 拒绝", async () => {
    mockSession.userId = ownerA
    const res = await updateMemberProfileAction({
      userId: memberA,
      email: "not-an-email",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("邮箱")
  })
})

describe("企业信息与生命周期（超管）", () => {
  it("非超管调用 → FORBIDDEN 抛错", async () => {
    mockSession.userId = ownerA
    await expect(
      updateEnterpriseInfoAction({ enterpriseId: entA, name: "越权改名" }),
    ).rejects.toThrow(/FORBIDDEN/)
  })

  it("slug 撞其他企业 → 拒绝；自身 slug 不变 → 成功", async () => {
    mockSession.userId = superAdmin
    const [bRow] = await db
      .select({ slug: enterprises.slug })
      .from(enterprises)
      .where(eq(enterprises.id, entB))
    const clash = await updateEnterpriseInfoAction({
      enterpriseId: entA,
      slug: bRow!.slug,
    })
    expect(clash.ok).toBe(false)
    expect(clash.error).toContain("slug 已被其他企业使用")

    const okRes = await updateEnterpriseInfoAction({
      enterpriseId: entA,
      name: "管理批次企业A-改名",
      slug: `ea-${runTag}`, // 与自身相同，不应触发唯一性冲突
      logoUrl: "/uploads/test-logo.png",
    })
    expect(okRes.ok).toBe(true)
    const [row] = await db
      .select({
        name: enterprises.name,
        slug: enterprises.slug,
        logoUrl: enterprises.logoUrl,
      })
      .from(enterprises)
      .where(eq(enterprises.id, entA))
    expect(row!.name).toBe("管理批次企业A-改名")
    expect(row!.logoUrl).toBe("/uploads/test-logo.png")
  })

  it("停用后成员企业作用域失效 → 启用恢复", async () => {
    mockSession.userId = superAdmin
    const off = await setEnterpriseStatusAction({
      enterpriseId: entA,
      status: "suspended",
    })
    expect(off.ok).toBe(true)

    // 停用语义：成员可登录但企业作用域视为无（session 既有逻辑）
    const { requireEnterpriseContext } = await import("@/lib/auth/session")
    mockSession.userId = memberA
    await expect(requireEnterpriseContext()).rejects.toThrow(/FORBIDDEN/)

    mockSession.userId = superAdmin
    const on = await setEnterpriseStatusAction({
      enterpriseId: entA,
      status: "active",
    })
    expect(on.ok).toBe(true)
    mockSession.userId = memberA
    const ctx = await requireEnterpriseContext()
    expect(ctx.enterprise?.id).toBe(entA)
  })

  it("企业详情：成员数/任务数统计正确", async () => {
    mockSession.userId = superAdmin
    const detail = await getEnterpriseDetailAction(entA)
    expect(detail).not.toBeNull()
    expect(detail!.memberCount).toBe(5) // ownerA + ownerA2 + adminA + memberA + memberA2
    expect(detail!.taskCount).toBe(1)
  })

  it("企业列表：筛选 / 排序 / 统计列", async () => {
    mockSession.userId = superAdmin
    // 状态筛选：suspended + 本批次前缀 → 只有 C
    const suspendedList = await listEnterprisesAction({
      status: "suspended",
      q: runTag,
    })
    expect(
      suspendedList.items.map((e) => e.id).filter((id) => id === entC),
    ).toEqual([entC])

    // 免费版筛选（无订阅行）：A/B/C 均未分配套餐 → 三家全中
    const freeList = await listEnterprisesAction({
      planId: "none",
      q: runTag,
    })
    expect(freeList.items.length).toBe(3)

    // 默认排序：最新创建在前（C 晚于 A/B 创建）
    expect(freeList.items[0]!.id).toBe(entC)
    // 统计列：A 行成员数=5、任务数=1
    const rowA = freeList.items.find((e) => e.id === entA)
    expect(rowA?.memberCount).toBe(5)
    expect(rowA?.taskCount).toBe(1)

    // 最早创建在前
    const ascList = await listEnterprisesAction({
      sort: "createdAt_asc",
      q: runTag,
    })
    expect(ascList.items.map((e) => e.id)).toEqual([entA, entB, entC])
  })

  it("超管按企业列成员 / 列权限组 / 查流水", async () => {
    mockSession.userId = superAdmin
    const members = await listEnterpriseMembersAction({
      enterpriseId: entA,
      q: `eab-m1-${runTag}`,
    })
    expect(members.total).toBe(1)
    expect(members.items[0]!.username).toBe(`eab-m1-${runTag}`)

    const groups = await listEnterpriseGroupsAction(entA)
    expect(groups.items.length).toBe(2)
    expect(groups.items[0]!.isDefault).toBe(true) // 默认组排前

    const txs = await listEnterpriseTransactionsAction({ enterpriseId: entA })
    expect(Array.isArray(txs.items)).toBe(true)
  })
})

describe("权限组成员查看 / 整组转移 / 删除空组", () => {
  it("跨企业查看他企组 → 拒绝", async () => {
    mockSession.userId = adminB
    const res = await listGroupMembersAction(customGroupA)
    expect(res.ok).toBe(false)
    expect(res.error).toBe("权限组不存在")
  })

  it("查看组内成员：自定义组 2 人", async () => {
    mockSession.userId = ownerA
    const res = await listGroupMembersAction(customGroupA)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.members.length).toBe(2)
  })

  it("同组转移 → zod 拒绝", async () => {
    mockSession.userId = ownerA
    const res = await moveGroupMembersAction({
      fromGroupId: customGroupA,
      toGroupId: customGroupA,
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("不能与当前组相同")
  })

  it("跨企业转移（目标组属他企）→ 拒绝", async () => {
    mockSession.userId = adminB
    const res = await moveGroupMembersAction({
      fromGroupId: customGroupA, // A 企业的组
      toGroupId: defaultGroupB, // B 企业的组
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe("权限组不存在")
  })

  it("整组转移到默认组 → 成员 groupId 批量更新", async () => {
    mockSession.userId = ownerA
    const res = await moveGroupMembersAction({
      fromGroupId: customGroupA,
      toGroupId: defaultGroupA,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.moved).toBe(2)

    const rows = await db
      .select({ id: users.id, groupId: users.groupId })
      .from(users)
      .where(eq(users.groupId, defaultGroupA))
    const ids = new Set(rows.map((r) => r.id))
    expect(ids.has(memberA)).toBe(true)
    expect(ids.has(memberA2)).toBe(true)
  })

  it("空组可删除（接线既有 deleteGroupAction）", async () => {
    mockSession.userId = ownerA
    const del = await deleteGroupAction(customGroupA)
    expect(del.ok).toBe(true)
  })
})

describe("全量组下拉 listAllGroupsAction（单页上限 50 不截断）", () => {
  it("组数超过 50 → 按 total 翻页聚合，第 51+ 组也在结果中", async () => {
    mockSession.userId = ownerA
    const before = await listAllGroupsAction()

    // 批量插入 55 个组（同批次插入 createdAt 相同，考验排序稳定性）
    const rows = await db
      .insert(permissionGroups)
      .values(
        Array.from({ length: 55 }, (_, i) => ({
          enterpriseId: entA,
          name: `eab-批量组-${runTag}-${i + 1}`,
          isDefault: false,
          allowedPages: [],
          allowedModels: [],
        })),
      )
      .returning()

    try {
      const after = await listAllGroupsAction()
      expect(after.length).toBe(before.length + 55)
      const ids = new Set(after.map((g) => g.id))
      // 首页（前 50）之外的组也必须出现在下拉数据源里
      for (const r of rows) {
        expect(ids.has(r.id)).toBe(true)
      }
    } finally {
      await db.delete(permissionGroups).where(
        inArray(
          permissionGroups.id,
          rows.map((r) => r.id),
        ),
      )
    }
  })
})
