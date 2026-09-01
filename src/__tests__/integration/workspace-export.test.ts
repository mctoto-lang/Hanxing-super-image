import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  cardImages,
  enterprises,
  permissionGroups,
  promptCards,
  users,
  workspaceTasks,
} from "@/db/schema"
import { redis } from "@/lib/redis"
import { GET } from "@/app/api/workspace/export/route"

/**
 * 工作台 ZIP 导出路由集成测试（复现「localhost 当前无法处理此请求」500）
 *
 * 覆盖：票据消费 → 按卡片展示图选图 → 打包 ZIP 下载；票据一次性（重放 410）。
 * imageUrl 用 data: URL（Node fetch 原生支持），不依赖外部网络。
 */

/** 1x1 红色像素 PNG */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

let entId: string
let taskId: string
let token: string

const EXPORT_TICKET_KEY_PREFIX = "hanxing:export-ticket:"

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "导出测试企业",
      slug: `exp-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
    })
    .returning()
  entId = ent!.id

  const [group] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "默认组", isDefault: true })
    .returning()

  const [user] = await db
    .insert(users)
    .values({
      username: `exp_user_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      enterpriseId: entId,
      groupId: group!.id,
    })
    .returning()

  const [task] = await db
    .insert(workspaceTasks)
    .values({
      enterpriseId: entId,
      userId: user!.id,
      title: "导出测试任务",
      themePrompt: "导出测试主题",
      status: "completed",
      cardCount: 2,
    })
    .returning()
  taskId = task!.id

  for (let i = 0; i < 2; i++) {
    const [card] = await db
      .insert(promptCards)
      .values({
        enterpriseId: entId,
        taskId,
        cardIndex: i + 1,
        prompt: `卡片${i + 1}提示词`,
      })
      .returning()
    await db.insert(cardImages).values({
      enterpriseId: entId,
      cardId: card!.id,
      imageUrl: TINY_PNG,
      status: "completed",
      isSelected: i === 0, // 第一张卡有 isSelected 标记，第二张靠已完成回退
    })
  }

  token = randomUUID()
  await redis.set(
    EXPORT_TICKET_KEY_PREFIX + token,
    JSON.stringify({ enterpriseId: entId, taskId, format: "png" }),
    "EX",
    120,
  )
})

afterAll(async () => {
  await redis.del(EXPORT_TICKET_KEY_PREFIX + token)
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(permissionGroups).where(eq(permissionGroups.enterpriseId, entId))
  await db.delete(workspaceTasks).where(eq(workspaceTasks.enterpriseId, entId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
})

function makeRequest(t: string): Request {
  return new Request(`http://localhost:3000/api/workspace/export?ticket=${t}`)
}

describe("工作台 ZIP 导出路由", () => {
  it("消费票据 → 200 + ZIP 主体（两张卡片各含一张展示图）", async () => {
    const res = await GET(makeRequest(token))
    if (res.status !== 200) {
      console.error("[export-test] 非 200 响应体:", await res.text())
    }
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/zip")
    const disposition = res.headers.get("content-disposition") ?? ""
    expect(disposition).toContain("attachment")
    // 中文文件名走 RFC 5987（filename*=UTF-8''...），保证头是合法 ByteString
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("导出测试任务")}.zip`,
    )

    const body = Buffer.from(await res.arrayBuffer())
    // ZIP 魔数 PK\x03\x04
    expect(body.length).toBeGreaterThan(100)
    expect(body[0]).toBe(0x50)
    expect(body[1]).toBe(0x4b)
  })

  it("票据一次性：重放同一票据返回 410", async () => {
    const res = await GET(makeRequest(token))
    expect(res.status).toBe(410)
  })

  it("无票据参数返回 400", async () => {
    const res = await GET(makeRequest(""))
    expect(res.status).toBe(400)
  })
})
