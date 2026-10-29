import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { deflateSync } from "node:zlib"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { enterprises, permissionGroups, users } from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import { temuStores, temuPublishTemplates } from "@/db/schema/temu"
import { encrypt } from "@/lib/crypto"
import {
  createPublishTemplateAction,
  updatePublishTemplateAction,
  listPublishTemplatesAction,
  listPublishRecordsAction,
  publishFromTemplateAction,
  searchTemuCategoriesAction,
  uploadPublishImageAction,
  uploadPublishGuideFileAction,
  compressTemuImagesAction,
  checkTemuDimensionImageAction,
} from "@/server/actions/temu-publish"

/**
 * 模板化发品 M2 回归：类目/属性查询、模板 zod 校验、发品请求组装
 * （锁定层/固定零值主销售规格/自建 specId 引用）与成败记录落库。
 * 官方 API mock fetch 按 type 分发；企业/店铺/模板走真库。
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/services/temu-cache", () => ({
  temuCached: (_key: string, load: () => Promise<unknown>) => load(),
  invalidateTemuCache: () => {},
}))
vi.mock("@/lib/temu-api/app-config", () => ({
  getTemuAppCredential: async () => ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    source: "test",
  }),
}))

/* ─── fixtures ─── */

const CATS_ROOT = {
  categoryDTOList: [
    { catId: 1464, catName: "宠物用品", parentCatId: 0, isLeaf: false, catLevel: 1 },
    { catId: 2096, catName: "家电", parentCatId: 0, isLeaf: false, catLevel: 1 },
  ],
}
const ATTRS = {
  inputMaxSpecNum: 2,
  templateId: 555001,
  properties: [
    {
      pid: 614, templatePid: 937016, refPid: 377, parentTemplatePid: 0,
      name: "目标物种", required: true, isSale: false, controlType: 1,
      values: [{ vid: 16752, value: "松鼠", parentVidList: [] }],
    },
    {
      pid: 1, templatePid: 937018, refPid: 12, parentTemplatePid: 0,
      name: "材质", required: true, isSale: false, controlType: 1,
      values: [
        { vid: 49, value: "棉", parentVidList: [] },
        { vid: 410, value: "木材", parentVidList: [] },
      ],
    },
    {
      pid: 2230, templatePid: 1418354, refPid: 7317, parentTemplatePid: 937018,
      name: "木材类型", required: true, isSale: false, controlType: 1,
      values: [
        { vid: 213322, value: "再生木", parentVidList: [410] },
        { vid: 213321, value: "原木", parentVidList: [410] },
      ],
    },
  ],
}
const PARENT_SPECS = {
  parentSpecDTOS: [
    { parentSpecId: 1001, parentSpecName: "颜色" },
    { parentSpecId: 3001, parentSpecName: "尺码" },
  ],
}
const GOODS_ADD_OK = {
  productSkuList: [{ productSkuId: 28081, productSkcId: 540762 }],
  productId: 388095145,
  productSkcList: [{ productSkcId: 540762 }],
}

type Overrides = Record<string, { result?: unknown; success?: boolean; errorCode?: number; errorMsg?: string }>

/** mock fetch：无 body（图片拉取）→ 返回内建 800×800 PNG；有 body 按 type 分发。
 *  sequencedUploads：上传 URL 带序号（区分素材/尺寸图上传次序）；
 *  imgBuf 覆盖默认图（压缩用例传 ~1.9MB 噪声图触发 >1MB 官方压缩路径） */
function mockPublishFetch(overrides: Overrides = {}, sequencedUploads = false, imgBuf = buildPng(800, 800)) {
  let upCount = 0
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.body) {
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "image/png"]]),
        arrayBuffer: async () =>
          imgBuf.buffer.slice(imgBuf.byteOffset, imgBuf.byteOffset + imgBuf.byteLength),
      } as unknown as Response
    }
    const body = JSON.parse(String(init.body)) as { type: string }
    const ov = overrides[body.type]
    if (ov) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: ov.result ?? null,
          success: ov.success ?? true,
          errorCode: ov.errorCode ?? (ov.success === false ? 3000000 : 1000000),
          errorMsg: ov.errorMsg ?? "",
        }),
      } as unknown as Response
    }
    const result =
      body.type === "bg.glo.goods.cats.get"
        ? CATS_ROOT
        : body.type === "bg.glo.goods.attrs.get"
          ? ATTRS
          : body.type === "bg.glo.goods.parentspec.get"
            ? PARENT_SPECS
            : body.type === "bg.glo.goods.spec.create"
              ? { specId: 380724727 }
              : body.type === "bg.goods.image.upload.global"
                ? {
                    imageUrl: sequencedUploads
                      ? `https://img.kwcdn.com/product/open/up${++upCount}-goods.jpeg`
                      : "https://img.kwcdn.com/product/open/test-goods.jpeg",
                  }
                : body.type === "bg.compliancepicture.get.global"
                  ? { list: [{ hasSpot: "false" }] }
                  : body.type === "bg.glo.goods.category.match"
                    ? { categoryPathDTOS: [] }
                    : {}
    return {
      ok: true,
      status: 200,
      json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
    } as unknown as Response
  })
}

/** 内建 800×800 纯色 PNG（与探针同构，零依赖） */
function buildPng(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 120)])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row))),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** 800×800 伪随机噪声 PNG（~1.9MB，deflate 不可压）——触发发品官方压缩路径 */
function buildPngNoise(w: number, h: number): Buffer {
  const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const px = Buffer.alloc(w * h * 3)
  let state = 123456789
  for (let i = 0; i < px.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    px[i] = state >>> 24
  }
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) rows.push(Buffer.concat([Buffer.from([0]), px.subarray(y * w * 3, (y + 1) * w * 3)]))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))])
}

let entId: string
let ownerId: string
/** 无商品发布页权限的成员：模板写/发品按页面权限口径被拒 */
let memberId: string
/** 有商品发布页权限的成员：可创建模板/发品 */
let memberWithPermId: string
let storeId: string

const TEMPLATE_PAYLOAD = {
  name: "鸟笼-标准款",
  categoryChain: [
    { catId: 1464, catName: "宠物用品", isLeaf: false },
    { catId: 1465, catName: "鸟类用品", isLeaf: false },
    { catId: 1466, catName: "鸟笼", isLeaf: true },
  ],
  attributes: [
    { templatePid: 937016, pid: 614, refPid: 377, propName: "目标物种", vid: 16752, propValue: "松鼠", valueUnit: "" },
    { templatePid: 937018, pid: 1, refPid: 12, propName: "材质", vid: 410, propValue: "木材", valueUnit: "" },
  ],
  specConfig: { parentSpecId: 1001, parentSpecName: "颜色", specName: "PROBE Navy" },
  defaults: {
    title: "测试鸟笼 PROBE",
    imageUrls: [
      "https://img.kwcdn.com/product/open/a-goods.jpeg",
      "https://img.kwcdn.com/product/open/b-goods.jpeg",
      "https://img.kwcdn.com/product/open/c-goods.jpeg",
      "https://img.kwcdn.com/product/open/d-goods.jpeg",
      "https://img.kwcdn.com/product/open/e-goods.jpeg",
    ],
    declaredPriceFen: 1999,
    extCode: "CAGE-001",
    countryShortName: "CN",
    region2Id: 43000000000006,
    weightMg: 2_000_000,
    volumeMm: { len: 400, width: 300, height: 200 },
    isSensitive: 0,
    sensitiveTypes: [],
  },
}

beforeAll(async () => {
  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "temu 发品测试企业",
      slug: `pub-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      // 模板写/发品校验 temu_publish tab 模块权限（可查看商品发布页即可创建模板/发品）
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id

  const [noPermGroup] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "无发品权限组", allowedPages: ["settings"] })
    .returning()
  const [publishGroup] = await db
    .insert(permissionGroups)
    .values({ enterpriseId: entId, name: "发品权限组", allowedPages: ["settings", "temu", "temu_publish"] })
    .returning()

  const [owner] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `pub-${randomUUID().slice(0, 8)}`,
      email: `pub-${randomUUID().slice(0, 8)}@test.local`,
      name: "发品管理员",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  ownerId = owner!.id

  /** 无商品发布页权限的成员：模板写/发品按页面权限口径被拒 */
  const [member] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `pubm-${randomUUID().slice(0, 8)}`,
      email: `pubm-${randomUUID().slice(0, 8)}@test.local`,
      name: "发品普通成员",
      passwordHash: "x",
      enterpriseRole: "member",
      groupId: noPermGroup!.id,
    })
    .returning()
  memberId = member!.id

  /** 有商品发布页权限的成员：可创建模板/发品（可查看页面即有按钮权限） */
  const [memberWithPerm] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      username: `pubs-${randomUUID().slice(0, 8)}`,
      email: `pubs-${randomUUID().slice(0, 8)}@test.local`,
      name: "发品页权限成员",
      passwordHash: "x",
      enterpriseRole: "member",
      groupId: publishGroup!.id,
    })
    .returning()
  memberWithPermId = memberWithPerm!.id

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "发品测试店铺",
      accessTokenEncrypted: encrypt("pub-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id
})

afterAll(async () => {
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

/* ─── 用例 ─── */

describe("类目查询", () => {
  it("钻取用 parentCatId，返回非隐藏子级", async () => {
    mockSession.userId = ownerId
    const fn = mockPublishFetch()
    vi.stubGlobal("fetch", fn)
    const r = await searchTemuCategoriesAction({ parentCatId: 0 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.map((x) => x.catId)).toEqual([1464, 2096])
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.parentCatId).toBe(0)
  })

  it("关键词走 searchText 且返回完整类目链（只取叶子会导致 goods.add 6000011）", async () => {
    const fn = mockPublishFetch({
      "bg.glo.goods.category.match": {
        result: {
          categoryPathDTOS: [
            {
              cat1DTO: { catId: 1464, catName: "宠物用品", isLeaf: false },
              cat2DTO: { catId: 1465, catName: "鸟类用品", isLeaf: false },
              cat3DTO: { catId: 1466, catName: "鸟笼", isLeaf: true },
            },
          ],
        },
      },
    })
    vi.stubGlobal("fetch", fn)
    const r = await searchTemuCategoriesAction({ keyword: "鸟笼" })
    expect(r.ok).toBe(true)
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.searchText).toBe("鸟笼")
    if (!r.ok) return
    expect(r.chains?.length).toBe(1)
    expect(r.chains![0]!.map((c) => c.catId)).toEqual([1464, 1465, 1466])
    expect(r.chains![0]!.at(-1)!.isLeaf).toBe(true)
  })
})

describe("模板 CRUD", () => {
  it("体积顺序不合法被 zod 拒绝", async () => {
    mockSession.userId = ownerId
    const r = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: { ...TEMPLATE_PAYLOAD.defaults, volumeMm: { len: 100, width: 300, height: 200 } },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("最长边")
  })

  it("创建成功且列表可见（含属性回填数据）", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    const list = await listPublishTemplatesAction()
    expect(list.ok).toBe(true)
    if (!list.ok) return
    const row = list.rows.find((x) => x.name === "鸟笼-标准款")
    expect(row).toBeDefined()
    expect(row!.attributeCount).toBe(2)
    expect(row!.attributes[0]!.propName).toBe("目标物种")
    expect(row!.categoryChain.at(-1)!.isLeaf).toBe(true)
  })

  it("无商品发布页权限的成员不能创建模板（页面权限口径）", async () => {
    mockSession.userId = memberId
    const r = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("页面权限")
  })

  it("有商品发布页权限的成员可创建模板（可查看页面即可创建）", async () => {
    mockSession.userId = memberWithPermId
    const r = await createPublishTemplateAction({ ...TEMPLATE_PAYLOAD, name: "鸟笼-成员款" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const list = await listPublishTemplatesAction()
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.rows.some((x) => x.name === "鸟笼-成员款")).toBe(true)
  })

  it("编辑已存 PDF 的模板再保存：fileName-only 回填命中库内源，不再报「缺少 PDF 源」", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        guideFile: { fileName: "manual-en.pdf", languages: ["en"], base64: "JVBERi0xLjQ=" },
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // 编辑链路：列表剥离 base64 → 向导只回填 fileName → 更新须在 parse 前注入库内源
    const r = await updatePublishTemplateAction({
      id: created.id,
      name: "鸟笼-标准款-改",
      categoryChain: TEMPLATE_PAYLOAD.categoryChain,
      attributes: TEMPLATE_PAYLOAD.attributes,
      specConfig: TEMPLATE_PAYLOAD.specConfig,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        guideFile: { fileName: "manual-en.pdf", languages: ["en"] },
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 库内 PDF 源沿用（未丢源、未要求重选）
    const [row] = await db
      .select()
      .from(temuPublishTemplates)
      .where(eq(temuPublishTemplates.id, created.id))
    expect(row?.name).toBe("鸟笼-标准款-改")
    expect(row?.defaults.guideFile?.base64).toBe("JVBERi0xLjQ=")
  })
})

describe("发品", () => {
  it("成功：组装锁定层/固定零值主销售规格/specId 引用，落 success 记录", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const fn = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } })
    vi.stubGlobal("fetch", fn)

    const r = await publishFromTemplateAction({
      templateId: created.id,
      storeId,
      overrides: { title: "覆盖标题", declaredPriceFen: 2599 },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.productId).toBe("388095145")

    const calls = fn.mock.calls.filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
    const specCall = calls.find((c) => c.type === "bg.glo.goods.spec.create")!
    expect(specCall.parentSpecId).toBe(1001)
    expect(specCall.specName).toBe("PROBE Navy")

    const add = calls.find((c) => c.type === "bg.glo.goods.add")!
    expect(add.cat1Id).toBe(1464)
    expect(add.cat3Id).toBe(1466)
    expect(add.productName).toBe("覆盖标题") // 覆盖层生效
    // 模板存源 URL，发品时逐张按目标店上传官方图床（mock 上传返回固定 URL）
    expect(add.materialImgUrl).toBe("https://img.kwcdn.com/product/open/test-goods.jpeg")
    expect(add.carouselImageUrls).toEqual(new Array(5).fill("https://img.kwcdn.com/product/open/test-goods.jpeg"))
    const skc = (add.productSkcReqs as Array<Record<string, unknown>>)[0]!
    // 非服饰主销售规格固定零值（实测口径），SKU 规格引用自建 specId
    expect(skc.mainProductSkuSpecReqs).toEqual([{ parentSpecId: 0, parentSpecName: "", specId: 0, specName: "" }])
    const sku = (skc.productSkuReqs as Array<Record<string, unknown>>)[0]!
    expect(sku.supplierPrice).toBe(2599)
    expect(sku.productSkuSpecReqs).toEqual([
      { parentSpecId: 1001, parentSpecName: "颜色", specId: 380724727, specName: "PROBE Navy" },
    ])
    expect(add.productWhExtAttrReq).toEqual({
      outerGoodsUrl: "",
      productOrigin: { countryShortName: "CN", region2Id: 43000000000006 },
    })

    const recs = await listPublishRecordsAction({ templateId: created.id })
    expect(recs.ok).toBe(true)
    if (!recs.ok) return
    const row = recs.rows.find((x) => x.status === "success")
    expect(row?.productId).toBe("388095145")
    // 记录新列：创建人 / 生效商品名 / 实际提交图源
    expect(row?.creatorName).toBe("发品管理员")
    expect(row?.title).toBe("覆盖标题")
    expect(row?.imageUrls).toEqual(TEMPLATE_PAYLOAD.defaults.imageUrls)
  }, 30_000)

  it("四块扩展配置（包装/说明书/定制/SKU分类）随发品提交，未配置块不提交", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        outerPackage: { packageShape: 2, packageType: 1 },
        guideFile: { fileName: "manual.pdf", pdfMaterialId: 2610202676393, languages: ["en"] },
        customized: { firstType: 10001, twiceType: [20001], technologyType: 1 },
        skuPack: { skuClassification: 2, numberOfPieces: 3, pieceUnitCode: 1 },
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } })
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const calls = fn.mock.calls.filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
    const add = calls.find((c) => c.type === "bg.glo.goods.add")!
    expect(add.productOuterPackageReq).toEqual({ packageShape: 2, packageType: 1 })
    expect(add.productGuideFileReqs).toEqual([
      { fileName: "manual.pdf", pdfMaterialId: 2610202676393, languages: ["en"] },
    ])
    expect((add.productSaleExtAttrReq as Record<string, unknown>).customizedTechnologyReq).toEqual({
      firstType: 10001,
      twiceType: [20001],
      technologyType: 1,
    })
    const sku = (add.productSkcReqs as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const skuEntry = (sku.productSkuReqs as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(skuEntry.productSkuMultiPackReq).toMatchObject({
      skuClassification: 2,
      numberOfPieces: 3,
      pieceUnitCode: 1,
      numberOfPiecesNew: 3,
    })
    // 基础模板（无四块）：不提交包装/说明书/定制块
    const plain = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    const fn2 = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } })
    vi.stubGlobal("fetch", fn2)
    await publishFromTemplateAction({ templateId: plain.id, storeId, overrides: {} })
    const add2 = fn2.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    expect(add2.productOuterPackageReq).toBeUndefined()
    expect(add2.productGuideFileReqs).toBeUndefined()
    expect(add2.productSaleExtAttrReq).toBeUndefined()
    const sku2 = (add2.productSkcReqs as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const skuEntry2 = (sku2.productSkuReqs as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(skuEntry2.productSkuMultiPackReq).toMatchObject({ skuClassification: 1, numberOfPieces: 1 })
  }, 30_000)

  it("外包装：无形状=仅类型、包装图按店上传提交；CN 无省份被拒", async () => {
    mockSession.userId = ownerId
    // "其他不规则形状"=不提交 shape，仅类型
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        outerPackage: { packageType: 2 },
        outerPackageImages: [
          "https://img.kwcdn.com/product/open/p1-goods.jpeg",
          "https://img.kwcdn.com/product/open/p2-goods.jpeg",
          "https://img.kwcdn.com/product/open/p3-goods.jpeg",
        ],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } })
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const add = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    expect(add.productOuterPackageReq).toEqual({ packageType: 2 })
    // 包装图按目标店上传（imageBizType=1 私域桶）后随发品提交
    expect(add.productOuterPackageImageReqs).toEqual(new Array(3).fill({ imageUrl: "https://img.kwcdn.com/product/open/test-goods.jpeg" }))
    // ≥1 张包装图即提交（用户口径：只传一张也正常提交）
    const partial = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        outerPackageImages: ["https://img.kwcdn.com/product/open/p1-goods.jpeg"],
      },
    })
    expect(partial.ok).toBe(true)
    if (partial.ok) {
      const fn2 = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } })
      vi.stubGlobal("fetch", fn2)
      await publishFromTemplateAction({ templateId: partial.id, storeId, overrides: {} })
      const add2 = fn2.mock.calls
        .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
        .find((c) => c.type === "bg.glo.goods.add")!
      expect(add2.productOuterPackageImageReqs).toEqual([{ imageUrl: "https://img.kwcdn.com/product/open/test-goods.jpeg" }])
    }
    // CN 不带省份：zod 拒绝（官方实测必填）
    const noProvince = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: (() => {
        const d = { ...TEMPLATE_PAYLOAD.defaults }
        delete (d as { region2Id?: number }).region2Id
        return d
      })(),
    })
    expect(noProvince.ok).toBe(false)
    if (!noProvince.ok) expect(noProvince.error).toContain("省份")
  }, 30_000)

  it("说明书带 PDF 源：发品时对目标店铺重传换新 pdfId，列表响应剥离 base64", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        guideFile: {
          fileName: "manual-en.pdf",
          pdfMaterialId: 111,
          languages: ["en"],
          base64: "JVBERi0xLjQ=",
        },
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // 列表剥离 base64（体积）
    const list = await listPublishTemplatesAction()
    expect(list.ok).toBe(true)
    if (list.ok) {
      const row = list.rows.find((x) => x.id === created.id)
      expect(row?.defaults.guideFile?.base64).toBeUndefined()
      expect(row?.defaults.guideFile?.pdfMaterialId).toBe(111)
    }

    // 发品链路：instructions.upload 在发品时被调（目标店重传），goods.add 用新 pdfId
    const fn = mockPublishFetch({
      "bg.glo.goods.instructions.upload": { result: { pdfId: 2610202728804 } },
      "bg.glo.goods.add": { result: GOODS_ADD_OK },
    })
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const calls = fn.mock.calls.filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
    const reUp = calls.find((c) => c.type === "bg.glo.goods.instructions.upload")!
    expect(reUp.base64File).toBe("JVBERi0xLjQ=")
    const add = calls.find((c) => c.type === "bg.glo.goods.add")!
    expect(add.productGuideFileReqs).toEqual([
      { fileName: "manual-en.pdf", pdfMaterialId: 2610202728804, languages: ["en"] },
    ])
  }, 30_000)

  it("说明书 sourceUrl（新版口径）：发品时服务端取回字节重传换新 pdfId", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        guideFile: {
          fileName: "manual-new.pdf",
          pdfMaterialId: 222,
          languages: ["en"],
          sourceUrl: "https://img.kwcdn.com/manual/manual-new.pdf",
        },
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const fn = mockPublishFetch({
      "bg.glo.goods.instructions.upload": { result: { pdfId: 2610202728805 } },
      "bg.glo.goods.add": { result: GOODS_ADD_OK },
    })
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const calls = fn.mock.calls.filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
    const reUp = calls.find((c) => c.type === "bg.glo.goods.instructions.upload")!
    // 服务端从存储 sourceUrl 取回字节（mock 返回内建 PNG）转 base64 提交
    expect(typeof reUp.base64File).toBe("string")
    expect((reUp.base64File as string).length).toBeGreaterThan(100)
    const add = calls.find((c) => c.type === "bg.glo.goods.add")!
    expect(add.productGuideFileReqs).toEqual([
      { fileName: "manual-new.pdf", pdfMaterialId: 2610202728805, languages: ["en"] },
    ])
  }, 30_000)

  it("素材图上传失败也落发品记录（早退分支可观测性）并带创建人/商品名/图源", async () => {
    mockSession.userId = memberWithPermId
    const created = await createPublishTemplateAction({ ...TEMPLATE_PAYLOAD, name: "鸟笼-失败观测" })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const fn = mockPublishFetch({
      "bg.goods.image.upload.global": { success: false, errorCode: 2000021, errorMsg: "image invalid" },
    })
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({
      templateId: created.id,
      storeId,
      overrides: { title: "失败观测标题" },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("素材图第 1 张上传失败")

    // 此前早退失败不落记录（排障盲区）；现在留痕且新列齐全
    const recs = await listPublishRecordsAction({ templateId: created.id })
    expect(recs.ok).toBe(true)
    if (!recs.ok) return
    const row = recs.rows.find((x) => x.status === "failed")
    expect(row?.errorMsg).toContain("素材图第 1 张上传失败")
    expect(row?.creatorName).toBe("发品页权限成员")
    expect(row?.title).toBe("失败观测标题")
    expect(row?.imageUrls).toEqual(TEMPLATE_PAYLOAD.defaults.imageUrls)
  }, 30_000)

  it("图源 dataUrl 被拒（载荷根治护栏）：模板与发品 overrides 均明确报错", async () => {
    mockSession.userId = ownerId
    const r = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        imageUrls: [
          "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
          ...TEMPLATE_PAYLOAD.defaults.imageUrls.slice(1),
        ],
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("http(s)")

    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const p = await publishFromTemplateAction({
      templateId: created.id,
      storeId,
      overrides: { imageUrls: ["data:image/png;base64,iVBORw0KGgo="] },
    })
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.error).toContain("http(s)")
  })

  it("素材图可空/少于 5 张可建模板，发品时预检拦截（官方最少 5 张）", async () => {
    mockSession.userId = ownerId
    // 空素材：建模板 OK（保存零 TEMU 调用）
    const empty = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: { ...TEMPLATE_PAYLOAD.defaults, imageUrls: [] },
    })
    expect(empty.ok).toBe(true)
    if (empty.ok) {
      const r = await publishFromTemplateAction({ templateId: empty.id, storeId, overrides: {} })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("至少 5 张")
    }
    // 4 张：建模板 OK，发品预检拦截
    const few = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: { ...TEMPLATE_PAYLOAD.defaults, imageUrls: TEMPLATE_PAYLOAD.defaults.imageUrls.slice(0, 4) },
    })
    expect(few.ok).toBe(true)
    if (few.ok) {
      const r = await publishFromTemplateAction({ templateId: few.id, storeId, overrides: {} })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("至少 5 张")
    }
  }, 30_000)

  it("轮播合计口径（新弹窗契约）：4 素材 + 第 2 位尺寸图 = 5 张过预检且顺序还原", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } })
    vi.stubGlobal("fetch", fn)
    // 新弹窗提交契约：imageUrls = 完整列表去掉第 2 张；dimensionImageUrl = 第 2 张
    const all = TEMPLATE_PAYLOAD.defaults.imageUrls
    const r = await publishFromTemplateAction({
      templateId: created.id,
      storeId,
      overrides: {
        imageUrls: [all[0]!, ...all.slice(2)],
        dimensionImageUrl: all[1]!,
      },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const calls = fn.mock.calls.filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
    const add = calls.find((c) => c.type === "bg.glo.goods.add")!
    expect((add.carouselImageUrls as unknown[]).length).toBe(5)
  }, 30_000)

  it("说明书 PDF 上传：sourceUrl 取回字节换 pdfId", async () => {
    mockSession.userId = ownerId
    const fn = mockPublishFetch({
      "bg.glo.goods.instructions.upload": { result: { pdfId: 2610202676393 } },
    })
    vi.stubGlobal("fetch", fn)
    const r = await uploadPublishGuideFileAction({
      sourceUrl: "https://img.kwcdn.com/manual/test.pdf",
      fileName: "manual.pdf",
    })
    expect(r.ok).toBe(true)
    const up = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.instructions.upload")!
    // sourceUrl 取回字节（mock 无 body 调用返回内建 PNG）→ base64 提交官方
    expect(typeof up.base64File).toBe("string")
    expect((up.base64File as string).length).toBeGreaterThan(0)
    if (!r.ok) return
    expect(r.pdfMaterialId).toBe(2610202676393)
    // 无商品发布页权限的成员被拒（页面权限口径）
    mockSession.userId = memberId
    const r2 = await uploadPublishGuideFileAction({
      sourceUrl: "https://img.kwcdn.com/manual/m.pdf",
      fileName: "m.pdf",
    })
    expect(r2.ok).toBe(false)
  })

  it("官方拒绝（如外包装照片）：ok=false 且错误落记录", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    if (!created.ok) return
    vi.stubGlobal(
      "fetch",
      mockPublishFetch({
        "bg.glo.goods.add": {
          success: false,
          errorCode: 1000002,
          errorMsg: "Outer package image is required",
        },
      }),
    )
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("Outer package image")
    const recs = await listPublishRecordsAction({})
    expect(recs.ok).toBe(true)
    if (!recs.ok) return
    const row = recs.rows.find((x) => x.status === "failed")
    expect(row?.errorCode).toBe(1000002)
    expect(row?.errorMsg).toContain("Outer package")
  }, 30_000)

  it("无商品发布页权限的成员不能发品（页面权限口径）", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    mockSession.userId = memberId
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("页面权限")
  })
})

describe("素材上传", () => {
  it("800×800 合规图上传成功并做牛皮癣检测", async () => {
    mockSession.userId = ownerId
    const fn = mockPublishFetch()
    vi.stubGlobal("fetch", fn)
    // 图源须命中回拉白名单（防 SSRF）：平台图库走 myqcloud.com COS 域
    const r = await uploadPublishImageAction({ imageUrl: "https://gallery.cos.ap-guangzhou.myqcloud.com/a.png" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.image.temuUrl).toContain("kwcdn.com")
    expect(r.image.hasSpot).toBe(false)
  })

  it("非 1:1 图被本地预校验拒绝（不触达官方接口）", async () => {
    mockSession.userId = ownerId
    const buf = buildPng(900, 800)
    const fn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map([["content-type", "image/png"]]),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      }) as unknown as Response,
    )
    vi.stubGlobal("fetch", fn)
    const r = await uploadPublishImageAction({ imageUrl: "https://gallery.cos.ap-guangzhou.myqcloud.com/b.png" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("1:1")
    // 本地预校验直接拒绝，未发起任何官方 API 调用（仅一次图片拉取）
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("官方图片工具（压缩 / 尺寸图校验）", () => {
  it("高清压缩：results 映射；非官方图床错误转友好提示", async () => {
    mockSession.userId = ownerId
    const fn = mockPublishFetch({
      "bg.glo.picturecompression.get": {
        result: {
          results: [
            {
              originUrl: "https://img.kwcdn.com/product/open/a-goods.jpeg",
              resultUrl: "https://img.kwcdn.com/product/fancy/out.jpg",
              width: 800,
              height: 800,
              size: 10630,
            },
          ],
        },
      },
    })
    vi.stubGlobal("fetch", fn)
    const r = await compressTemuImagesAction({ urls: ["https://img.kwcdn.com/product/open/a-goods.jpeg"] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.results).toEqual([
      {
        originUrl: "https://img.kwcdn.com/product/open/a-goods.jpeg",
        resultUrl: "https://img.kwcdn.com/product/fancy/out.jpg",
        width: 800,
        height: 800,
        size: 10630,
      },
    ])
    // 入参带 urls 数组
    const body = JSON.parse(String(fn.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body.urls).toEqual(["https://img.kwcdn.com/product/open/a-goods.jpeg"])

    // 外链被算法服务拒（实测 100100000）→ 提示仅支持官方图床
    vi.stubGlobal(
      "fetch",
      mockPublishFetch({
        "bg.glo.picturecompression.get": {
          success: false,
          errorCode: 100100000,
          errorMsg: "[EX-GeneralCropAlgo-9] :GRPC call failed",
        },
      }),
    )
    const bad = await compressTemuImagesAction({ urls: ["https://example.com/x.jpg"] })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain("官方图床")
  })

  it("尺寸图校验：两段式（提交→轮询），识别完成返回结论", async () => {
    mockSession.userId = ownerId
    const fn = mockPublishFetch({
      "bg.algo.dimension.image.check": { result: { errorCode: 0, uniqueId: "u-123", errorMsg: "success" } },
      "bg.algo.dimension.image.check.result": {
        result: { imageUrl: "x", errorCode: 0, imageType: 1, uniqueId: "u-123", errorMsg: "success" },
      },
    })
    vi.stubGlobal("fetch", fn)
    const r = await checkTemuDimensionImageAction({ imageUrl: "https://img.kwcdn.com/product/open/a-goods.jpeg" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.status).toBe("done")
    expect(r.result.imageType).toBe(1)
    // 轮询带 uniqueId
    const resultCall = fn.mock.calls
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.algo.dimension.image.check.result")!
    expect(resultCall.uniqueId).toBe("u-123")
  })

  it("尺寸图校验：内层 5000000 持续检测中 → 返回 processing", async () => {
    mockSession.userId = ownerId
    vi.stubGlobal(
      "fetch",
      mockPublishFetch({
        "bg.algo.dimension.image.check": { result: { errorCode: 0, uniqueId: "u-456", errorMsg: "success" } },
        "bg.algo.dimension.image.check.result": {
          result: { imageUrl: null, errorCode: 5000000, imageType: null, uniqueId: null, errorMsg: "图片检测中，请重试" },
        },
      }),
    )
    const r = await checkTemuDimensionImageAction({ imageUrl: "https://img.kwcdn.com/product/open/a-goods.jpeg" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.status).toBe("processing")
  }, 20_000)
})

describe("尺寸图随发品（固定轮播第 2 张）", () => {
  it("配置尺寸图：按目标店上传后插入 carousel[1]，素材图顺序不变", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: {
        ...TEMPLATE_PAYLOAD.defaults,
        dimensionImageUrl: "https://img.kwcdn.com/product/open/dim-goods.jpeg",
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } }, true)
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const add = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    const carousel = add.carouselImageUrls as string[]
    // 素材 5 张（up1..up5）+ 尺寸图（第 6 次上传）插到第 2 张
    expect(carousel).toHaveLength(6)
    expect(carousel[0]).toBe("https://img.kwcdn.com/product/open/up1-goods.jpeg")
    expect(carousel[1]).toBe("https://img.kwcdn.com/product/open/up6-goods.jpeg")
    expect(carousel[2]).toBe("https://img.kwcdn.com/product/open/up2-goods.jpeg")
    // 素材图/缩略仍取第一张素材
    expect(add.materialImgUrl).toBe("https://img.kwcdn.com/product/open/up1-goods.jpeg")
  }, 30_000)

  it("未配置尺寸图：轮播与素材一致（5 张无插入）", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch({ "bg.glo.goods.add": { result: GOODS_ADD_OK } }, true)
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const add = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    expect(add.carouselImageUrls).toHaveLength(5)
  }, 30_000)
})

describe("发品图片链路（官方压缩 / 尺寸图覆盖）", () => {
  it("上传体积 >1MB 的素材批量官方压缩换 fancy URL（失败回落原图）", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // 噪声图 ~1.9MB：过 2M 上传闸门、触发 >1MB 官方压缩
    const fn = mockPublishFetch(
      {
        "bg.glo.picturecompression.get": {
          result: {
            results: [
            {
              originUrl: "https://img.kwcdn.com/product/open/up1-goods.jpeg",
              resultUrl: "https://img.kwcdn.com/product/fancy/c1.jpg",
              width: 800,
              height: 800,
              size: 90000,
            }],
          },
        },
        "bg.glo.goods.add": { result: GOODS_ADD_OK },
      },
      true,
      buildPngNoise(800, 800),
    )
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const add = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    const carousel = add.carouselImageUrls as string[]
    // up1 命中压缩映射换 fancy；其余回落原图
    expect(carousel[0]).toBe("https://img.kwcdn.com/product/fancy/c1.jpg")
    expect(carousel.slice(1)).toEqual([
      "https://img.kwcdn.com/product/open/up2-goods.jpeg",
      "https://img.kwcdn.com/product/open/up3-goods.jpeg",
      "https://img.kwcdn.com/product/open/up4-goods.jpeg",
      "https://img.kwcdn.com/product/open/up5-goods.jpeg",
    ])
    // 压缩批量入参带全部超限 URL
    const comp = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.picturecompression.get")!
    expect(comp.urls).toHaveLength(5)
  }, 30_000)

  it("官方压缩接口失败回落原图不阻断发品", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction(TEMPLATE_PAYLOAD)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch(
      {
        "bg.glo.picturecompression.get": { success: false, errorCode: 100100000, errorMsg: "GRPC call failed" },
        "bg.glo.goods.add": { result: GOODS_ADD_OK },
      },
      true,
      buildPngNoise(800, 800),
    )
    vi.stubGlobal("fetch", fn)
    const r = await publishFromTemplateAction({ templateId: created.id, storeId, overrides: {} })
    expect(r.ok).toBe(true)
    const add = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    expect(add.carouselImageUrls).toEqual([
      "https://img.kwcdn.com/product/open/up1-goods.jpeg",
      "https://img.kwcdn.com/product/open/up2-goods.jpeg",
      "https://img.kwcdn.com/product/open/up3-goods.jpeg",
      "https://img.kwcdn.com/product/open/up4-goods.jpeg",
      "https://img.kwcdn.com/product/open/up5-goods.jpeg",
    ])
  }, 30_000)

  it("尺寸图覆盖层优先于模板；校验结论随发品结果返回（advisory）", async () => {
    mockSession.userId = ownerId
    const created = await createPublishTemplateAction({
      ...TEMPLATE_PAYLOAD,
      defaults: { ...TEMPLATE_PAYLOAD.defaults, dimensionImageUrl: "https://img.kwcdn.com/product/open/tpl-dim.jpeg" },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const fn = mockPublishFetch(
      {
        "bg.algo.dimension.image.check": { result: { errorCode: 0, uniqueId: "u-pub", errorMsg: "success" } },
        "bg.algo.dimension.image.check.result": {
          result: { imageUrl: "x", errorCode: 0, imageType: 1, uniqueId: "u-pub", errorMsg: "success" },
        },
        "bg.glo.goods.add": { result: GOODS_ADD_OK },
      },
      true,
    )
    vi.stubGlobal("fetch", fn)
    // 覆盖层尺寸图优先（第 6 次上传=尺寸图）
    const r = await publishFromTemplateAction({
      templateId: created.id,
      storeId,
      overrides: { dimensionImageUrl: "https://img.kwcdn.com/product/open/ovr-dim.jpeg" },
    })
    expect(r.ok).toBe(true)
    expect(r.dimensionCheck).toEqual({ status: "done", imageType: 1, message: "success" })
    const add = fn.mock.calls
      .filter((c) => c[1]?.body)
      .map((c) => JSON.parse(String(c[1]!.body)) as Record<string, unknown>)
      .find((c) => c.type === "bg.glo.goods.add")!
    const carousel = add.carouselImageUrls as string[]
    expect(carousel[1]).toBe("https://img.kwcdn.com/product/open/up6-goods.jpeg")
  }, 30_000)
})
