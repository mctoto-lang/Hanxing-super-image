import { beforeEach, describe, expect, it, vi } from "vitest"
import { submitProductCarouselAction } from "@/server/actions/temu-publish"
import { TemuApiError } from "@/lib/temu-api/client"

/**
 * 换图片（submitProductCarouselAction）守卫回归：
 * 1. 停用店铺须拦截（同 requirePublishStore / requireTemuStore 口径）；
 * 2. 官方 7000007（token 过期）须回写 tokenState=invalid（同 toPublishError 口径），
 *    覆盖轮播提交与图源转官方图床两条 callTemuApi 路径。
 * 全量 mock 依赖（session / db / 店铺调用上下文 / callTemuApi），不触真实 PG 与官方网关。
 */

const state = vi.hoisted(() => ({
  stores: [] as Array<Record<string, unknown>>,
  apiCalls: [] as string[],
  /** callTemuApi 行为：默认成功（result 兜底字段） */
  apiImpl: async (_type: string): Promise<unknown> => ({ result: {} }),
}))

vi.mock("@/lib/auth/session", () => ({
  requireEnterpriseContext: async () => ({ canAccess: () => true }),
  getCurrentEnterpriseScope: () => ({ enterpriseId: "ent-1" }),
}))

// 仅登记 temuStores：本 action 只按 (id, enterpriseId) 查店、按 id 回写 tokenState
vi.mock("@/db/client", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema/temu")>("@/db/schema/temu")
  const colKey = new Map<unknown, string>()
  for (const [key, value] of Object.entries(schema.temuStores)) {
    if (
      value &&
      typeof value === "object" &&
      "name" in value &&
      "table" in value &&
      !("queryChunks" in value)
    ) {
      colKey.set(value, key)
    }
  }
  /** drizzle 条件求值（仅 and/eq，本 action 用到的形态） */
  const matches = (cond: unknown, row: Record<string, unknown>): boolean => {
    const chunks = (cond as { queryChunks?: unknown[] } | null)?.queryChunks
    if (!chunks) throw new Error("mock db: 不支持的条件形态")
    const subs = chunks.filter(
      (c) => c && typeof c === "object" && Array.isArray((c as { queryChunks?: unknown[] }).queryChunks),
    )
    if (subs.length > 0) return subs.every((sub) => matches(sub, row))
    for (let i = 0; i < chunks.length; i++) {
      const key = colKey.get(chunks[i])
      if (!key) continue
      const op = ((chunks[i + 1] as { value?: string[] } | undefined)?.value?.join("") ?? "").trim()
      const raw = (chunks[i + 2] as { value?: unknown } | undefined)?.value
      if (op === "=" && row[key] !== raw) return false
    }
    return true
  }
  const requireStores = (table: unknown) => {
    if (table !== schema.temuStores) throw new Error("mock db: 未登记的表")
    return state.stores
  }
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => {
            const hit = requireStores(table).filter((row) => matches(cond, row))
            return Object.assign(Promise.resolve(hit), { limit: async () => hit })
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            for (const row of requireStores(table).filter((r) => matches(cond, r))) Object.assign(row, values)
            return Promise.resolve([])
          },
        }),
      }),
    },
  }
})

vi.mock("@/server/services/temu-sync", () => ({
  getTemuCallContext: async () => ({ appKey: "k", appSecret: "s", accessToken: "t" }),
}))

// 真实 isTemuTokenExpired / TemuApiError 保留，仅接管 callTemuApi（不发真实请求）
vi.mock("@/lib/temu-api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/temu-api/client")>()
  return {
    ...actual,
    callTemuApi: (type: string) => {
      state.apiCalls.push(type)
      return state.apiImpl(type)
    },
  }
})

const STORE_ID = "11111111-1111-4111-8111-111111111111"

/** kwcdn 官方域图 URL（action 内直接透传，不触发转存） */
const kwcdn = (n: number) => `https://img.kwcdn.com/test/a${n}.jpg`

/** 800×800 PNG dataUrl（readImageDim 直读 IHDR 宽高，走转官方图床路径） */
function png800DataUrl(): string {
  const buf = Buffer.alloc(32)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(800, 16)
  buf.writeUInt32BE(800, 20)
  return `data:image/png;base64,${buf.toString("base64")}`
}

const tokenExpiredErr = () =>
  new TemuApiError("access_token is expired", {
    errorCode: 7000007,
    errorMsg: "access_token is expired",
    apiType: "bg.glo.goods.edit.pictures.submit",
    gateway: "PA",
  })

beforeEach(() => {
  state.stores.length = 0
  state.apiCalls.length = 0
  state.apiImpl = async () => ({ result: {} })
})

describe("submitProductCarouselAction 守卫口径", () => {
  it("停用店铺被拦截，不触官方接口、不改店铺状态", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: false, tokenState: "active" })
    const res = await submitProductCarouselAction({
      storeId: STORE_ID,
      productId: "P1",
      imageUrls: [1, 2, 3, 4, 5].map(kwcdn),
    })
    expect(res).toEqual({ ok: false, error: "店铺已停用" })
    expect(state.apiCalls).toEqual([])
    expect(state.stores[0]!.tokenState).toBe("active")
  })

  it("轮播提交遇 7000007 回写 tokenState=invalid", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    state.apiImpl = async () => {
      throw tokenExpiredErr()
    }
    const res = await submitProductCarouselAction({
      storeId: STORE_ID,
      productId: "P1",
      imageUrls: [1, 2, 3, 4, 5].map(kwcdn),
    })
    expect(res).toEqual({ ok: false, error: expect.stringContaining("已过期") })
    expect(state.stores[0]!.tokenState).toBe("invalid")
  })

  it("图源转官方图床遇 7000007 同样回写 tokenState=invalid", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    state.apiImpl = async () => {
      throw tokenExpiredErr()
    }
    const res = await submitProductCarouselAction({
      storeId: STORE_ID,
      productId: "P1",
      imageUrls: [kwcdn(1), kwcdn(2), kwcdn(3), kwcdn(4), png800DataUrl()],
    })
    expect(res).toEqual({ ok: false, error: expect.stringContaining("已过期") })
    expect(state.apiCalls).toContain("bg.goods.image.upload.global")
    expect(state.stores[0]!.tokenState).toBe("invalid")
  })
})
