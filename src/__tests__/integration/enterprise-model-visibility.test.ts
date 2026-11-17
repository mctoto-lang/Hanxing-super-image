import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import {
  chatApiConfigs,
  enterprises,
  models,
  permissionGroups,
  promptTemplates,
  systemSettings,
  users,
} from "@/db/schema"
import { encrypt } from "@/lib/crypto"
import { listAdminChatModelsAction } from "@/server/actions/admin-chat-models"
import {
  createGroupAction,
  updateGroupAction,
} from "@/server/actions/admin-groups"
import { listChatApisAction } from "@/server/actions/workspace/templates"
import { listChatApiConfigsAction } from "@/server/actions/workspace/misc"
import { resolveProductChatConfig } from "@/server/services/product-ai-config"
import { getExecutableTemplate } from "@/server/services/workspace-ai"

/**
 * 企业级模型/模块可见性收紧批次集成测试（真实本地 PG）。
 *
 * 覆盖：
 * - listAdminChatModelsAction：平台预置按 visiblePresetChatModels 白名单过滤
 *   （空 = 全部可见）、企业私有恒保留、统计从过滤后集合派生；
 * - createGroupAction/updateGroupAction：三白名单按企业开通范围静默裁剪，
 *   部分越权裁掉越权项正常保存；所选全部越权（裁后全空）时保存失败返回
 *   明确错误（空数组语义是「放行全部」，绝不可静默放宽）；
 * - listChatApisAction（/templates 下拉）：企业白名单 + 权限组白名单双重过滤；
 * - listChatApiConfigsAction（遗留 action）：isActive + 企业白名单；
 * - resolveProductChatConfig：全链严格白名单（超管指定模型也须在白名单内）；
 * - getExecutableTemplate：关联模型被企业关闭 → 拒绝执行。
 */

// action 鉴权链走 auth()；vitest 无法加载 next-auth，mock 成可控 session
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const runTag = randomUUID().slice(0, 8)
const PRODUCT_AI_SETTING_KEY = "product_ai_chat_model"

let ent: string // 主测试企业
let entOther: string // 无关企业（跨企业隔离断言用）
let owner: string // ent 企业 owner
let member: string // ent 企业普通成员（workspace 模块）
let groupMember: string // member 所在权限组（allowedPages=[]，allowedChatModels 可变）

// 对话模型（chat_api_config）
let presetChatA: string // 平台预置（白名单内）
let presetChatB: string // 平台预置（白名单外 = 对企业关闭）
let presetChatInactive: string // 平台预置（停用）
let privateChat: string // ent 企业私有
// 生图模型（model）
let presetImgA: string // 平台预置（白名单内）
let presetImgB: string // 平台预置（白名单外）
// 模板
let tplLinkedB: string // 关联 presetChatB 的提示词模板

let savedSettingRows: (typeof systemSettings.$inferSelect)[] = []

beforeAll(async () => {
  const apiKey = encrypt(`sk-visibility-${runTag}`)
  const [e] = await db
    .insert(enterprises)
    .values({
      name: "可见性收紧企业",
      slug: `vis-${runTag}`,
      enabledModules: ["create", "chat", "workspace", "settings"],
      visiblePresetModels: [], // 生图白名单先空，组裁剪用例内再写
      visiblePresetChatModels: [/* 占位：插入 presetChatA 后回填 */],
    })
    .returning()
  ent = e!.id
  const [eo] = await db
    .insert(enterprises)
    .values({ name: "可见性无关企业", slug: `viso-${runTag}` })
    .returning()
  entOther = eo!.id

  // 对话模型：sortOrder 负数排最前，保证与 dev 现存平台预置行可区分断言。
  // 私有行用 claude 格式：resolveProductChatConfig 回退链只认 openai 行，
  // 避免私有行抢在平台预置分支前返回（该链路用私有=openai 另行不测）。
  const mkChat = (over: {
    name: string
    enterpriseId: string | null
    sortOrder: number
    isActive?: boolean
    formatType?: string
  }) =>
    db
      .insert(chatApiConfigs)
      .values({
        enterpriseId: over.enterpriseId,
        name: over.name,
        displayName: over.name,
        apiEndpoint: `https://vis-${runTag}-${over.name}.example.com/v1`,
        apiKeyEncrypted: apiKey,
        formatType: over.formatType ?? "openai",
        sortOrder: over.sortOrder,
        isActive: over.isActive ?? true,
      })
      .returning()
  const [ca] = await mkChat({ name: `vis-chat-a-${runTag}`, enterpriseId: null, sortOrder: -5001 })
  presetChatA = ca!.id
  const [cb] = await mkChat({ name: `vis-chat-b-${runTag}`, enterpriseId: null, sortOrder: -5002 })
  presetChatB = cb!.id
  const [ci] = await mkChat({
    name: `vis-chat-off-${runTag}`,
    enterpriseId: null,
    sortOrder: -5003,
    isActive: false,
  })
  presetChatInactive = ci!.id
  const [cp] = await mkChat({
    name: `vis-chat-priv-${runTag}`,
    enterpriseId: ent,
    sortOrder: -5004,
    formatType: "claude",
  })
  privateChat = cp!.id

  // 生图模型
  const mkImg = (name: string) =>
    db
      .insert(models)
      .values({
        name,
        displayName: name,
        apiEndpoint: `https://vis-${runTag}-${name}.example.com/v1`,
        apiKeyEncrypted: apiKey,
        apiFormat: "openai",
        sortOrder: -5000,
      })
      .returning()
  const [ma] = await mkImg(`vis-img-a-${runTag}`)
  presetImgA = ma!.id
  const [mb] = await mkImg(`vis-img-b-${runTag}`)
  presetImgB = mb!.id

  // 企业白名单：对话只开 A，生图只开 A
  await db
    .update(enterprises)
    .set({
      visiblePresetChatModels: [presetChatA],
      visiblePresetModels: [presetImgA],
    })
    .where(eq(enterprises.id, ent))

  // 权限组 + 用户
  const [g] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: ent,
      name: "可见性测试组",
      isDefault: false,
      allowedPages: [],
      allowedModels: [],
      allowedChatModels: [],
    })
    .returning()
  groupMember = g!.id

  const mkUser = (over: {
    username: string
    enterpriseRole?: "owner" | "admin" | "member"
  }) =>
    db
      .insert(users)
      .values({
        username: over.username,
        name: over.username,
        passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        enterpriseId: ent,
        enterpriseRole: over.enterpriseRole ?? "member",
        groupId: groupMember,
      })
      .returning()
  const [o] = await mkUser({ username: `vis-owner-${runTag}`, enterpriseRole: "owner" })
  owner = o!.id
  const [m] = await mkUser({ username: `vis-member-${runTag}` })
  member = m!.id

  // 模板：关联被关闭的 presetChatB
  const [t] = await db
    .insert(promptTemplates)
    .values({
      enterpriseId: ent,
      type: "fission",
      name: `vis-tpl-${runTag}`,
      content: "拆分 {{prompt}}",
      chatApiId: presetChatB,
      ownerId: member,
      visibility: "public",
      status: "active",
    })
    .returning()
  tplLinkedB = t!.id

  // 暂存并清空商品 AI 指定模型设置（避免 dev 现存行干扰回退链断言），afterAll 恢复
  savedSettingRows = await db
    .select()
    .from(systemSettings)
    .where(
      and(
        eq(systemSettings.key, PRODUCT_AI_SETTING_KEY),
        isNull(systemSettings.enterpriseId),
      ),
    )
  await db
    .delete(systemSettings)
    .where(
      and(
        eq(systemSettings.key, PRODUCT_AI_SETTING_KEY),
        isNull(systemSettings.enterpriseId),
      ),
    )
})

afterAll(async () => {
  await db.delete(promptTemplates).where(eq(promptTemplates.id, tplLinkedB))
  // 测试期可能写入的指定模型设置行先清再还原暂存行
  await db
    .delete(systemSettings)
    .where(
      and(
        eq(systemSettings.key, PRODUCT_AI_SETTING_KEY),
        isNull(systemSettings.enterpriseId),
      ),
    )
  if (savedSettingRows.length > 0) {
    await db.insert(systemSettings).values(savedSettingRows)
  }
  await db.delete(users).where(eq(users.enterpriseId, ent))
  await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, privateChat))
  await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, presetChatA))
  await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, presetChatB))
  await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, presetChatInactive))
  await db.delete(models).where(eq(models.id, presetImgA))
  await db.delete(models).where(eq(models.id, presetImgB))
  await db.delete(enterprises).where(eq(enterprises.id, ent))
  await db.delete(enterprises).where(eq(enterprises.id, entOther))
})

describe("listAdminChatModelsAction（企业管理页对话模型白名单）", () => {
  it("白名单非空：仅白名单内平台预置 + 本企业私有，统计一致", async () => {
    mockSession.userId = owner
    const res = await listAdminChatModelsAction({ page: 1, pageSize: 50 })
    const ids = res.items.map((m) => m.id)
    expect(ids).toContain(presetChatA)
    expect(ids).toContain(privateChat)
    expect(ids).not.toContain(presetChatB)
    expect(ids).not.toContain(presetChatInactive) // 停用行在库但白名单外，不出现
    // 统计从过滤后集合派生
    expect(res.presetCount).toBe(res.items.filter((m) => m.enterpriseId === null).length)
    expect(res.privateCount).toBe(res.items.filter((m) => m.enterpriseId !== null).length)
    expect(res.total).toBe(res.items.length)
  })

  it("白名单置空：平台预置全部可见（含 dev 现存行）", async () => {
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [] })
      .where(eq(enterprises.id, ent))
    mockSession.userId = owner
    try {
      const res = await listAdminChatModelsAction({ page: 1, pageSize: 50 })
      const ids = res.items.map((m) => m.id)
      expect(ids).toContain(presetChatA)
      expect(ids).toContain(presetChatB)
      expect(ids).toContain(privateChat)
    } finally {
      await db
        .update(enterprises)
        .set({ visiblePresetChatModels: [presetChatA] })
        .where(eq(enterprises.id, ent))
    }
  })
})

describe("权限组三白名单服务端裁剪", () => {
  it("createGroupAction：越权模块/模型静默裁剪", async () => {
    mockSession.userId = owner
    const res = await createGroupAction({
      name: `vis-grp-${runTag}`,
      allowedPages: ["create", "workspace", "temu", "settings"], // temu 未开通
      allowedModels: [presetImgA, presetImgB, randomUUID()], // B 未开 + 幽灵 id
      allowedChatModels: [presetChatA, presetChatB], // B 对企业关闭
      maxConcurrent: 3,
      priority: 1,
    })
    expect(res.ok).toBe(true)
    const [row] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.name, `vis-grp-${runTag}`))
    expect(row!.allowedPages).toEqual(["create", "workspace", "settings"])
    expect(row!.allowedModels).toEqual([presetImgA])
    expect(row!.allowedChatModels).toEqual([presetChatA])
    await db.delete(permissionGroups).where(eq(permissionGroups.id, row!.id))
  })

  it("createGroupAction：所选全部越权 → 保存失败返回明确错误且不落库", async () => {
    mockSession.userId = owner
    const res = await createGroupAction({
      name: `vis-grp-empty-${runTag}`,
      allowedPages: ["inventory"], // 未开通
      allowedModels: [presetImgB], // 白名单外
      allowedChatModels: [presetChatB], // 白名单外
      maxConcurrent: 3,
      priority: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe("所选模块/模型均已不在企业开通范围，请重新选择")
    }
    const [row] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.name, `vis-grp-empty-${runTag}`))
    expect(row).toBeUndefined()
  })

  it("updateGroupAction：混合越权裁掉越权项；全部越权保存失败（不放宽为空）", async () => {
    mockSession.userId = owner
    // 先造一个带历史残留的组：chat 白名单只剩已关闭模型
    const [g] = await db
      .insert(permissionGroups)
      .values({
        enterpriseId: ent,
        name: `vis-stale-${runTag}`,
        allowedPages: ["chat"],
        allowedModels: [presetImgB],
        allowedChatModels: [presetChatB],
      })
      .returning()
    const gId = g!.id

    // 混合：保留合法项、裁掉越权项
    const r1 = await updateGroupAction(gId, {
      name: `vis-stale-${runTag}`,
      allowedModels: [presetImgA, presetImgB],
      allowedChatModels: [presetChatA, presetChatB],
      allowedPages: ["chat", "inventory"], // inventory 未开通
    })
    expect(r1.ok).toBe(true)
    const [after1] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.id, gId))
    expect(after1!.allowedModels).toEqual([presetImgA])
    expect(after1!.allowedChatModels).toEqual([presetChatA])
    expect(after1!.allowedPages).toEqual(["chat"])

    // 全部越权：保存失败返回明确错误，行保持上次保存值（绝不放宽为「放行全部」）
    const r2 = await updateGroupAction(gId, {
      name: `vis-stale-${runTag}`,
      allowedModels: [presetImgB],
      allowedChatModels: [presetChatB],
      allowedPages: ["inventory"],
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.error).toBe("所选模块/模型均已不在企业开通范围，请重新选择")
    }
    const [after2] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.id, gId))
    expect(after2!.allowedModels).toEqual([presetImgA])
    expect(after2!.allowedChatModels).toEqual([presetChatA])
    expect(after2!.allowedPages).toEqual(["chat"])

    await db.delete(permissionGroups).where(eq(permissionGroups.id, gId))
  })
})

describe("listChatApisAction（/templates 关联对话模型下拉）", () => {
  it("企业白名单过滤 + 停用行排除；权限组白名单进一步收紧", async () => {
    mockSession.userId = member
    const res1 = await listChatApisAction()
    const ids1 = res1.map((m) => m.id)
    expect(ids1).toContain(presetChatA)
    expect(ids1).toContain(privateChat)
    expect(ids1).not.toContain(presetChatB)
    expect(ids1).not.toContain(presetChatInactive)

    // 组白名单收紧到仅 presetChatA
    await db
      .update(permissionGroups)
      .set({ allowedChatModels: [presetChatA] })
      .where(eq(permissionGroups.id, groupMember))
    try {
      const res2 = await listChatApisAction()
      expect(res2.map((m) => m.id)).toEqual([presetChatA])
    } finally {
      await db
        .update(permissionGroups)
        .set({ allowedChatModels: [] })
        .where(eq(permissionGroups.id, groupMember))
    }
  })
})

describe("listChatApiConfigsAction（遗留 action）", () => {
  it("isActive + 企业白名单双重过滤", async () => {
    mockSession.userId = member
    const res = await listChatApiConfigsAction()
    const ids = res.map((m) => (m as { id: string }).id)
    expect(ids).toContain(presetChatA)
    expect(ids).toContain(privateChat)
    expect(ids).not.toContain(presetChatB)
    expect(ids).not.toContain(presetChatInactive)
  })
})

describe("resolveProductChatConfig（帮写回退链全链严格白名单）", () => {
  it("未指定模型：回退只挑白名单内平台预置", async () => {
    const cfg = await resolveProductChatConfig(ent)
    expect(cfg?.id).toBe(presetChatA)
  })

  it("超管指定模型不在企业白名单内：不生效，回退白名单内模型", async () => {
    await db.insert(systemSettings).values({
      enterpriseId: null,
      key: PRODUCT_AI_SETTING_KEY,
      value: { chatApiConfigId: presetChatB } as never,
      description: "可见性测试：指定白名单外模型",
    })
    const cfg = await resolveProductChatConfig(ent)
    expect(cfg?.id).toBe(presetChatA) // 指定 B 被白名单拒绝 → 回退仍取 A
  })

  it("超管指定模型在企业白名单内：生效", async () => {
    await db
      .update(systemSettings)
      .set({ value: { chatApiConfigId: presetChatA } as never, updatedAt: new Date() })
      .where(
        and(
          eq(systemSettings.key, PRODUCT_AI_SETTING_KEY),
          isNull(systemSettings.enterpriseId),
        ),
      )
    const cfg = await resolveProductChatConfig(ent)
    expect(cfg?.id).toBe(presetChatA)
    await db
      .delete(systemSettings)
      .where(
        and(
          eq(systemSettings.key, PRODUCT_AI_SETTING_KEY),
          isNull(systemSettings.enterpriseId),
        ),
      )
  })

  it("企业白名单全关（无匹配项）：返回 null", async () => {
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [randomUUID()] })
      .where(eq(enterprises.id, ent))
    try {
      const cfg = await resolveProductChatConfig(ent)
      expect(cfg).toBeNull()
    } finally {
      await db
        .update(enterprises)
        .set({ visiblePresetChatModels: [presetChatA] })
        .where(eq(enterprises.id, ent))
    }
  })

  it("企业私有模型不受白名单限制（白名单全关时仍可用）", async () => {
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [randomUUID()] })
      .where(eq(enterprises.id, ent))
    // 私有 openai 行（resolve 链仅认 openai 兼容格式）
    const [tmp] = await db
      .insert(chatApiConfigs)
      .values({
        enterpriseId: ent,
        name: `vis-chat-priv2-${runTag}`,
        displayName: `vis-chat-priv2-${runTag}`,
        apiEndpoint: `https://vis-${runTag}-priv2.example.com/v1`,
        apiKeyEncrypted: encrypt(`sk-visibility2-${runTag}`),
        formatType: "openai",
        sortOrder: -5005,
      })
      .returning()
    try {
      const cfg = await resolveProductChatConfig(ent)
      expect(cfg?.id).toBe(tmp.id)
    } finally {
      await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, tmp.id))
      await db
        .update(enterprises)
        .set({ visiblePresetChatModels: [presetChatA] })
        .where(eq(enterprises.id, ent))
    }
  })
})

describe("getExecutableTemplate（模板执行白名单）", () => {
  it("关联模型被企业关闭：拒绝执行", async () => {
    await expect(
      getExecutableTemplate({
        templateId: tplLinkedB,
        enterpriseId: ent,
        userId: member,
        isAdmin: false,
      }),
    ).rejects.toThrow("模板关联的对话模型不可用")
  })

  it("白名单置空（全部放行）：可执行", async () => {
    await db
      .update(enterprises)
      .set({ visiblePresetChatModels: [] })
      .where(eq(enterprises.id, ent))
    try {
      const tpl = await getExecutableTemplate({
        templateId: tplLinkedB,
        enterpriseId: ent,
        userId: member,
        isAdmin: false,
      })
      expect(tpl.chatApi.id).toBe(presetChatB)
    } finally {
      await db
        .update(enterprises)
        .set({ visiblePresetChatModels: [presetChatA] })
        .where(eq(enterprises.id, ent))
    }
  })
})
