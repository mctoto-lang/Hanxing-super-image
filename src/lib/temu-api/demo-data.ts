/**
 * TEMU 演示模式内置虚拟数据集（2026-11-11：官方沙箱 → 虚拟数据切换）。
 *
 * 纯函数生成器（无 DB/server 依赖，可单测）：确定性 LCG 种子，每次生成
 * 结果一致。口径（用户拍板）：100 款商品、售价 100+ 元、单日销量 100+，
 * 数据整体偏高。覆盖：商品 100 / 销量快照 90 天 × 100 / 发货单 30 /
 * 广告日报 7 天 ×（店铺+100 款）/ 售罄快照 1。
 */

/** 确定性伪随机（mulberry32）：同种子同序列 */
function lcg(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = (r: () => number, min: number, max: number) =>
  min + Math.floor(r() * (max - min + 1))

/** 演示商品款（temu_product + sales_overview 共用骨架） */
export interface DemoProduct {
  skcId: string
  productId: string
  sn: string
  name: string
  category: string
  leafCategory: string
  /** 申报价（分）100~299 元 */
  priceFen: number
  /** 主图（placehold.co 外链占位，零存储依赖） */
  imageUrl: string
  /** 90 天日销量序列（下标 0=最早一天；值 100~500） */
  dailyQty: number[]
  warehouseStock: number
  waitDeliveryStock: number
}

/** 演示发货单行（temu_ship_order 投影） */
export interface DemoShipOrder {
  deliveryOrderSn: string
  subPurchaseOrderSn: string
  skcId: string
  sn: string
  /** 1=待仓库收货 2/3=已发货 6=已完成 */
  status: number
  warehouseName: string
  warehouseId: number
  skcNum: number
  packageNum: number
  /** 发货单创建时间（ISO） */
  createTime: string
  /** 预约取货时间（ISO，发货统计时间轴口径） */
  expectPickTime: string
  /** 最晚发货时间（ISO） */
  latestPickTime: string
  deliverTime: string | null
}

/** 演示广告日报（店铺级 + 商品级共用行形状） */
export interface DemoAdsDaily {
  /** yyyy-mm-dd */
  date: string
  adSpendFen: number
  impressions: number
  clicks: number
  orders: number
  gmvFen: number
}

const CATEGORY_POOL: Array<{ category: string; leaf: string; names: string[] }> = [
  { category: "玩具/解压玩具", leaf: "捏捏乐", names: ["慢回弹捏捏乐", "减压捏捏玩具", "夜光捏捏乐"] },
  { category: "玩具/益智玩具", leaf: "拼图", names: ["木质拼图", "异形拼图", "3D 立体拼图"] },
  { category: "家居收纳/桌面收纳", leaf: "收纳盒", names: ["桌面收纳盒", "抽屉式收纳柜", "化妆品收纳盒"] },
  { category: "家居厨房/清洁工具", leaf: "清洁刷", names: ["多功能清洁刷", "缝隙清洁刷", "键盘清洁套装"] },
  { category: "服饰/女装", leaf: "连衣裙", names: ["法式碎花连衣裙", "针织连衣裙", "赫本风连衣裙"] },
  { category: "服饰/配饰", leaf: "围巾", names: ["羊绒围巾", "真丝方巾", "加厚保暖围巾"] },
  { category: "数码配件/手机配件", leaf: "手机壳", names: ["磁吸手机壳", "磨砂防摔手机壳", "液态硅胶手机壳"] },
  { category: "文具/笔记本", leaf: "记事本", names: ["皮面记事本", "A5 方格本", "烫金笔记本"] },
]

const WAREHOUSES = [
  { id: 501, name: "义乌国际仓" },
  { id: 502, name: "深圳宝安仓" },
]

export const DEMO_PRODUCT_COUNT = 100
export const DEMO_DAYS = 90
/** 售价下限（元）——演示口径 100+ */
export const DEMO_MIN_PRICE_YUAN = 100
/** 单日销量下限（件）——演示口径 100+ */
export const DEMO_MIN_DAILY_QTY = 100

/** yyyy-mm-dd → 前移 n 天的 yyyy-mm-dd（UTC 计算，调用方保证传入北京时间日串） */
export function demoDayShift(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 生成 100 款演示商品（确定性；与日期无关，日锚点在销量快照生成时使用） */
export function buildDemoProducts(): DemoProduct[] {
  const r = lcg(20261111)
  const products: DemoProduct[] = []
  for (let i = 1; i <= DEMO_PRODUCT_COUNT; i++) {
    const cat = CATEGORY_POOL[i % CATEGORY_POOL.length]
    const namePrefix = cat.names[i % cat.names.length]
    const base = rand(r, DEMO_MIN_DAILY_QTY, 500)
    const weeklyWave = rand(r, 70, 130) / 100
    const dailyQty: number[] = []
    for (let d = 0; d < DEMO_DAYS; d++) {
      const daysFromEnd = DEMO_DAYS - 1 - d
      // 整体缓涨趋势 + 周内波动（周六日略高），保底 100
      const trend = 1 + (d / DEMO_DAYS) * 0.35
      const week = 1 + Math.sin((daysFromEnd / 7) * Math.PI * 2) * 0.12
      const v = Math.round(base * trend * weeklyWave * week * (0.92 + r() * 0.16))
      dailyQty.push(Math.max(DEMO_MIN_DAILY_QTY, v))
    }
    products.push({
      // 数字串口径（2026-11-13，曾为 DSKC0001 前缀串）：与官方数字 SKC id、
      // 发货单表 bigint 列（发货列表 join cast 对齐）统一；sku_map 的
      // `${序号}${规格}` skuId 与 demo-api 核价/退货引用格式同源于此
      skcId: String(i),
      productId: `DPID${String(i).padStart(4, "0")}`,
      sn: `B${String(i).padStart(3, "0")}`,
      name: `${namePrefix} ${String.fromCharCode(65 + (i % 26))}${i}（演示）`,
      category: cat.category,
      leafCategory: cat.leaf,
      priceFen: rand(r, DEMO_MIN_PRICE_YUAN, 299) * 100 + rand(r, 0, 99),
      imageUrl: `https://placehold.co/300x300/eef2ff/475569?text=B${String(i).padStart(3, "0")}`,
      dailyQty,
      warehouseStock: rand(r, 500, 3000),
      waitDeliveryStock: rand(r, 100, 1000),
    })
  }
  return products
}

/** sales_overview 行投影（每 SKC 每天一批；capturedAt 统一当日 10:00 +08:00） */
export function buildDemoSalesRows(
  products: DemoProduct[],
  today: string,
): Array<{
  skcId: string
  capturedAt: Date
  capturedDay: string
  contentHash: string
  productSn: string
  productName: string
  category: string
  todaySalesVolume: number
  last7DaysSalesVolume: number
  last30DaysSalesVolume: number
  warehouseAvailableStock: number
  waitDeliveryStock: number
  shippedStock: number
  availableSaleDays: number
  /** SKU 明细（priceDetail 列数组：商品页七日/三十日/库存细分与展开面板数据源） */
  priceDetail: Array<Record<string, unknown>>
}> {
  return products.flatMap((p) =>
    p.dailyQty.map((qty, idx) => {
      const day = demoDayShift(today, -(DEMO_DAYS - 1 - idx))
      const last7 = p.dailyQty.slice(Math.max(0, idx - 6), idx + 1).reduce((a, b) => a + b, 0)
      const last30 = p.dailyQty.slice(Math.max(0, idx - 29), idx + 1).reduce((a, b) => a + b, 0)
      // 近 90 天序列尾=今天
      const isToday = idx === DEMO_DAYS - 1
      const dailyAvg7 = Math.round(last7 / 7)
      // 规格 suffix 1/2/3 → S/M/L（skuId = 款序号+suffix，与 sku_map/
      // demo-api 核价退货引用的 `${i+1}${1|2|3}` 格式一致；0.3/0.2 曾都映射
      // 后缀 3 造成同款 SKU 同 ID 的 React key 冲突）
      const perSku = (suffix: 1 | 2 | 3, frac: number) => ({
        productSkuId: Number(`${idx + 1}${suffix}`),
        skuExtCode: `${p.sn}-${suffix === 1 ? "S" : suffix === 2 ? "M" : "L"}`,
        className: suffix === 1 ? "S" : suffix === 2 ? "M" : "L",
        todaySaleVolume: Math.round(qty * frac),
        lastSevenDaysSaleVolume: Math.round(last7 * frac),
        lastThirtyDaysSaleVolume: Math.round(last30 * frac),
        totalSaleVolume: Math.round(p.dailyQty.reduce((a, b) => a + b, 0) * frac),
        supplierPrice: p.priceFen,
        canPurchase: true,
        isVerifyPrice: true,
        inventoryNumInfo: {
          warehouseInventoryNum: Math.round(p.warehouseStock * frac),
          waitDeliveryInventoryNum: Math.round(p.waitDeliveryStock * frac),
        },
      })
      return {
        skcId: p.skcId,
        capturedAt: new Date(`${day}T10:00:00+08:00`),
        capturedDay: day,
        contentHash: `demo-${p.skcId}-${day}`,
        productSn: p.sn,
        productName: p.name,
        category: p.category,
        todaySalesVolume: qty,
        last7DaysSalesVolume: last7,
        last30DaysSalesVolume: last30,
        warehouseAvailableStock: isToday ? p.warehouseStock : p.warehouseStock + rand(lcg(idx * 131 + 7), 0, 400),
        waitDeliveryStock: isToday ? p.waitDeliveryStock : p.waitDeliveryStock + rand(lcg(idx * 137 + 11), 0, 200),
        shippedStock: last30,
        availableSaleDays: dailyAvg7 > 0 ? Math.round(p.warehouseStock / dailyAvg7) : 0,
        // priceDetail = SKU 明细数组（真实链路同构：salesv2 SKU 行落此列，
        // 商品页七日/三十日/展开面板均读它）
        priceDetail: [perSku(1, 0.5), perSku(2, 0.3), perSku(3, 0.2)],
        overview: { isFirst: idx === 0 },
      }
    }),
  )
}

/** 发货单 30 条（近 30 天，状态混合，预约取货时间分布在今日前后一周） */
export function buildDemoShipOrders(
  products: DemoProduct[],
  today: string,
): DemoShipOrder[] {
  const r = lcg(20261112)
  const statuses = [
    ...Array(10).fill(1), // 待仓库收货（发货台/待收货池主力）
    ...Array(8).fill(2),
    ...Array(7).fill(3),
    ...Array(5).fill(6),
  ]
  return statuses.map((status, i) => {
    const p = products[(i * 7) % products.length]
    const dayOffset = -rand(r, 0, 29)
    const day = demoDayShift(today, dayOffset)
    // 预约取货时间：已过状态的落在过去、待收货的落在未来一周
    const pickDay = demoDayShift(today, status === 1 ? rand(r, 0, 7) : dayOffset)
    return {
      deliveryOrderSn: `DEMOPO${String(i + 1).padStart(5, "0")}`,
      subPurchaseOrderSn: `DEMOSUB${String(i + 1).padStart(5, "0")}`,
      skcId: p.skcId,
      sn: p.sn,
      status,
      warehouseName: WAREHOUSES[i % WAREHOUSES.length].name,
      warehouseId: WAREHOUSES[i % WAREHOUSES.length].id,
      skcNum: rand(r, DEMO_MIN_DAILY_QTY, 500),
      packageNum: rand(r, 2, 20),
      createTime: `${day}T09:${String(rand(r, 10, 59)).padStart(2, "0")}:00+08:00`,
      expectPickTime: `${pickDay}T${String(rand(r, 9, 18)).padStart(2, "0")}:00:00+08:00`,
      latestPickTime: `${demoDayShift(pickDay, 2)}T18:00:00+08:00`,
      deliverTime: status === 1 ? null : `${day}T16:00:00+08:00`,
    }
  })
}

/** 广告日报（近 7 天店铺级） */
export function buildDemoAdsDaily(today: string): DemoAdsDaily[] {
  const r = lcg(20261113)
  return Array.from({ length: 7 }, (_, i) => {
    const date = demoDayShift(today, -(6 - i))
    return {
      date,
      adSpendFen: rand(r, 100000, 500000),
      impressions: rand(r, 50000, 300000),
      clicks: rand(r, 2000, 12000),
      orders: rand(r, 300, 1500),
      gmvFen: rand(r, 300000, 2000000),
    }
  })
}

/** 商品级广告日报行（100 款 × 7 天；与店铺级日报同源一次生成保证确定性） */
export function buildDemoAdsProductRows(
  products: DemoProduct[],
  today: string,
): Array<DemoAdsDaily & { productId: string; goodsNum: number }> {
  const daily = buildDemoAdsDaily(today)
  return products.flatMap((p) =>
    daily.map((d) => ({
      ...d,
      productId: p.productId,
      goodsNum: Math.round(d.orders / DEMO_PRODUCT_COUNT),
    })),
  )
}

/** 售罄预警快照（最新一批，overview 售罄卡数据源） */
export function buildDemoSoldoutSnapshot() {
  const r = lcg(20261115)
  return {
    todaySellOutNum: rand(r, 3, 8),
    todaySoonSellOutNum: rand(r, 5, 15),
    increaseSellOutNum: rand(r, 10, 60),
    alreadySoldOutNumber: rand(r, 20, 80),
  }
}
