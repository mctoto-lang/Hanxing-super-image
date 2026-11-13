import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  enterprises,
  permissionGroups,
  users,
  temuStores,
  temuProducts,
  temuSalesOverviews,
  temuPriorityLinks,
  inventoryProducts,
  inventoryStocks,
  inventoryWarehouses,
  inventoryMovements,
  temuShipOrders,
  temuApps,
} from "@/db/schema"
import { MODULE_NAMES } from "@/db/schema/_shared"
import { encrypt } from "@/lib/crypto"
import { createHash } from "node:crypto"
import { temuDayStr } from "@/server/services/temu-time"
import {
  getTemuProductsAction,
  getPriorityShipLinksAction,
  getTemuSettingsAction,
  setPriorityShipAction,
  unsetPriorityShipAction,
  getStopReplenishLinksAction,
  setStopReplenishAction,
  unsetStopReplenishAction,
  updateTemuStagnantSettingsAction,
} from "@/server/actions/temu"
import {
  getTemuSyncShipOrdersAction,
  syncTemuShipDeductAction,
} from "@/server/actions/temu-ship"

/**
 * 商品信息页三项操作回归（2026-11-09 批次）：
 * 1) 优先发货链接标记（本地表 set/get/unset + 隔离）
 * 2) 热销/滞销筛选（salesv2 hotTag / 窗口日销量合计 ≤ 阈值；无销售行不判滞销）
 * 3) TEMU 发货单同步扣减（幂等 per 单号、库存缺口预检整体不动、factoryDirect 排除）
 */

const mockSession = vi.hoisted(() => ({ userId: null as string | null }))
/** bg.shiporderv2.get 请求体审计（fresh 调用计数/裸查 vs 回查断言用） */
const shipBodies = vi.hoisted(() => [] as Array<{ deliveryOrderSnList?: string[] }>)

/** shiporderv2 最小行（对照 temu-sync.ts upsertShipOrderRows 映射裁剪；upsert 为
 *  幂等全列覆盖——回写行必须带齐 deliverTime/status 等关键字段，否则会把本地行抹空） */
const SHIP_ROW_MIN = (over: Partial<Record<string, unknown>> = {}) => ({
  deliveryOrderSn: "POPSX",
  subPurchaseOrderSn: "SUBX",
  productSkcId: 4015,
  skcExtCode: "B9200",
  status: 1,
  deliverSkcNum: 3,
  deliveryAddressId: 501,
  deliveryOrderCreateTime: Date.now(),
  deliverTime: Date.now(),
  receiveTime: null,
  ...over,
})
vi.mock("@/lib/auth/config", () => ({
  auth: async () =>
    mockSession.userId ? { user: { id: mockSession.userId } } : null,
}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/services/temu-cache", () => ({
  temuCached: (_key: string, load: () => Promise<unknown>) => load(),
  invalidateTemuCache: () => {},
}))
// 发货仓库标签加载（getTemuCallContext）需要企业级应用凭证——测试企业未配置，固定注入
vi.mock("@/lib/temu-api/app-config", () => ({
  getTemuAppCredential: async () => ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    source: "test",
  }),
}))

let entId: string
let userId: string
let storeId: string
let store2Id: string
let mainWhId: string

const hash = (s: string) => createHash("sha1").update(s).digest("hex")

beforeAll(async () => {
  // 发货仓库标签加载走 mock fetch：bg.mall.address.get 返回地址标签夹具（501=义乌国际仓）；
  // bg.shiporderv2.get 按请求体分发（无 deliveryOrderSnList=裸查最新一页→新单 POPS6；
  // 带名单=单号回查→POPS2 缺席模拟官方已移除）；其余官方 type 返回空——不打真实官方接口
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        type: string
        deliveryOrderSnList?: string[]
      }
      let result: unknown
      if (body.type === "bg.mall.address.get") {
        result = [{ id: 501, addressLabel: "义乌国际仓" }]
      } else if (body.type === "bg.shiporderv2.get") {
        shipBodies.push(body)
        if (body.deliveryOrderSnList) {
          const present = body.deliveryOrderSnList.filter((sn) => sn !== "POPS2")
          result = { total: present.length, list: present.map((sn) => SHIP_ROW_MIN({ deliveryOrderSn: sn })) }
        } else {
          result = { total: 1, list: [SHIP_ROW_MIN({ deliveryOrderSn: "POPS6", deliverSkcNum: 7 })] }
        }
      } else {
        result = {}
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result, success: true, errorCode: 1000000, errorMsg: "" }),
      } as unknown as Response
    }),
  )

  const [ent] = await db
    .insert(enterprises)
    .values({
      name: "商品操作测试企业",
      slug: `pops-${randomUUID().slice(0, 8)}`,
      creditsBalance: 0,
      enabledModules: [...MODULE_NAMES],
    })
    .returning()
  entId = ent!.id
  // 多应用模型（0097）：凭证按「店铺→应用」取——夹具企业配一个应用
  // （店铺不挂靠时单应用宽容回落命中）
  await db
    .insert(temuApps)
    .values({ enterpriseId: entId, name: "测试应用", appKey: "test-app", appSecretEncrypted: "enc:v1:t" })
  const [group] = await db
    .insert(permissionGroups)
    .values({
      enterpriseId: entId,
      name: "商品操作权限组",
      allowedPages: ["settings", "temu", "inventory"],
    })
    .returning()
  const [user] = await db
    .insert(users)
    .values({
      enterpriseId: entId,
      groupId: group!.id,
      username: `pops-${randomUUID().slice(0, 8)}`,
      email: `pops-${randomUUID().slice(0, 8)}@test.local`,
      name: "商品操作用户",
      passwordHash: "x",
      enterpriseRole: "owner",
    })
    .returning()
  userId = user!.id
  mockSession.userId = userId

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "商品操作测试店",
      accessTokenEncrypted: encrypt("pops-test-token"),
      tokenState: "active",
      mallType: "full",
    })
    .returning()
  storeId = store!.id

  // 商品：A=滞销候选（有销售行零销量）、B=热销候选、C=无销售行（不判滞销）
  await db.insert(temuProducts).values([
    { storeId, productSkcId: "POPSA", productId: "PPA", productSn: "B9101", productName: "滞销款", skcStatus: 1 },
    { storeId, productSkcId: "POPSB", productId: "PPB", productSn: "B9102", productName: "热销款", skcStatus: 1 },
    { storeId, productSkcId: "POPSC", productId: "PPC", productSn: "B9103", productName: "无数据款", skcStatus: 1 },
  ])

  const day = temuDayStr()
  const now = new Date()
  await db.insert(temuSalesOverviews).values([
    { storeId, skcId: "POPSA", capturedAt: now, capturedDay: day, contentHash: hash("a"), productSn: "B9101", todaySalesVolume: 0 },
    { storeId, skcId: "POPSB", capturedAt: now, capturedDay: day, contentHash: hash("b"), productSn: "B9102", todaySalesVolume: 7, overview: { hotTag: true } },
  ])

  // 库存：主仓 + 档案 B9200（10 件）——同步扣减用
  await db
    .insert(inventoryWarehouses)
    .values([{ enterpriseId: entId, code: "main", name: "主仓", sort: 0 }])
  const [wh] = await db
    .select()
    .from(inventoryWarehouses)
    .where(and(eq(inventoryWarehouses.enterpriseId, entId), eq(inventoryWarehouses.code, "main")))
  mainWhId = wh!.id
  const [prod] = await db
    .insert(inventoryProducts)
    .values({ enterpriseId: entId, productCode: "B9200", name: "同步扣减测试款", createdBy: userId })
    .returning()
  await db
    .insert(inventoryStocks)
    .values({ enterpriseId: entId, productId: prod!.id, warehouseId: mainWhId, qty: 10 })

  // 第二店铺：跨店重复单用（同主体多店 token 会拉到同一物理发货单各落一行）；
  // 带 token——发货仓库标签按店加载，两店命中同一地址夹具保证 501 标签确定性
  const [store2] = await db
    .insert(temuStores)
    .values({
      enterpriseId: entId,
      name: "商品操作测试店2",
      accessTokenEncrypted: encrypt("pops-test-token2"),
      tokenState: "active",
    })
    .returning()
  store2Id = store2!.id

  // 发货单：S1 可扣（4 件）、S2 缺口（99 件）、S3 工厂直发（不参与）；
  // deliveryAddressId：S1/S4/S5=501（夹具命中义乌国际仓）、S2=502（无夹具降级「地址 502」）
  await db.insert(temuShipOrders).values([
    { storeId, deliveryOrderSn: "POPS1", subPurchaseOrderSn: "SUBS1", skcExtCode: "B9200", status: 1, deliverSkcNum: 4, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s1"), capturedAt: now },
    // POPS2 创建时间 3 小时前（fresh 收敛样本：官方回查缺席 + 超 30 分钟 + status=1 → 置已取消）
    { storeId, deliveryOrderSn: "POPS2", subPurchaseOrderSn: "SUBS2", skcExtCode: "B9200", status: 1, deliverSkcNum: 99, deliverTime: now, deliveryAddressId: 502, deliveryOrderCreateTime: new Date(now.getTime() - 3 * 3600_000), contentHash: hash("s2"), capturedAt: now },
    { storeId, deliveryOrderSn: "POPS3", subPurchaseOrderSn: "SUBS3", skcExtCode: "B9200", status: 1, deliverSkcNum: 5, deliverTime: now, factoryDirect: true, contentHash: hash("s3"), capturedAt: now },
    // 跨店重复：POPS4 在两店各一行（captured_at 错开 1ms，store2 更新——列表应只留 store2 行）
    { storeId, deliveryOrderSn: "POPS4", subPurchaseOrderSn: "SUBS4", skcExtCode: "B9200", status: 1, deliverSkcNum: 2, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s4a"), capturedAt: now },
    { storeId: store2Id, deliveryOrderSn: "POPS4", subPurchaseOrderSn: "SUBS4", skcExtCode: "B9200", status: 1, deliverSkcNum: 2, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s4b"), capturedAt: new Date(now.getTime() + 1) },
    // 已收货行（status=2，收货仓库/物流字段）：默认「待出库」不含、done 筛选含
    { storeId, deliveryOrderSn: "POPS5", subPurchaseOrderSn: "SUBS5", skcExtCode: "B9200", status: 2, deliverSkcNum: 3, deliverTime: now, receiveTime: now, deliveryAddressId: 501, subWarehouseName: "广州中心仓", expressCompany: "极兔速递", expressDeliverySn: "JT888888", contentHash: hash("s5"), capturedAt: now },
  ])
}, 60_000)

afterAll(async () => {
  // users.enterpriseId 为 set null 不级联，需先删成员（含测试中途插入的 u2/u3）
  await db.delete(users).where(eq(users.enterpriseId, entId))
  await db.delete(enterprises).where(eq(enterprises.id, entId))
  vi.unstubAllGlobals()
})

describe("优先发货链接标记", () => {
  it(
    "set/get/unset 闭环；跨企业隔离（别的店铺 id 拒绝）",
    { timeout: 30_000 },
    async () => {
      const bad = await setPriorityShipAction({ storeId: randomUUID(), productSkcId: "POPSA" })
      expect(bad.ok).toBe(false)

      const s = await setPriorityShipAction({
        storeId,
        productSkcId: "POPSA",
        productSn: "B9101",
        productName: "滞销款",
      })
      expect(s.ok).toBe(true)
      // 幂等重设不炸（唯一约束 upsert）
      const s2 = await setPriorityShipAction({ storeId, productSkcId: "POPSA" })
      expect(s2.ok).toBe(true)

      const got = await getPriorityShipLinksAction(storeId)
      expect(gtSkc(got.skcIds)).toContain("POPSA")

      const u = await unsetPriorityShipAction({ storeId, productSkcId: "POPSA" })
      expect(u.ok).toBe(true)
      const got2 = await getPriorityShipLinksAction(storeId)
      expect(gtSkc(got2.skcIds)).not.toContain("POPSA")
    },
  )
})

function gtSkc(ids: string[]): string[] {
  return ids.map(String)
}

describe("停止补货链接标记（迁移 0098）", () => {
  it(
    "set/get/unset 闭环 + 幂等重设；跨企业店铺拒绝；与优先发货标记互不干扰",
    { timeout: 30_000 },
    async () => {
      // 随机店铺 id（非本企业）拒绝写
      const bad = await setStopReplenishAction({ storeId: randomUUID(), productSkcId: "STOPA" })
      expect(bad.ok).toBe(false)

      const s = await setStopReplenishAction({
        storeId,
        productSkcId: "STOPA",
        productSn: "B9301",
        productName: "停补款",
      })
      expect(s.ok).toBe(true)
      // 幂等重设不炸（唯一约束 upsert，只更新快照字段）
      const s2 = await setStopReplenishAction({ storeId, productSkcId: "STOPA", productSn: "B9301R" })
      expect(s2.ok).toBe(true)

      const got = await getStopReplenishLinksAction(storeId)
      expect(gtSkc(got.skcIds)).toContain("STOPA")

      // 与优先发货标记独立：stop 集合不含优先标记、priority 集合不含 stop 标记
      const pri = await getPriorityShipLinksAction(storeId)
      expect(gtSkc(pri.skcIds)).not.toContain("STOPA")

      const u = await unsetStopReplenishAction({ storeId, productSkcId: "STOPA" })
      expect(u.ok).toBe(true)
      const got2 = await getStopReplenishLinksAction(storeId)
      expect(gtSkc(got2.skcIds)).not.toContain("STOPA")

      // 无 temu 权限拒绝写（宽口径同优先发货）
      const [g2] = await db
        .insert(permissionGroups)
        .values({ enterpriseId: entId, name: `无 TEMU 权限组-${randomUUID().slice(0, 8)}`, allowedPages: ["settings"] })
        .returning()
      const [u2] = await db
        .insert(users)
        .values({
          enterpriseId: entId,
          groupId: g2!.id,
          username: `stop-${randomUUID().slice(0, 8)}`,
          email: `stop-${randomUUID().slice(0, 8)}@test.local`,
          name: "无 TEMU 权限成员",
          passwordHash: "x",
          enterpriseRole: "member",
        })
        .returning()
      mockSession.userId = u2!.id
      const d1 = await setStopReplenishAction({ storeId, productSkcId: "STOPB" })
      expect(d1.ok).toBe(false)
      if (!d1.ok) expect(d1.error).toContain("TEMU")
      const d2 = await unsetStopReplenishAction({ storeId, productSkcId: "STOPA" })
      expect(d2.ok).toBe(false)
      // 拒绝写不落库
      const got3 = await getStopReplenishLinksAction(storeId)
      expect(gtSkc(got3.skcIds)).not.toContain("STOPB")
      // 还原 owner 会话
      mockSession.userId = userId
    },
  )
})

describe("操作类写操作权限（TEMU 页可见即可用，2026-11-11 口径）", () => {
  it(
    "无 temu 页面权限的成员三写全拒且不落库；有 temu 权限的普通成员可用",
    { timeout: 30_000 },
    async () => {
      // 同企业第二权限组（allowedPages 不含 temu）+ 普通成员：三个写操作全拒
      const [g2] = await db
        .insert(permissionGroups)
        .values({ enterpriseId: entId, name: "无 TEMU 权限组", allowedPages: ["settings"] })
        .returning()
      const [u2] = await db
        .insert(users)
        .values({
          enterpriseId: entId,
          groupId: g2!.id,
          username: `pops-${randomUUID().slice(0, 8)}`,
          email: `pops-${randomUUID().slice(0, 8)}@test.local`,
          name: "无 TEMU 权限成员",
          passwordHash: "x",
          enterpriseRole: "member",
        })
        .returning()
      mockSession.userId = u2!.id
      const d1 = await setPriorityShipAction({ storeId, productSkcId: "POPSA" })
      expect(d1.ok).toBe(false)
      if (!d1.ok) expect(d1.error).toContain("TEMU")
      const d2 = await unsetPriorityShipAction({ storeId, productSkcId: "POPSA" })
      expect(d2.ok).toBe(false)
      const d3 = await updateTemuStagnantSettingsAction({ stagnantThresholdQty: 99 })
      expect(d3.ok).toBe(false)
      // 拒绝写不落库：阈值保持默认 0
      const cfg = await getTemuSettingsAction()
      expect(cfg.stagnantThresholdQty).toBe(0)

      // 有 temu 页面权限的普通成员（非管理员）三写可用——宽口径回归锁
      const [g3] = await db
        .insert(permissionGroups)
        .values({ enterpriseId: entId, name: "TEMU 成员权限组", allowedPages: ["settings", "temu"] })
        .returning()
      const [u3] = await db
        .insert(users)
        .values({
          enterpriseId: entId,
          groupId: g3!.id,
          username: `pops-${randomUUID().slice(0, 8)}`,
          email: `pops-${randomUUID().slice(0, 8)}@test.local`,
          name: "TEMU 普通成员",
          passwordHash: "x",
          enterpriseRole: "member",
        })
        .returning()
      mockSession.userId = u3!.id
      const a1 = await setPriorityShipAction({ storeId, productSkcId: "POPSB", productSn: "B9102" })
      expect(a1.ok).toBe(true)
      const a2 = await unsetPriorityShipAction({ storeId, productSkcId: "POPSB" })
      expect(a2.ok).toBe(true)
      const a3 = await updateTemuStagnantSettingsAction({ stagnantWindowDays: 30, stagnantThresholdQty: 0 })
      expect(a3.ok).toBe(true)

      // 还原会话为 owner，后续用例不受影响
      mockSession.userId = userId
    },
  )
})

describe("热销/滞销筛选", () => {
  it(
    "hot=最新批次 hotTag；stagnant=窗口合计 ≤ 阈值且无销售行不判",
    { timeout: 30_000 },
    async () => {
      // 阈值显式设 0（等价默认）：零销量判滞销
      const cfg = await updateTemuStagnantSettingsAction({ stagnantWindowDays: 30, stagnantThresholdQty: 0 })
      expect(cfg.ok).toBe(true)

      const hot = await getTemuProductsAction(storeId, undefined, 1, "hot", "listed")
      const hotIds = hot.rows.map((r) => r.productSkcId)
      expect(hotIds).toContain("POPSB")
      expect(hotIds).not.toContain("POPSA")

      const stagnant = await getTemuProductsAction(storeId, undefined, 1, "stagnant", "listed")
      const stIds = stagnant.rows.map((r) => r.productSkcId)
      expect(stIds).toContain("POPSA")
      expect(stIds).not.toContain("POPSB")
      // 无销售行的 C 不判滞销
      expect(stIds).not.toContain("POPSC")

      // 阈值改 5：A(0) 与 B(7) 中仅 A 滞销——阈值生效回归
      await updateTemuStagnantSettingsAction({ stagnantThresholdQty: 5 })
      const stagnant2 = await getTemuProductsAction(storeId, undefined, 1, "stagnant", "listed")
      expect(stagnant2.rows.map((r) => r.productSkcId)).toContain("POPSA")
      await updateTemuStagnantSettingsAction({ stagnantThresholdQty: 0 })
    },
  )
})

describe("TEMU 发货单同步扣减", () => {
  it(
    "列表标注 synced/排除工厂直发；缺口预检整体不动；扣减幂等",
    { timeout: 30_000 },
    async () => {
      const day = temuDayStr()
      const list = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day })
      expect(list.ok).toBe(true)
      if (!list.ok) return
      const sns = list.rows.map((r) => r.deliveryOrderSn)
      expect(sns).toContain("POPS1")
      expect(sns).toContain("POPS2")
      // 工厂直发单不参与
      expect(sns).not.toContain("POPS3")
      expect(list.rows.every((r) => !r.synced)).toBe(true)
      // 行内嵌库存合计（B9200 档案主仓 10 件；未建档货号为 0）
      const s1row = list.rows.find((r) => r.deliveryOrderSn === "POPS1")
      expect(s1row?.totalQty).toBe(10)

      // S1+S2 一起：S2 缺口（99 > 10）→ 整体不动、返回缺口明细
      const short = await syncTemuShipDeductAction({
        orders: [
          { storeId, sn: "POPS1" },
          { storeId, sn: "POPS2" },
        ],
      })
      expect(short.ok).toBe(false)
      if (!short.ok) {
        expect(short.error).toContain("B9200")
        expect(short.shortages?.[0]?.needed).toBe(103)
      }
      const stockAfterShort = await mainQty()
      expect(stockAfterShort).toBe(10)

      // 只扣 S1：库存 10→6，流水 reason=人工核对
      const ok1 = await syncTemuShipDeductAction({ orders: [{ storeId, sn: "POPS1" }] })
      expect(ok1.ok).toBe(true)
      expect(await mainQty()).toBe(6)
      const [mv] = await db
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.refId, "POPS1"), eq(inventoryMovements.type, "ship_deduct")))
        .limit(1)
      expect(mv?.reason).toBe("TEMU 后台发货人工核对扣减")

      // 幂等：重复同步同单不再扣
      const ok2 = await syncTemuShipDeductAction({ orders: [{ storeId, sn: "POPS1" }] })
      expect(ok2.ok).toBe(true)
      if (ok2.ok) expect(ok2.deducted).toBe(0)
      expect(await mainQty()).toBe(6)

      // 列表状态刷新：S1 已扣、S2 未扣
      const list2 = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day })
      if (list2.ok) {
        const bySn = new Map(list2.rows.map((r) => [r.deliveryOrderSn, r]))
        expect(bySn.get("POPS1")?.synced).toBe(true)
        expect(bySn.get("POPS2")?.synced).toBe(false)
      }
    },
  )
})

describe("跨店同单号去重", () => {
  it(
    "列表每单只留 captured_at 最新一行的店；同步去重后只扣一次",
    { timeout: 30_000 },
    async () => {
      const day = temuDayStr()
      const list = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day })
      expect(list.ok).toBe(true)
      if (!list.ok) return
      const pops4 = list.rows.filter((r) => r.deliveryOrderSn === "POPS4")
      expect(pops4.length).toBe(1)
      expect(pops4[0]!.storeId).toBe(store2Id)

      // 同步传两店同单（防御性场景）：只扣一次（库存 6 → 4）
      const before = await mainQty()
      const r = await syncTemuShipDeductAction({
        orders: [
          { storeId, sn: "POPS4" },
          { storeId: store2Id, sn: "POPS4" },
        ],
      })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.deducted).toBe(1)
      expect(await mainQty()).toBe(before - 2)
    },
  )
})

describe("发货出库筛选", () => {
  it(
    "默认待出库不含已收货单；done 筛选返回且带状态/物流字段",
    { timeout: 30_000 },
    async () => {
      const day = temuDayStr()
      const def = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day })
      if (!def.ok) throw new Error(def.error)
      expect(def.rows.map((r) => r.deliveryOrderSn)).not.toContain("POPS5")

      const done = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day, statusGroup: "done" })
      if (!done.ok) throw new Error(done.error)
      const s5 = done.rows.find((r) => r.deliveryOrderSn === "POPS5")
      expect(s5).toBeTruthy()
      expect(s5?.statusLabel).toBe("已收货")
      expect(s5?.subWarehouseName).toBe("广州中心仓")
      expect(s5?.expressCompany).toBe("极兔速递")
      expect(s5?.expressDeliverySn).toBe("JT888888")
      expect(s5?.receiveTime).toBeTruthy()
    },
  )
})

describe("发货仓库筛选与店铺列", () => {
  it(
    "行带店铺名/发货仓库标签（夹具命中与降级）；warehouses 选项随筛选收缩且不随已选仓库收缩",
    { timeout: 30_000 },
    async () => {
      const day = temuDayStr()
      const list = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day })
      if (!list.ok) throw new Error(list.error)
      const bySn = new Map(list.rows.map((r) => [r.deliveryOrderSn, r]))
      // 店铺名：跨店去重后 POPS4 归属店 2
      expect(bySn.get("POPS1")?.storeName).toBe("商品操作测试店")
      expect(bySn.get("POPS4")?.storeName).toBe("商品操作测试店2")
      // 发货仓库标签：501 夹具命中、502 降级「地址 {id}」
      expect(bySn.get("POPS1")?.deliveryAddressId).toBe(501)
      expect(bySn.get("POPS1")?.deliveryAddressLabel).toBe("义乌国际仓")
      expect(bySn.get("POPS2")?.deliveryAddressLabel).toBe("地址 502")
      // 选项 = 当前结果中出现过的地址（501 跨店两行去重合并），label zh-CN 排序
      expect(list.warehouses).toEqual([
        { id: 502, label: "地址 502" },
        { id: 501, label: "义乌国际仓" },
      ])

      // warehouseId 过滤：502 → 仅 POPS2；选项先于仓库过滤计算、不随已选仓库收缩
      const w2 = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day, warehouseId: 502 })
      if (!w2.ok) throw new Error(w2.error)
      expect(w2.rows.map((r) => r.deliveryOrderSn)).toEqual(["POPS2"])
      expect(w2.total).toBe(1)
      expect(w2.warehouses.map((w) => w.id).sort((a, b) => a - b)).toEqual([501, 502])

      // 选项随筛选收缩：done（仅 POPS5=501）→ 只剩义乌国际仓
      const done = await getTemuSyncShipOrdersAction({
        fromDay: day,
        toDay: day,
        statusGroup: "done",
      })
      if (!done.ok) throw new Error(done.error)
      expect(done.warehouses).toEqual([{ id: 501, label: "义乌国际仓" }])
    },
  )
})

describe("fresh 实时拉取（与发货页列表共用）", () => {
  it(
    "不传 fresh 零官方调用；fresh=裸查落库新单 + 缺席单收敛已取消（30 分钟内防误杀）",
    { timeout: 30_000 },
    async () => {
      const day = temuDayStr()

      // 回归锁：不带 fresh 不打官方 shiporderv2
      shipBodies.length = 0
      const local = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day })
      if (!local.ok) throw new Error(local.error)
      expect(shipBodies.length).toBe(0)

      shipBodies.length = 0
      const r = await getTemuSyncShipOrdersAction({ fromDay: day, toDay: day, fresh: true })
      if (!r.ok) throw new Error(r.error)
      // 两店各 ①裸查 + ②回查 = 4 次官方调用；裸查无名单、回查带名单
      expect(shipBodies.length).toBe(4)
      expect(shipBodies.filter((b) => !b.deliveryOrderSnList).length).toBe(2)
      const verifyCalls = shipBodies.filter((b) => b.deliveryOrderSnList)
      expect(verifyCalls.some((b) => (b.deliveryOrderSnList ?? []).includes("POPS2"))).toBe(true)

      // 裸查新单 POPS6 落库进列表；POPS2 官方缺席且超 30 分钟 → 置已取消出列表；
      // POPS1/POPS4 创建未满 30 分钟缺席也保留（防误杀）
      expect(r.rows.map((x) => x.deliveryOrderSn).sort()).toEqual(["POPS1", "POPS4", "POPS6"])
      expect(r.freshStats).toEqual({ fetched: 4, missing: 1 })
      expect(r.freshWarning).toBeUndefined()
      const [pops2] = await db
        .select({ status: temuShipOrders.status })
        .from(temuShipOrders)
        .where(and(eq(temuShipOrders.storeId, storeId), eq(temuShipOrders.deliveryOrderSn, "POPS2")))
        .limit(1)
      expect(pops2?.status).toBe(5)
      const pops6 = r.rows.find((x) => x.deliveryOrderSn === "POPS6")
      expect(pops6?.deliverSkcNum).toBe(7)
      expect(pops6?.deliveryAddressLabel).toBe("义乌国际仓")
    },
  )
})

async function mainQty(): Promise<number> {
  const [prod] = await db
    .select({ id: inventoryProducts.id })
    .from(inventoryProducts)
    .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, "B9200")))
    .limit(1)
  const [row] = await db
    .select({ qty: inventoryStocks.qty })
    .from(inventoryStocks)
    .where(and(eq(inventoryStocks.productId, prod!.id), eq(inventoryStocks.warehouseId, mainWhId)))
  return row?.qty ?? 0
}

/** 指定货号主仓当前量（跨店合计预检/并发幂等回归用） */
async function qtyOfCode(code: string): Promise<number> {
  const [prod] = await db
    .select({ id: inventoryProducts.id })
    .from(inventoryProducts)
    .where(and(eq(inventoryProducts.enterpriseId, entId), eq(inventoryProducts.productCode, code)))
    .limit(1)
  if (!prod) throw new Error(`档案不存在：${code}`)
  const [row] = await db
    .select({ qty: inventoryStocks.qty })
    .from(inventoryStocks)
    .where(and(eq(inventoryStocks.productId, prod.id), eq(inventoryStocks.warehouseId, mainWhId)))
  return row?.qty ?? 0
}

describe("跨店同货号合计预检与并发幂等", () => {
  // B9201 库存 10：POPS7（店1，7 件）+POPS9（店2，7 件）合计 14 > 10——逐店独立
  // 预检各自通过（7 ≤ 10）会漏合计缺口，扣减阶段店2 才失败留下部分扣减；
  // POPS8（店2，3 件）与 POPS7 合计 10 ≤ 10 应整体通过。
  // B9202 库存 100：POPS10（店1，5 件）并发重复提交幂等回归用。
  beforeAll(async () => {
    const [p1] = await db
      .insert(inventoryProducts)
      .values({ enterpriseId: entId, productCode: "B9201", name: "跨店合计预检款", createdBy: userId })
      .returning()
    await db
      .insert(inventoryStocks)
      .values({ enterpriseId: entId, productId: p1!.id, warehouseId: mainWhId, qty: 10 })
    const [p2] = await db
      .insert(inventoryProducts)
      .values({ enterpriseId: entId, productCode: "B9202", name: "并发幂等款", createdBy: userId })
      .returning()
    await db
      .insert(inventoryStocks)
      .values({ enterpriseId: entId, productId: p2!.id, warehouseId: mainWhId, qty: 100 })
    const now = new Date()
    await db.insert(temuShipOrders).values([
      { storeId, deliveryOrderSn: "POPS7", subPurchaseOrderSn: "SUBS7", skcExtCode: "B9201", status: 1, deliverSkcNum: 7, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s7"), capturedAt: now },
      { storeId: store2Id, deliveryOrderSn: "POPS8", subPurchaseOrderSn: "SUBS8", skcExtCode: "B9201", status: 1, deliverSkcNum: 3, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s8"), capturedAt: now },
      { storeId: store2Id, deliveryOrderSn: "POPS9", subPurchaseOrderSn: "SUBS9", skcExtCode: "B9201", status: 1, deliverSkcNum: 7, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s9"), capturedAt: now },
      { storeId, deliveryOrderSn: "POPS10", subPurchaseOrderSn: "SUBS10", skcExtCode: "B9202", status: 1, deliverSkcNum: 5, deliverTime: now, deliveryAddressId: 501, contentHash: hash("s10"), capturedAt: now },
    ])
  }, 30_000)

  it(
    "跨店同货号合计缺口：整体不动；合计足额：整体扣成功",
    { timeout: 30_000 },
    async () => {
      // 店1 POPS7（7）+ 店2 POPS9（7）= 14 > 10：任一店单独都过，合计缺口必须预检拦下
      const short = await syncTemuShipDeductAction({
        orders: [
          { storeId, sn: "POPS7" },
          { storeId: store2Id, sn: "POPS9" },
        ],
      })
      expect(short.ok).toBe(false)
      if (!short.ok) {
        expect(short.error).toContain("B9201")
        expect(short.shortages?.[0]).toMatchObject({ needed: 14, available: 10 })
      }
      expect(await qtyOfCode("B9201")).toBe(10)

      // 店1 POPS7（7）+ 店2 POPS8（3）= 10 ≤ 10：跨店合计整体扣成功
      const ok = await syncTemuShipDeductAction({
        orders: [
          { storeId, sn: "POPS7" },
          { storeId: store2Id, sn: "POPS8" },
        ],
      })
      expect(ok.ok).toBe(true)
      if (ok.ok) expect(ok.deducted).toBe(2)
      expect(await qtyOfCode("B9201")).toBe(0)
    },
  )

  it(
    "并发重复提交同单（双开标签页场景）：咨询锁+事务内查重，只扣一次不双扣",
    { timeout: 30_000 },
    async () => {
      // 4 路并发同单提交（库存 100 足够扣 4 次，不触发不足兜底）——无并发防护时
      // 各路查重都通过会先后写多条 ship_deduct 流水双扣库存
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          syncTemuShipDeductAction({ orders: [{ storeId, sn: "POPS10" }] }),
        ),
      )
      for (const r of results) {
        expect(r.ok).toBe(true)
      }
      const total = results.reduce((s, r) => s + (r.ok ? r.deducted : 0), 0)
      expect(total).toBe(1)
      expect(await qtyOfCode("B9202")).toBe(95)
      const mvs = await db
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.refId, "POPS10"), eq(inventoryMovements.type, "ship_deduct")))
      expect(mvs).toHaveLength(1)
    },
  )
})

// 清理本测试产生的优先链接行（enterprise 级联删除兜底，显式删防顺序问题）
afterAll(async () => {
  await db.delete(temuPriorityLinks).where(eq(temuPriorityLinks.enterpriseId, entId)).catch(() => {})
})
