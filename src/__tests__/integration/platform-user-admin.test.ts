import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq, ilike, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  users,
  generationTasks,
  loginLogs,
} from "@/db/schema"
import { verifyPassword } from "@/lib/crypto"
import {
  updatePlatformUserAction,
  setPlatformUserStatusAction,
  resetPlatformUserPasswordAction,
  listAllUsersAction,
  listEnterpriseOptionsAction,
  getPlatformStatsAction,
} from "@/server/actions/platform"
import {
  listAllTaskLogsAction,
  listAllLoginLogsAction,
} from "@/server/actions/platform-logs"
import { aiAssistOutfitAction } from "@/server/actions/weartry"
import { getCurrentUserContext } from "@/lib/auth/session"

/**
 * 超管平台批次集成测试（真实本地 PG）。
 *
 * 覆盖：
 * - 平台用户编辑：自我保护、username 撞名、超管提升联动（清企业/组/角色）、
 *   非超管必须归属企业、跨企业转移权限组回落目标企业默认组、
 *   最后一个可用 owner 兜底（降角色/转移/停用均拒绝）；
 * - 停用/启用：自我保护、owner 兜底、正常翻转落库；
 * - 重置密码：自我保护、owner 放行（忘密码唯一兜底）、hash 落库；
 * - 列表筛选：类型/状态/归属企业；
 * - 看板增强：range 窗口（7/30）、昨日环比字段；
 * - 全平台日志：跨企业行 + 归属企业列、非超管拒绝；
 * - AI 帮写参考图归属校验（他企业 URL 拒绝）；
 * - 权限组归属防御（组属他企业按无组处理）。
 */

// action 鉴权链走 auth()；vitest 无法加载 next-auth，mock 成可控 session
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const runTag = randomUUID().slice(0, 8)

let entA: string
let entB: string
let superAdmin: string
let ownerA: string // A 企业唯一 owner（owner 兜底用例的操作对象）
let ownerA2: string // 补位 owner（解除兜底后允许操作）
let memberA: string // A 企业普通成员（主要操作对象）
let defaultGroupA: string
let defaultGroupB: string
let customGroupA: string
let foreignUser: string // B 企业成员（AI 帮写参考图校验视角）
let foreignGroup: string // B 企业组（归属防御用例，挂在 A 企业用户身上）

beforeAll(async () => {
  const [a] = await db
    .insert(enterprises)
    .values({
      name: "平台批次企业A",
      slug: `pa-${runTag}`,
      enabledModules: ["create", "assets", "weartry", "settings"],
    })
    .returning()
  entA = a!.id
  const [b] = await db
    .insert(enterprises)
    .values({
      name: "平台批次企业B",
      slug: `pb-${runTag}`,
      enabledModules: ["create", "assets", "settings"],
    })
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
  const [gf] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entB,
      name: "B外来组",
      isDefault: false,
      allowedPages: [],
      allowedModels: [],
    })
    .returning()
  foreignGroup = gf!.id

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
    username: `pb-super-${runTag}`,
    enterpriseId: null,
    isSuperAdmin: true,
  })
  superAdmin = s!.id
  const [o1] = await mkUser({
    username: `pb-owner-${runTag}`,
    enterpriseId: entA,
    enterpriseRole: "owner",
    groupId: defaultGroupA,
  })
  ownerA = o1!.id
  const [m1] = await mkUser({
    username: `pb-m1-${runTag}`,
    enterpriseId: entA,
    groupId: customGroupA,
  })
  memberA = m1!.id
  const [fb] = await mkUser({
    username: `pb-fb-${runTag}`,
    enterpriseId: entB,
    groupId: defaultGroupB,
  })
  foreignUser = fb!.id

  // 看板环比/窗口用任务：昨日 + 20 天前（range 窗口区分）
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(12, 0, 0, 0)
  const old = new Date()
  old.setDate(old.getDate() - 20)
  await db.insert(generationTasks).values([
    { enterpriseId: entA, userId: memberA, prompt: `平台批次-今日-${runTag}`, createdAt: new Date() },
    { enterpriseId: entA, userId: memberA, prompt: `平台批次-昨日-${runTag}`, createdAt: yesterday },
    { enterpriseId: entA, userId: memberA, prompt: `平台批次-20天前-${runTag}`, createdAt: old },
  ])

  // 全平台登录日志（跨企业两行）
  await db.insert(loginLogs).values([
    {
      userId: memberA,
      username: `pb-m1-${runTag}`,
      enterpriseId: entA,
      ip: "1.1.1.1",
      userAgent: "vitest",
      success: true,
    },
    {
      userId: foreignUser,
      username: `pb-fb-${runTag}`,
      enterpriseId: entB,
      ip: "2.2.2.2",
      userAgent: "vitest",
      success: false,
      failureReason: "credentials",
    },
  ])
})

afterAll(async () => {
  // users.enterpriseId 为 set null 不级联，需先删成员（含测试中途插入的 ownerA2）；
  // login_log 的 FK 亦为 set null，夹具行需按用户名显式清；超管无企业需单独删
  await db.delete(loginLogs).where(
    inArray(loginLogs.username, [`pb-m1-${runTag}`, `pb-fb-${runTag}`]),
  )
  await db.delete(users).where(eq(users.enterpriseId, entA))
  await db.delete(users).where(eq(users.enterpriseId, entB))
  await db.delete(enterprises).where(eq(enterprises.id, entA))
  await db.delete(enterprises).where(eq(enterprises.id, entB))
  await db.delete(users).where(eq(users.id, superAdmin))
})

describe("updatePlatformUserAction 编辑平台用户", () => {
  it("编辑当前登录账号 → 拒绝", async () => {
    mockSession.userId = superAdmin
    const res = await updatePlatformUserAction({
      userId: superAdmin,
      username: `pb-super-${runTag}`,
      isSuperAdmin: true,
      enterpriseId: "",
      enterpriseRole: "member",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("当前登录账号")
  })

  it("username 撞他人 → 拒绝；仅改昵称 → 成功", async () => {
    mockSession.userId = superAdmin
    const dup = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-fb-${runTag}`,
      name: "新昵称",
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "member",
    })
    expect(dup.ok).toBe(false)
    expect(dup.error).toBe("用户名已存在")

    const ok = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-m1-${runTag}`,
      name: "平台批次新昵称",
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "member",
    })
    expect(ok.ok).toBe(true)
    const [row] = await db
      .select({ name: users.name, enterpriseId: users.enterpriseId })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.name).toBe("平台批次新昵称")
    expect(row!.enterpriseId).toBe(entA)
  })

  it("提升为超管 → 清空企业/权限组、角色回落 member", async () => {
    mockSession.userId = superAdmin
    const res = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-m1-${runTag}`,
      isSuperAdmin: true,
      enterpriseId: "",
      enterpriseRole: "admin",
    })
    expect(res.ok).toBe(true)
    const [row] = await db
      .select({
        isSuperAdmin: users.isSuperAdmin,
        enterpriseId: users.enterpriseId,
        groupId: users.groupId,
        enterpriseRole: users.enterpriseRole,
      })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.isSuperAdmin).toBe(true)
    expect(row!.enterpriseId).toBeNull()
    expect(row!.groupId).toBeNull()
    expect(row!.enterpriseRole).toBe("member")

    // 还原为企业用户（后续用例）
    const back = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-m1-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "member",
    })
    expect(back.ok).toBe(true)
  })

  it("降为普通用户但不选企业 → 拒绝（企业用户必须归属企业）", async () => {
    mockSession.userId = superAdmin
    const res = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-m1-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: "",
      enterpriseRole: "member",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("归属企业")
  })

  it("跨企业转移 → 权限组回落目标企业默认组", async () => {
    mockSession.userId = superAdmin
    const res = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-m1-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entB,
      enterpriseRole: "member",
    })
    expect(res.ok).toBe(true)
    const [row] = await db
      .select({ enterpriseId: users.enterpriseId, groupId: users.groupId })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.enterpriseId).toBe(entB)
    expect(row!.groupId).toBe(defaultGroupB)

    // 转回 A（后续用例）
    const back = await updatePlatformUserAction({
      userId: memberA,
      username: `pb-m1-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "member",
    })
    expect(back.ok).toBe(true)
  })

  it("降级唯一 owner / 转移唯一 owner / 停用唯一 owner → 均拒绝", async () => {
    mockSession.userId = superAdmin

    const demote = await updatePlatformUserAction({
      userId: ownerA,
      username: `pb-owner-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "member",
    })
    expect(demote.ok).toBe(false)
    expect(demote.error).toContain("owner")

    const move = await updatePlatformUserAction({
      userId: ownerA,
      username: `pb-owner-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entB,
      enterpriseRole: "owner",
    })
    expect(move.ok).toBe(false)
    expect(move.error).toContain("owner")

    const disable = await setPlatformUserStatusAction({
      userId: ownerA,
      status: "disabled",
    })
    expect(disable.ok).toBe(false)
    expect(disable.error).toContain("owner")
  })

  it("补位第二个 owner 后 → 降级原 owner 成功", async () => {
    mockSession.userId = superAdmin
    const [o2] = await db
      .insert(users)
      .values({
        username: `pb-owner2-${runTag}`,
        name: `pb-owner2-${runTag}`,
        passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        enterpriseId: entA,
        enterpriseRole: "owner",
        groupId: defaultGroupA,
      })
      .returning()
    ownerA2 = o2!.id

    const res = await updatePlatformUserAction({
      userId: ownerA,
      username: `pb-owner-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "admin",
    })
    expect(res.ok).toBe(true)
    const [row] = await db
      .select({ enterpriseRole: users.enterpriseRole })
      .from(users)
      .where(eq(users.id, ownerA))
    expect(row!.enterpriseRole).toBe("admin")

    // 还原 owner（后续停用用例）
    const back = await updatePlatformUserAction({
      userId: ownerA,
      username: `pb-owner-${runTag}`,
      isSuperAdmin: false,
      enterpriseId: entA,
      enterpriseRole: "owner",
    })
    expect(back.ok).toBe(true)
  })

  it("非超管调用 → 抛 FORBIDDEN", async () => {
    mockSession.userId = foreignUser
    await expect(
      updatePlatformUserAction({
        userId: memberA,
        username: `pb-m1-${runTag}`,
        isSuperAdmin: false,
        enterpriseId: entA,
        enterpriseRole: "member",
      }),
    ).rejects.toThrow("需要平台超管权限")
  })
})

describe("setPlatformUserStatusAction 停用/启用", () => {
  it("操作自己 → 拒绝", async () => {
    mockSession.userId = superAdmin
    const res = await setPlatformUserStatusAction({
      userId: superAdmin,
      status: "disabled",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("当前登录账号")
  })

  it("停用普通成员 → 落库 → 启用恢复", async () => {
    mockSession.userId = superAdmin
    const off = await setPlatformUserStatusAction({
      userId: memberA,
      status: "disabled",
    })
    expect(off.ok).toBe(true)
    let [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, memberA))
    expect(row!.status).toBe("disabled")

    const on = await setPlatformUserStatusAction({
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

describe("resetPlatformUserPasswordAction 重置密码", () => {
  it("重置自己 → 拒绝", async () => {
    mockSession.userId = superAdmin
    const res = await resetPlatformUserPasswordAction({
      userId: superAdmin,
      newPassword: "NewPass-123456",
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("个人设置")
  })

  it("重置 owner → 成功且 hash 落库（owner 忘密码唯一兜底）", async () => {
    mockSession.userId = superAdmin
    const res = await resetPlatformUserPasswordAction({
      userId: ownerA2,
      newPassword: "OwnerNew-123456",
    })
    expect(res.ok).toBe(true)
    // 会话口径提示（维持现状：重置不吊销已登录会话，强制下线走停用再启用）
    const hint = res.ok ? res.hint : null
    expect(hint).toContain("停用再启用")
    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, ownerA2))
    expect(await verifyPassword("OwnerNew-123456", row!.passwordHash)).toBe(true)
  })
})

describe("owner 兜底并发安全（检查与更新同事务）", () => {
  // 两名超管并发处理同一企业仅剩的两个 owner（一降角色、一停用）：
  // 事务 + owner 行锁串行化后，后到者必须被拒，企业始终保留至少一名
  // 可用 owner（修复前两个 check-then-act 都放行，企业会失去全部 owner）。
  // 竞态有天然串行的小概率漏检，多跑几轮放大检出率
  it("并发降角色 + 停用最后两个 owner → 恰好一个成功，企业仍有可用 owner", async () => {
    mockSession.userId = superAdmin
    for (let round = 0; round < 5; round++) {
      const [ent] = await db
        .insert(enterprises)
        .values({
          name: `平台批次企业C${round}`,
          slug: `pc${round}-${runTag}`,
          enabledModules: ["settings"],
        })
        .returning()
      const mkOwner = (username: string) =>
        db
          .insert(users)
          .values({
            username,
            name: username,
            passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            enterpriseId: ent!.id,
            enterpriseRole: "owner",
          })
          .returning()
      const [o1] = await mkOwner(`pc-o1${round}-${runTag}`)
      const [o2] = await mkOwner(`pc-o2${round}-${runTag}`)

      const [demote, disable] = await Promise.all([
        updatePlatformUserAction({
          userId: o1!.id,
          username: `pc-o1${round}-${runTag}`,
          isSuperAdmin: false,
          enterpriseId: ent!.id,
          enterpriseRole: "member",
        }),
        setPlatformUserStatusAction({ userId: o2!.id, status: "disabled" }),
      ])
      const okCount = [demote, disable].filter((r) => r.ok).length
      expect(okCount, `第 ${round} 轮：应恰好一个操作成功`).toBe(1)

      const owners = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.enterpriseId, ent!.id),
            eq(users.enterpriseRole, "owner"),
            eq(users.status, "active"),
          ),
        )
      expect(owners, `第 ${round} 轮：企业仍应有可用 owner`).toHaveLength(1)

      await db.delete(users).where(inArray(users.id, [o1!.id, o2!.id]))
      await db.delete(enterprises).where(eq(enterprises.id, ent!.id))
    }
  })
})

describe("listAllUsersAction 列表筛选", () => {
  it("类型/状态/企业筛选生效", async () => {
    mockSession.userId = superAdmin
    const superOnly = await listAllUsersAction({
      type: "superadmin",
      q: `pb-super-${runTag}`,
    })
    expect(superOnly.total).toBe(1)
    expect(superOnly.items[0]!.isSuperAdmin).toBe(true)

    await setPlatformUserStatusAction({ userId: memberA, status: "disabled" })
    const disabledOnly = await listAllUsersAction({
      status: "disabled",
      q: `pb-m1-${runTag}`,
    })
    expect(disabledOnly.total).toBe(1)
    expect(disabledOnly.items[0]!.status).toBe("disabled")
    await setPlatformUserStatusAction({ userId: memberA, status: "active" })

    const entBOnly = await listAllUsersAction({
      enterpriseId: entB,
      q: `pb-fb-${runTag}`,
    })
    expect(entBOnly.total).toBe(1)
    expect(entBOnly.items[0]!.enterpriseName).toBe("平台批次企业B")
  })
})

describe("getPlatformStatsAction 看板增强", () => {
  it("昨日环比字段 + range 窗口（7 天排除 20 天前任务）", async () => {
    mockSession.userId = superAdmin
    const s7 = await getPlatformStatsAction(7)
    expect(s7.yesterdayTasks).toBeGreaterThanOrEqual(1)
    expect(s7.dailyTrend.length).toBeLessThanOrEqual(7)
    // 20 天前的任务不应出现在 7 天窗口
    expect(
      s7.dailyTrend.every((t) => t.day !== old20DayKey()),
    ).toBe(true)

    const s30 = await getPlatformStatsAction()
    // 默认 30 天窗口包含 20 天前任务（存在该日聚合）
    expect(s30.dailyTrend.some((t) => t.day === old20DayKey())).toBe(true)

    // 非法 range 回落 30
    const sBad = await getPlatformStatsAction(45)
    expect(sBad.dailyTrend.some((t) => t.day === old20DayKey())).toBe(true)

    // 增强字段形状
    expect(typeof s30.todayActiveUsers).toBe("number")
    expect(Array.isArray(s30.hourlyDistribution)).toBe(true)
    expect(s30.hourlyDistribution.length).toBe(24)
    expect(Array.isArray(s30.creditsTrend)).toBe(true)
    expect(Array.isArray(s30.userGrowthTrend)).toBe(true)
    expect(Array.isArray(s30.enterpriseGrowthTrend)).toBe(true)
  })
})

describe("全平台日志（platform-logs）", () => {
  it("任务日志跨企业可见且带归属企业名", async () => {
    mockSession.userId = superAdmin
    // q 按 username/name 过滤（夹具用户名全局唯一，dev 库其余任务不干扰）
    const { tasks, total } = await listAllTaskLogsAction({
      q: `pb-m1-${runTag}`,
      pageSize: 50,
    })
    expect(total).toBe(3)
    expect(
      tasks.every((t) => t.enterpriseName === "平台批次企业A"),
    ).toBe(true)
    expect(tasks.some((t) => t.prompt.includes(`平台批次-20天前-${runTag}`))).toBe(true)
  })

  it("登录日志跨企业可见且带归属企业名", async () => {
    mockSession.userId = superAdmin
    const { logs, total } = await listAllLoginLogsAction({ pageSize: 50 })
    expect(total).toBeGreaterThanOrEqual(2)
    const mine = logs.filter(
      (l) => l.username === `pb-m1-${runTag}` || l.username === `pb-fb-${runTag}`,
    )
    expect(mine.length).toBe(2)
    const entNames = new Set(mine.map((l) => l.enterpriseName))
    expect(entNames.has("平台批次企业A")).toBe(true)
    expect(entNames.has("平台批次企业B")).toBe(true)
  })

  it("非超管调用 → 抛 FORBIDDEN", async () => {
    mockSession.userId = foreignUser
    await expect(listAllLoginLogsAction()).rejects.toThrow(
      "需要平台超管权限",
    )
  })
})

describe("AI 帮写参考图归属校验（weartry）", () => {
  it("他企业图片 URL（平台存储 host）→ 拒绝，不触发 AI 调用", async () => {
    const { env } = await import("@/lib/env")
    mockSession.userId = memberA
    const res = await aiAssistOutfitAction({
      referenceImages: [
        `${env.NEXT_PUBLIC_APP_URL}/uploads/${entB}/image/2026/11/x.png`,
      ],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("参考图")
  })
})

describe("权限组归属防御（组属他企业按无组处理）", () => {
  it("A 企业用户挂 B 企业组 → ctx.group 为 null", async () => {
    await db
      .update(users)
      .set({ groupId: foreignGroup })
      .where(eq(users.id, memberA))
    mockSession.userId = memberA
    const ctx = await getCurrentUserContext()
    expect(ctx).not.toBeNull()
    expect(ctx!.group).toBeNull()

    // 还原
    await db
      .update(users)
      .set({ groupId: defaultGroupA })
      .where(eq(users.id, memberA))
  })
})

describe("listEnterpriseOptionsAction 企业下拉选项", () => {
  it("企业超 50 家不截断（建/编辑用户与筛选条下拉数据源）", async () => {
    mockSession.userId = superAdmin
    // 插入 51 家企业，超过 listEnterprisesAction 的 pageSize 50 钳制
    const slugPrefix = `peo-${runTag}-`
    const names = Array.from(
      { length: 51 },
      (_, i) => `平台选项企业${runTag}${String(i).padStart(2, "0")}`,
    )
    await db
      .insert(enterprises)
      .values(names.map((name, i) => ({ name, slug: `${slugPrefix}${i}` })))

    try {
      const { items } = await listEnterpriseOptionsAction()
      const nameSet = new Set(items.map((e) => e.name))
      // 51 家全部在选项中（旧 listEnterprisesAction({ pageSize: 50 }) 只能取到最新 50 家）
      for (const name of names) {
        expect(nameSet.has(name)).toBe(true)
      }
      // 轻量选项仅 id/name 两个字段
      expect(items.length).toBeGreaterThan(0)
      expect(Object.keys(items[0]!).sort()).toEqual(["id", "name"])
    } finally {
      await db.delete(enterprises).where(ilike(enterprises.slug, `${slugPrefix}%`))
    }
  })

  it("非超管调用 → 抛 FORBIDDEN", async () => {
    mockSession.userId = foreignUser
    await expect(listEnterpriseOptionsAction()).rejects.toThrow(
      "需要平台超管权限",
    )
  })
})

/** 20 天前的 day key（与夹具 old 任务对齐） */
function old20DayKey(): string {
  const d = new Date()
  d.setDate(d.getDate() - 20)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}
