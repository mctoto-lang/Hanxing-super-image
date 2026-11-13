import { beforeEach, describe, expect, it, vi } from "vitest"
import { submitProductVideoAction, getTemuVideoResultAction } from "@/server/actions/temu-publish"
import { TemuApiError } from "@/lib/temu-api/client"

/**
 * 换视频 action 守卫与载荷回归（2026-11-12 批次）：
 * 1. 挂载提交按 slot 落对应视频位（productCarouseVideoReqList / productDetailVideoReqList）；
 * 2. 转码结果查询：vid 透传、未完成（空 result / 120000012）→ video=null、token 过期回写；
 * 3. 停用店铺拦截。
 * 全量 mock（session / db / 调用上下文 / callTemuApi），不触真实 PG 与官方网关。
 */

const state = vi.hoisted(() => ({
  stores: [] as Array<Record<string, unknown>>,
  apiCalls: [] as Array<{ type: string; params: Record<string, unknown> }>,
  apiImpl: async (
    _type: string,
    _params: Record<string, unknown>,
  ): Promise<unknown> => ({ result: {} }),
}))

vi.mock("@/lib/auth/session", () => ({
  requireEnterpriseContext: async () => ({ canAccess: () => true }),
  getCurrentEnterpriseScope: () => ({ enterpriseId: "ent-1" }),
}))

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

vi.mock("@/lib/temu-api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/temu-api/client")>()
  return {
    ...actual,
    callTemuApi: (type: string, params: Record<string, unknown>) => {
      state.apiCalls.push({ type, params })
      return state.apiImpl(type, params)
    },
  }
})

const STORE_ID = "22222222-2222-4222-8222-222222222222"

const VIDEO = {
  vid: "goods-video-tag#test-vid-001",
  coverUrl: "https://img.kwcdn.com/frame.jpeg",
  videoUrl: "https://goods-vod.kwcdn.com/goods-video/test.mp4",
  width: 960,
  height: 540,
}

const tokenExpiredErr = () =>
  new TemuApiError("access_token is expired", {
    errorCode: 7000007,
    errorMsg: "access_token is expired",
    apiType: "bg.goods.big.video.upload.result.get.global",
    gateway: "PA",
  })

const processingErr = () =>
  new TemuApiError("TEMU 接口 bg.goods.big.video.upload.result.get.global 返回失败（120000012）：processing", {
    errorCode: 120000012,
    errorMsg: "processing",
    apiType: "bg.goods.big.video.upload.result.get.global",
    gateway: "PA",
  })

beforeEach(() => {
  state.stores.length = 0
  state.apiCalls.length = 0
  state.apiImpl = async () => ({ result: {} })
})

describe("submitProductVideoAction 挂载口径", () => {
  it("slot=carousel 落主图轮播视频位 productCarouseVideoReqList", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    const res = await submitProductVideoAction({
      storeId: STORE_ID,
      productId: "4666287147",
      slot: "carousel",
      video: VIDEO,
    })
    expect(res).toEqual({ ok: true })
    expect(state.apiCalls).toHaveLength(1)
    expect(state.apiCalls[0]!.type).toBe("bg.glo.goods.edit.pictures.submit")
    expect(state.apiCalls[0]!.params).toEqual({
      productId: "4666287147",
      productCarouseVideoReqList: [VIDEO],
    })
  })

  it("slot=detail 落详情视频位 productDetailVideoReqList", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    const res = await submitProductVideoAction({
      storeId: STORE_ID,
      productId: "4666287147",
      slot: "detail",
      video: VIDEO,
    })
    expect(res).toEqual({ ok: true })
    expect(state.apiCalls[0]!.params).toEqual({
      productId: "4666287147",
      productDetailVideoReqList: [VIDEO],
    })
  })

  it("停用店铺被拦截，不触官方接口", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: false, tokenState: "active" })
    const res = await submitProductVideoAction({
      storeId: STORE_ID,
      productId: "4666287147",
      slot: "carousel",
      video: VIDEO,
    })
    expect(res).toEqual({ ok: false, error: "店铺已停用" })
    expect(state.apiCalls).toEqual([])
  })
})

describe("getTemuVideoResultAction 转码查询口径", () => {
  it("转码完成：vid 透传官方，结果字段映射", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    state.apiImpl = async () => ({ result: { ...VIDEO } })
    const res = await getTemuVideoResultAction({ store: STORE_ID, vid: VIDEO.vid })
    expect(res).toEqual({ ok: true, video: VIDEO })
    expect(state.apiCalls[0]!.params).toEqual({ vid: VIDEO.vid })
  })

  it("result 为空对象（未完成）→ video=null", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    state.apiImpl = async () => ({ result: {} })
    const res = await getTemuVideoResultAction({ store: STORE_ID, vid: VIDEO.vid })
    expect(res).toEqual({ ok: true, video: null })
  })

  it("120000012（处理中）→ video=null 前端继续轮询", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    state.apiImpl = async () => {
      throw processingErr()
    }
    const res = await getTemuVideoResultAction({ store: STORE_ID, vid: VIDEO.vid })
    expect(res).toEqual({ ok: true, video: null })
  })

  it("7000007 token 过期回写 tokenState=invalid", async () => {
    state.stores.push({ id: STORE_ID, enterpriseId: "ent-1", enabled: true, tokenState: "active" })
    state.apiImpl = async () => {
      throw tokenExpiredErr()
    }
    const res = await getTemuVideoResultAction({ store: STORE_ID, vid: VIDEO.vid })
    expect(res).toEqual({ ok: false, error: expect.stringContaining("已过期") })
    expect(state.stores[0]!.tokenState).toBe("invalid")
  })
})
