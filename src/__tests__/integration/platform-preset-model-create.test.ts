import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, enterprises, models, users } from "@/db/schema"
import { createPresetChatModelAction } from "@/server/actions/platform-chat-models"
import { createPresetModelAction } from "@/server/actions/platform-models"

/**
 * 超管新建预置模型集成测试（真实本地 PG）。
 *
 * 背景：drizzle 0.45 把 PG 错误包成 DrizzleQueryError（message=SQL 文本，
 * 真实 code 在 .cause），旧 `message.includes("unique")` 判重是死分支——
 * 重名撞唯一索引（23505）一律显示「创建失败」。本测试锁定：
 * - 新建成功 + 白名单模式企业的 visiblePreset*Models 被原子追加（同事务 sync）；
 * - 同 name+apiEndpoint 重复创建返回「模型标识 + API 地址已存在」（23505 判重）；
 * - 生图侧对称两用例（同病同修）。
 */

// action 鉴权链走 auth()；vitest 无法加载 next-auth，mock 成可控 session
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

const runTag = randomUUID().slice(0, 8)

let superAdmin: string
let ent: string // 白名单模式企业（两白名单均非空，验证 sync 追加）
let chatModelId: string // 测试新建的预置对话模型
let imgModelId: string // 测试新建的预置生图模型

beforeAll(async () => {
  const [s] = await db
    .insert(users)
    .values({
      username: `ppmc-super-${runTag}`,
      name: `ppmc-super-${runTag}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: null,
      isSuperAdmin: true,
    })
    .returning()
  superAdmin = s!.id

  // 两个白名单都非空（白名单模式）——新建预置模型必须被追加，否则企业端不可见
  const seed = randomUUID()
  const [e] = await db
    .insert(enterprises)
    .values({
      name: "预置创建测试企业",
      slug: `ppmc-${runTag}`,
      visiblePresetModels: [seed],
      visiblePresetChatModels: [seed],
    })
    .returning()
  ent = e!.id

  mockSession.userId = superAdmin
})

afterAll(async () => {
  if (chatModelId) {
    await db.delete(chatApiConfigs).where(eq(chatApiConfigs.id, chatModelId))
  }
  if (imgModelId) {
    await db.delete(models).where(eq(models.id, imgModelId))
  }
  await db.delete(users).where(eq(users.id, superAdmin))
  await db.delete(enterprises).where(eq(enterprises.id, ent))
  // 回收 createPreset*Action 内部白名单 sync 的全局副作用：sync 会 UPDATE 所有
  // 白名单非空企业（含共享 dev 库的真实数据行），留下悬挂模型 id 并反复重写
  // updated_at——用 jsonb 减法（- text 删除数组内匹配字符串元素）把测试模型 id 从
  // 所有企业白名单移除；幂等可重复执行（不含该元素时为 no-op），
  // @> 守卫（与 sync 同款数组包含判断）只触碰确含该 id 的行
  if (chatModelId) {
    await db.execute(sql`
      UPDATE ${enterprises}
      SET visible_preset_chat_models = visible_preset_chat_models - ${chatModelId}::text
      WHERE visible_preset_chat_models @> ${JSON.stringify([chatModelId])}::jsonb
    `)
  }
  if (imgModelId) {
    await db.execute(sql`
      UPDATE ${enterprises}
      SET visible_preset_models = visible_preset_models - ${imgModelId}::text
      WHERE visible_preset_models @> ${JSON.stringify([imgModelId])}::jsonb
    `)
  }
})

const chatName = `ppmc-chat-${runTag}`
const chatEndpoint = `https://ppmc-${runTag}.example.com/v1`
const imgName = `ppmc-img-${runTag}`
const imgEndpoint = `https://ppmc-${runTag}-img.example.com/v1`

describe("createPresetChatModelAction（超管新建对话模型）", () => {
  it("新建成功：行落库 + 白名单模式企业被原子追加", async () => {
    const res = await createPresetChatModelAction({
      name: chatName,
      displayName: `预置对话-${runTag}`,
      apiEndpoint: chatEndpoint,
      apiKey: "sk-ppmc-test",
      formatType: "openai",
    })
    expect(res.ok).toBe(true)

    const [row] = await db
      .select({ id: chatApiConfigs.id })
      .from(chatApiConfigs)
      .where(
        and(
          eq(chatApiConfigs.name, chatName),
          eq(chatApiConfigs.apiEndpoint, chatEndpoint),
          isNull(chatApiConfigs.enterpriseId),
        ),
      )
    expect(row).toBeTruthy()
    chatModelId = row!.id

    const [entRow] = await db
      .select({ wl: enterprises.visiblePresetChatModels })
      .from(enterprises)
      .where(eq(enterprises.id, ent))
    expect((entRow!.wl as string[]).includes(chatModelId)).toBe(true)
  })

  it("同 name+apiEndpoint 重复创建：报「模型标识 + API 地址已存在」（23505 判重回归锁）", async () => {
    const res = await createPresetChatModelAction({
      name: chatName,
      displayName: `预置对话重复-${runTag}`,
      apiEndpoint: chatEndpoint,
      apiKey: "sk-ppmc-test",
      formatType: "openai",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // 修复前此处是「创建失败」（includes("unique") 死分支）
      expect(res.error).toBe("模型标识 + API 地址已存在")
    }
  })
})

describe("createPresetModelAction（超管新建生图模型，同病同修）", () => {
  it("新建成功：行落库 + 白名单模式企业被原子追加", async () => {
    const res = await createPresetModelAction({
      name: imgName,
      displayName: `预置生图-${runTag}`,
      apiEndpoint: imgEndpoint,
      apiKey: "sk-ppmc-test",
      apiFormat: "openai",
    })
    expect(res.ok).toBe(true)

    const [row] = await db
      .select({ id: models.id })
      .from(models)
      .where(
        and(
          eq(models.name, imgName),
          eq(models.apiEndpoint, imgEndpoint),
          isNull(models.enterpriseId),
        ),
      )
    expect(row).toBeTruthy()
    imgModelId = row!.id

    const [entRow] = await db
      .select({ wl: enterprises.visiblePresetModels })
      .from(enterprises)
      .where(eq(enterprises.id, ent))
    expect((entRow!.wl as string[]).includes(imgModelId)).toBe(true)
  })

  it("同 name+apiEndpoint 重复创建：报「模型标识 + API 地址已存在」", async () => {
    const res = await createPresetModelAction({
      name: imgName,
      displayName: `预置生图重复-${runTag}`,
      apiEndpoint: imgEndpoint,
      apiKey: "sk-ppmc-test",
      apiFormat: "openai",
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe("模型标识 + API 地址已存在")
    }
  })
})
