import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { db } from "@/db/client"
import {
  enterprises,
  models,
  platformSizeSpecs,
  productDirections,
  users,
} from "@/db/schema"
import {
  createDirectionAction,
  reorderDirectionsAction,
  reorderSizeSpecsAction,
  toggleDirectionActiveAction,
  updateDirectionAction,
} from "@/server/actions/platform-product"
import { reorderPresetModelsAction } from "@/server/actions/platform-models"

/**
 * 精修固定项守卫 + 拖拽排序归属/分组校验集成测试（真实本地 PG）。
 *
 * 固定项三处守卫（platform-product）：refine 不可新增 / 不可改名字段 /
 * 不可停用（反向启用放行自愈）/ 不可拖拽。
 * reorder 校验：尺寸规范跨平台分组拒绝；平台预置模型重排拒绝企业私有 id。
 * 登录态经 mock auth() 注入超管夹具用户；revalidatePath mock 为空操作。
 */
const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))

let entId: string
let refineId: string
let refineInactiveId: string
let suiteAId: string
let suiteBId: string
let presetModelId: string
let entModelId: string
let specAId: string
let specBId: string
let specOtherPlatformId: string

const directionValues = (opts: {
  key: string
  name: string
  scope: "suite" | "refine"
  isActive?: boolean
  sortOrder: number
}): typeof productDirections.$inferInsert => ({
  key: opts.key,
  name: opts.name,
  promptTemplate: `模板-${opts.key}`,
  appliesTo: [opts.scope],
  isActive: opts.isActive ?? true,
  sortOrder: opts.sortOrder,
})

// 夹具 key 用 uuid 前缀防与库内种子数据（pd_key_unique）冲突
const FIXTURE_TAG = `g${randomUUID().slice(0, 8).replace(/-/g, "")}`

beforeAll(async () => {
  // 超管用户（enterpriseId 为 NULL，isSuperAdmin=true）
  const [admin] = await db
    .insert(users)
    .values({
      username: `guard_admin_${randomUUID().slice(0, 8)}`,
      passwordHash: "$2a$10$dummyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      name: "守卫超管",
      isSuperAdmin: true,
    })
    .returning()
  mockSession.userId = admin!.id

  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "守卫测试企业",
      slug: `guard-${randomUUID().slice(0, 8)}`,
    })
    .returning()
  entId = ent!.id

  const dirs = await db
    .insert(productDirections)
    .values([
      directionValues({
        key: `${FIXTURE_TAG}_refine`,
        name: "守卫精修项",
        scope: "refine",
        sortOrder: 0,
      }),
      directionValues({
        key: `${FIXTURE_TAG}_refine_off`,
        name: "守卫精修项(停用)",
        scope: "refine",
        isActive: false,
        sortOrder: 1,
      }),
      directionValues({
        key: `${FIXTURE_TAG}_suite_a`,
        name: "套图A",
        scope: "suite",
        sortOrder: 10,
      }),
      directionValues({
        key: `${FIXTURE_TAG}_suite_b`,
        name: "套图B",
        scope: "suite",
        sortOrder: 11,
      }),
    ])
    .returning({ id: productDirections.id, key: productDirections.key })
  refineId = dirs.find((d) => d.key === `${FIXTURE_TAG}_refine`)!.id
  refineInactiveId = dirs.find((d) => d.key === `${FIXTURE_TAG}_refine_off`)!.id
  suiteAId = dirs.find((d) => d.key === `${FIXTURE_TAG}_suite_a`)!.id
  suiteBId = dirs.find((d) => d.key === `${FIXTURE_TAG}_suite_b`)!.id

  const modelRows = await db
    .insert(models)
    .values([
      {
        enterpriseId: null,
        name: `guard-preset-${randomUUID().slice(0, 8)}`,
        displayName: "平台预置模型",
        apiEndpoint: "https://preset.example.com/v1",
        apiKeyEncrypted: "dummy",
        sortOrder: 0,
      },
      {
        enterpriseId: entId,
        name: `guard-ent-${randomUUID().slice(0, 8)}`,
        displayName: "企业私有模型",
        apiEndpoint: "https://ent.example.com/v1",
        apiKeyEncrypted: "dummy",
        sortOrder: 1,
      },
    ])
    .returning({ id: models.id, displayName: models.displayName })
  presetModelId = modelRows.find((m) => m.displayName === "平台预置模型")!.id
  entModelId = modelRows.find((m) => m.displayName === "企业私有模型")!.id

  const specs = await db
    .insert(platformSizeSpecs)
    .values([
      {
        platformKey: `${FIXTURE_TAG}_amazon`,
        label: "A1",
        width: 1000,
        height: 1000,
        sortOrder: 0,
      },
      {
        platformKey: `${FIXTURE_TAG}_amazon`,
        label: "A2",
        width: 1200,
        height: 1200,
        sortOrder: 1,
      },
      {
        platformKey: `${FIXTURE_TAG}_temu`,
        label: "T1",
        width: 800,
        height: 800,
        sortOrder: 0,
      },
    ])
    .returning({ id: platformSizeSpecs.id, label: platformSizeSpecs.label })
  specAId = specs.find((s) => s.label === "A1")!.id
  specBId = specs.find((s) => s.label === "A2")!.id
  specOtherPlatformId = specs.find((s) => s.label === "T1")!.id
})

afterAll(async () => {
  // beforeAll 部分失败时 id 可能未赋值，逐项防御性清理
  await db.delete(users).where(eq(users.id, mockSession.userId!))
  const dirIds = [refineId, refineInactiveId, suiteAId, suiteBId].filter(Boolean)
  if (dirIds.length > 0) {
    await db.delete(productDirections).where(inArray(productDirections.id, dirIds))
  }
  const specIds = [specAId, specBId, specOtherPlatformId].filter(Boolean)
  if (specIds.length > 0) {
    await db.delete(platformSizeSpecs).where(inArray(platformSizeSpecs.id, specIds))
  }
  const modelIds = [presetModelId, entModelId].filter(Boolean)
  if (modelIds.length > 0) {
    await db.delete(models).where(inArray(models.id, modelIds))
  }
  if (entId) await db.delete(enterprises).where(eq(enterprises.id, entId))
})

describe("精修固定项守卫", () => {
  it("不可新增 refine 方向", async () => {
    const r = await createDirectionAction({
      name: "违规精修项",
      promptTemplate: "x",
      scope: "refine",
      supportsCount: false,
      maxCount: 1,
      isHidden: false,
      isHero: false,
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("不可新增")
  })

  it("精修项仅可改提示词模板：改名称被拒，改模板放行", async () => {
    const bad = await updateDirectionAction(refineId, { name: "改名" })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain("仅可修改提示词模板")

    const ok = await updateDirectionAction(refineId, {
      promptTemplate: "新模板内容",
    })
    expect(ok.ok).toBe(true)
    const [row] = await db
      .select({ promptTemplate: productDirections.promptTemplate })
      .from(productDirections)
      .where(eq(productDirections.id, refineId))
    expect(row!.promptTemplate).toBe("新模板内容")
  })

  it("精修项不可停用；历史误停用行反向启用放行（自愈）", async () => {
    const off = await toggleDirectionActiveAction(refineId)
    expect(off.ok).toBe(false)
    expect(off.error).toContain("不可停用")

    const heal = await toggleDirectionActiveAction(refineInactiveId)
    expect(heal.ok).toBe(true)
    const [row] = await db
      .select({ isActive: productDirections.isActive })
      .from(productDirections)
      .where(eq(productDirections.id, refineInactiveId))
    expect(row!.isActive).toBe(true)
  })

  it("精修项不可拖拽排序；普通方向重排按新顺序落库", async () => {
    const mixed = await reorderDirectionsAction([suiteAId, refineId])
    expect(mixed.ok).toBe(false)
    expect(mixed.error).toContain("不支持拖拽排序")

    const r = await reorderDirectionsAction([suiteBId, suiteAId]) // 交换顺序
    expect(r.ok).toBe(true)
    const rows = await db
      .select({ id: productDirections.id, sortOrder: productDirections.sortOrder })
      .from(productDirections)
      .where(inArray(productDirections.id, [suiteAId, suiteBId]))
    const a = rows.find((x) => x.id === suiteAId)!
    const b = rows.find((x) => x.id === suiteBId)!
    expect(b.sortOrder).toBeLessThan(a.sortOrder)
  })
})

describe("reorder 归属/分组校验", () => {
  it("尺寸规范跨平台分组混排被拒；同组重排放行", async () => {
    const mixed = await reorderSizeSpecsAction([specAId, specOtherPlatformId])
    expect(mixed.ok).toBe(false)
    expect(mixed.error).toContain("同一平台")

    const r = await reorderSizeSpecsAction([specBId, specAId])
    expect(r.ok).toBe(true)
  })

  it("平台预置模型重排拒绝企业私有 id；纯预置重排按新顺序落库", async () => {
    const mixed = await reorderPresetModelsAction([presetModelId, entModelId])
    expect(mixed.ok).toBe(false)
    expect(mixed.error).toContain("平台预置")

    // 先给预置模型独立的排序值域，避免与夹具外的平台预置行互相影响
    await db
      .update(models)
      .set({ sortOrder: 9000 })
      .where(eq(models.id, presetModelId))
    const before = await db
      .select({ sortOrder: models.sortOrder })
      .from(models)
      .where(eq(models.id, presetModelId))

    const r = await reorderPresetModelsAction([presetModelId])
    expect(r.ok).toBe(true)
    // 单行批次全同值 → 以该值为基准连续递增（9000 不变）
    const after = await db
      .select({ sortOrder: models.sortOrder })
      .from(models)
      .where(eq(models.id, presetModelId))
    expect(after[0]!.sortOrder).toBe(before[0]!.sortOrder)
  })
})
