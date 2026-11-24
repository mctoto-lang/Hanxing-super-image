/**
 * TEMU 演示模式虚拟接口层（2026-11-11：官方沙箱 → 内置虚拟数据切换）。
 *
 * callTemuApi 在 ctx.appKey === DEMO_APP_KEY 时不发网络，直接路由到本模块
 * 的确定性虚拟响应：实时工作台 tab（备货/核价/质检/退货/发货台/广告/发品
 * 类目）在演示模式下有数据、可走完 UI 流程；写操作返回模拟成功。
 * 未登记的读端点返回空成功（UI 显示空列表，不报错）。
 */
import {
  buildDemoProducts,
  buildDemoShipOrders,
  type DemoProduct,
  type DemoShipOrder,
} from "./demo-data"

/** 演示凭证标记（getTemuCallContext 对 is_demo 店铺返回；绝不与真实 app_key 冲突） */
export const DEMO_APP_KEY = "__demo_virtual__"

/** 北京时间今日串（虚拟数据日锚点；按 UTC+8 计算，不依赖服务器时区） */
function bjToday(): string {
  const now = new Date(Date.now() + 8 * 3600_000)
  return now.toISOString().slice(0, 10)
}

/* ─── 确定性数据缓存（每进程一次生成；日期变化时重建） ─── */
let cache: { day: string; products: DemoProduct[] } | null = null
function demoProducts(): DemoProduct[] {
  const day = bjToday()
  if (!cache || cache.day !== day) cache = { day, products: buildDemoProducts() }
  return cache.products
}

/* ─── 时间窗过滤辅助（服务端恒带 epoch ms 两端含窗口：质检 qcResultUpdateTimeBegin/End、
       退货 outboundTimeStart/End；演示层须同构过滤，否则改日期结果不变） ─── */
/** epoch ms 入参（非有限数视为未传 → null=该端不设界） */
function msParam(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** epoch ms 时间窗过滤（两端含：t < from 或 t > to 剔除） */
function inMsRange(t: number, from: number | null, to: number | null): boolean {
  if (from != null && t < from) return false
  if (to != null && t > to) return false
  return true
}

/* ─── 备货单（bg.purchaseorderv2.get） ─── */
function purchaseOrders(params: Record<string, unknown>) {
  const statusList = Array.isArray(params.statusList) ? (params.statusList as number[]) : [0, 1]
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 50)
  const products = demoProducts()
  // 备货单状态口径：0=待接单 1=已接单待发货（todo 预设）；2/3=已发货；
  // 4~9=已关闭。虚拟单：每款一单，按入参状态过滤；字段名对齐
  // temu-fulfillment loadPurchaseOrders 的映射器（subPurchaseOrderSn/status/productSn…）
  const now = Date.now()
  const rows = products
    .map((p, i) => {
      const status = i % 10
      const qty = p.dailyQty[p.dailyQty.length - 1]
      return {
        subPurchaseOrderSn: `DEMOSUB${String(i + 1).padStart(5, "0")}`,
        originalPurchaseOrderSn: `DEMOPO${String(i + 1).padStart(5, "0")}`,
        status,
        productSkcId: p.skcId,
        productSn: p.sn,
        productName: p.name,
        productSkcPicture: p.imageUrl,
        category: p.category,
        stockingType: 0,
        purchaseTime: now - (i % 7) * 86400_000,
        deliverInfo: {
          receiveWarehouseName: i % 2 === 0 ? "义乌国际仓" : "深圳宝安仓",
          expectLatestDeliverTimeOrDefault: now + 2 * 86400_000,
          expectLatestArrivalTimeOrDefault: now + 5 * 86400_000,
        },
        skuQuantityDetailList: [
          {
            productSkuId: `${i + 1}1`,
            className: "S",
            adviceQuantity: Math.round(qty * 0.5),
            purchaseQuantity: Math.round(qty * 0.5),
            deliverQuantity: 0,
            purchaseUpLimit: qty,
            thumbUrlList: [p.imageUrl],
          },
          {
            productSkuId: `${i + 1}2`,
            className: "M",
            adviceQuantity: Math.round(qty * 0.5),
            purchaseQuantity: Math.round(qty * 0.5),
            deliverQuantity: 0,
            purchaseUpLimit: qty,
          },
        ],
      }
    })
    .filter((row) => statusList.length === 0 || statusList.includes(row.status))
  const start = (pageNo - 1) * pageSize
  return { total: rows.length, subOrderForSupplierList: rows.slice(start, start + pageSize) }
}

/* ─── 核价（bg.price.review.page.query） ─── */
function priceReviews(params: Record<string, unknown>) {
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 20)
  // 字段对齐 loadPriceReviews 映射器：orderId 必有，orderStatus 1=待供应商确认
  // （默认筛选）；SKU 反查走本地 sku_map（ensureDemoData 已落）——productSkuIdList
  // 用 sku_map 播种格式（去 DSKC 前缀+规格后缀，同调价 skuInfoItemList），商品反查可命中
  const now = Date.now()
  const rows = demoProducts()
    .slice(0, 30)
    .map((p, i) => {
      const skuBase = p.skcId.replace("DSKC", "")
      return {
        orderId: 70000 + i,
        orderStatus: [1, 1, 1, 2, 0][i % 5],
        supplyPrice: p.priceFen,
        priceCurrency: "CNY",
        suggestSupplyPrice: Math.round(p.priceFen * 0.92),
        suggestPriceCurrency: "CNY",
        siteNameList: ["US", "CA"],
        siteIds: [100, 200],
        canBargain: true,
        productSkuIdList: [`${skuBase}1`, `${skuBase}2`],
        createTime: now - i * 3600_000,
      }
    })
  const statusFilter = Array.isArray(params.orderStatusList) ? (params.orderStatusList as number[]) : null
  const filtered = statusFilter ? rows.filter((r) => statusFilter.includes(r.orderStatus)) : rows
  const start = (pageNo - 1) * pageSize
  return { total: filtered.length, reviewSamplePriceList: filtered.slice(start, start + pageSize) }
}

/* ─── 调价单（bg.full.adjust.price.page.query） ─── */
function adjustOrders(params: Record<string, unknown>) {
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 20)
  // 字段对齐 loadAdjustOrders 映射器（2026-11-12 修正：此前返回 adjustPriceOrderList/
  // adjustPriceOrderSn 等与真实接口不一致的字段名，映射器全跳过、demo 调价列表恒空）；
  // skuId 用 sku_map 播种格式（去 DSKC 前缀+规格后缀），当前价反查可命中
  const rows = demoProducts()
    .slice(30, 50)
    .map((p, i) => {
      const newPrice = Math.round(p.priceFen * 0.95)
      const skuBase = p.skcId.replace("DSKC", "")
      return {
        priceOrderSn: `DEMOAJ${String(i + 1).padStart(4, "0")}`,
        skcId: p.skcId,
        skcExtCode: p.sn,
        productId: p.productId,
        productName: p.name,
        orderCreateTime: Date.now() - i * 3600_000,
        priceType: i % 3 === 0 ? 1 : 0,
        adjustReason: ["供应链成本变化", "活动价格调整", "日常价格调整"][i % 3] ?? "日常价格调整",
        source: i % 2 === 0 ? "1" : "2",
        newSupplyPrice: String(newPrice), // 官方为 STRING 分
        priceCurrency: "CNY",
        imageList: [p.imageUrl],
        skuInfoItemList: [1, 2].map((k) => ({
          productSkuId: `${skuBase}${k}`,
          price: Math.round(newPrice * (k === 1 ? 1 : 0.98)),
          skuExtCode: `${p.sn}-${k === 1 ? "S" : "M"}`,
          spec: k === 1 ? "白色 均码" : "黑色 均码",
          priceCurrency: "CNY",
        })),
      }
    })
  // 服务端过滤（与真实接口入参同构）：priceOrderSn[] / extCodes[] / productName 模糊包含
  const snF = (params.priceOrderSn as string[] | undefined)?.[0]?.toLowerCase()
  const extF = (params.extCodes as string[] | undefined)?.[0]?.toLowerCase()
  const nameF = typeof params.productName === "string" ? params.productName.toLowerCase() : ""
  const filtered = rows.filter(
    (r) =>
      (!snF || r.priceOrderSn.toLowerCase().includes(snF)) &&
      (!extF || r.skcExtCode.toLowerCase().includes(extF)) &&
      (!nameF || r.productName.toLowerCase().includes(nameF)),
  )
  const start = (pageNo - 1) * pageSize
  return { total: filtered.length, list: filtered.slice(start, start + pageSize) }
}

/* ─── 质检（bg.goods.qualityinspection.*） ─── */
function qualityInspections(params: Record<string, unknown>) {
  const pageInfo = (params.pageInfo ?? {}) as { pageNo?: number; pageSize?: number }
  const pageNo = Number(pageInfo.pageNo ?? 1)
  const pageSize = Number(pageInfo.pageSize ?? 20)
  // 字段对齐 loadQualityInspections 映射器（2026-11-13 修正：此前 goodsName/
  // productImgUrl/purchaseOrderSn/qcTime 等字段名与映射器不符、productSkcId 用数字，
  // 缩略图/SKU/规格/货号/类目/采购单号/更新时间列全空）；productSkcId 直接用商品表
  // 播种的 p.skcId（货号反查第一跳命中），productSkuId 用 sku_map 播种格式（第二跳兜底）；
  // skuQcResult 口径 1=合格 2=不合格（与筛选入参/徽章一致，服务端按其过滤）
  const rows = demoProducts()
    .slice(0, 25)
    .map((p, i) => {
      // 更新时间分散到近 25 天（第 i 行=近第 i+1 天 11:00，北京时间）：服务端恒带
      // qcResultUpdateTimeBegin/End（temu-fulfillment），恒为「今天 11 点」时任何
      // 不含今天的窗口都会筛成 0 行
      const day = new Date(Date.now() + 8 * 3600_000 - (i + 1) * 86400_000)
        .toISOString()
        .slice(0, 10)
      return {
        qcBillId: 900000 + i,
        productSkuId: `${p.skcId.replace("DSKC", "")}1`,
        productSkcId: p.skcId,
        spuId: p.productId,
        skuName: p.name,
        spec: i % 2 === 0 ? "白色 均码" : "黑色 均码",
        catName: p.leafCategory,
        purchaseNo: `DEMOPO${String((i % 100) + 1).padStart(5, "0")}`,
        qcResultUpdateTime: `${day}T11:00:00+08:00`,
        thumbUrl: p.imageUrl,
        skuQcResult: i % 3 === 1 ? 2 : 1,
      }
    })
  // 服务端过滤（与真实接口入参同构）：skuQcResult 1=合格 2=不合格（UI 默认筛 2）+
  // qcResultUpdateTimeBegin/End（epoch ms 两端含）
  const qcF = typeof params.skuQcResult === "number" ? params.skuQcResult : null
  const filtered = rows.filter(
    (r) =>
      (qcF == null || r.skuQcResult === qcF) &&
      inMsRange(Date.parse(r.qcResultUpdateTime), msParam(params.qcResultUpdateTimeBegin), msParam(params.qcResultUpdateTimeEnd)),
  )
  const start = (pageNo - 1) * pageSize
  return { total: filtered.length, skuList: filtered.slice(start, start + pageSize) }
}

/* ─── 退货（bg.refund.returnpackagelist.get / detail） ─── */
/** 退供包裹列表（bg.refund.returnpackage.get → openReturnPackageDTOS 行字段对齐映射器） */
function returnPackages(params: Record<string, unknown>) {
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 20)
  const now = Date.now()
  const rows = demoProducts().slice(0, 12).map((p, i) => ({
    returnSupplierPackageNo: `DEMORT${String(i + 1).padStart(4, "0")}`,
    purchaseSubOrderSn: `DEMOSUB${String((i % 100) + 1).padStart(5, "0")}`,
    expressDeLiverySn: `DEMOEXP${1000 + i}`,
    returnSupplierQuantity: 1 + (i % 5),
    outboundTime: now - (i + 1) * 86400_000,
    packageStatusDesc: "待退货",
    returnSupplierReasonDesc: ["质量问题退货", "尺寸不符退货", "多发退货"][i % 3],
    logisticsTypeDesc: "快递",
    payMethodDesc: "在线支付",
    returnHandOverTypeDesc: "自送",
    reason: "演示退货原因",
  }))
  const status = params.status != null ? Number(params.status) : null
  // 服务端过滤（与真实接口入参同构）：status + outboundTimeStart/End（epoch ms 两端含；
  // 服务端恒带时间窗，恒回全量会导致改日期结果不变）
  const filtered = rows.filter(
    (r, i) =>
      (status == null || i % 2 === status % 2) &&
      inMsRange(r.outboundTime, msParam(params.outboundTimeStart), msParam(params.outboundTimeEnd)),
  )
  const start = (pageNo - 1) * pageSize
  return { total: filtered.length, openReturnPackageDTOS: filtered.slice(start, start + pageSize) }
}

/** 退供包裹 SKU 明细（bg.refund.returnpackagelist.get → packageDetailDTOList；详情弹窗用；
 *  productSkuId 用 sku_map 播种格式（去 DSKC 前缀+规格后缀），货号/品名反查可命中） */
function returnPackageDetails(params: Record<string, unknown>) {
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 20)
  const now = Date.now()
  const rows = demoProducts()
    .slice(0, 10)
    .map((p, i) => ({
      productSkuId: `${p.skcId.replace("DSKC", "")}1`,
      productSpuId: p.productId,
      packageSn: `DEMORT${String(i + 1).padStart(4, "0")}`,
      quantity: 1 + (i % 3),
      outboundTime: now - (i + 1) * 86400_000,
      mainSaleSpec: "均码",
    }))
  // 同 returnPackages：outboundTimeStart/End（epoch ms 两端含）出库时间过滤
  const filtered = rows.filter((r) =>
    inMsRange(r.outboundTime, msParam(params.outboundTimeStart), msParam(params.outboundTimeEnd)),
  )
  const start = (pageNo - 1) * pageSize
  return { total: filtered.length, packageDetailDTOList: filtered.slice(start, start + pageSize) }
}

/* ─── 演示收货仓档案（receiveaddressv2 分组与 shiporderv2 行共用） ───
   601=义乌国际仓 602=深圳宝安仓；demo-data 发货单仓 501/502 按同名仓同址对齐 */
const DEMO_RECEIVE_ADDRESSES = {
  601: {
    receiverName: "演示仓",
    phone: "13800000000",
    provinceName: "浙江省",
    provinceCode: 330000,
    cityName: "金华市",
    cityCode: 330700,
    districtName: "义乌市",
    districtCode: 330782,
    detailAddress: "义乌市XXX路1号",
  },
  602: {
    receiverName: "演示仓",
    phone: "13800000000",
    provinceName: "广东省",
    provinceCode: 440000,
    cityName: "深圳市",
    cityCode: 440300,
    districtName: "宝安区",
    districtCode: 440306,
    detailAddress: "深圳市YYY路2号",
  },
} as const

/** 收货仓 id → 地址档案（501 与 601 同为义乌国际仓、502 与 602 同为深圳宝安仓） */
function receiveAddressOf(warehouseId: number) {
  return warehouseId === 501 || warehouseId === 601
    ? DEMO_RECEIVE_ADDRESSES[601]
    : DEMO_RECEIVE_ADDRESSES[602]
}

/** 收货仓名（未知 id → 空串，落库侧 str() 置 null） */
function receiveWarehouseName(warehouseId: number): string {
  return warehouseId === 501 || warehouseId === 601
    ? "义乌国际仓"
    : warehouseId === 502 || warehouseId === 602
      ? "深圳宝安仓"
      : ""
}

/* ─── 发货台收货地址分组（bg.shiporder.receiveaddressv2.get → subPurchaseReceiveAddressGroups） ───
   分组口径与 staging() 一致：奇数序号备货单 → 义乌国际仓(601)，偶数 → 深圳宝安仓(602) */
function receiveAddressGroups(params: Record<string, unknown>) {
  const sns = Array.isArray(params.subPurchaseOrderSnList)
    ? (params.subPurchaseOrderSnList as string[])
    : []
  const byWh = new Map<601 | 602, string[]>()
  for (const sn of sns) {
    const n = Number(String(sn).replace(/\D/g, "")) || 1
    const id: 601 | 602 = n % 2 === 1 ? 601 : 602
    byWh.set(id, [...(byWh.get(id) ?? []), sn])
  }
  return {
    subPurchaseReceiveAddressGroups: [...byWh].map(([id, list]) => ({
      subWarehouseId: id,
      receiveAddressInfo: DEMO_RECEIVE_ADDRESSES[id],
      subPurchaseOrderSnList: list,
    })),
  }
}

/* ─── 发货单（bg.shiporderv2.get：fresh 拉取路径，与落库虚拟数据同源） ─── */

/** 演示 supplierId：与本地播种值同源（temu-demo.ts ensureDemoData 的 88888）。upsertShipOrderRows
 *  冲突更新用行值覆盖本地列——行里缺 supplierId 就把播种值抹空，退供工作台
 *  getStoreSupplierId（只认非空 supplier_id）随之三个接口全报「暂无发货单数据」 */
const DEMO_SUPPLIER_ID = 88888

/** SKU 明细（raw.packageDetailList：商品条码按 SKU 打印 / 自动发货拆包预估的数据源）。
 *  skuId 用 sku_map 播种格式 `${skcId}${1|2|3}`（货号反查可命中），件数 5:3:2 分摊
 *  （对齐销量快照 priceDetail 口径） */
function demoPackageDetails(
  skcId: string,
  skcNum: number,
): Array<{ productSkuId: number; skuNum: number }> {
  return [1, 2, 3].map((suffix, k) => ({
    productSkuId: Number(`${skcId}${suffix}`),
    skuNum: Math.round(skcNum * [0.5, 0.3, 0.2][k]),
  }))
}

/** 演示层内存登记：bg.shiporderv3.create 创建出的发货单（进程内有效；重启/多实例丢失 →
 *  回查落空退化到 seedCreatedOrders 本地播种，安全降级）。shiporderv2 按单号回查时合并
 *  返回、packing.send 推进状态——否则创建出的单在演示层永远缺席：本地停在待装箱、可
 *  反复「发货」、满 30 分钟被 freshPullStore 判「官方侧已移除」置已取消 */
interface RegisteredShipOrder {
  deliveryOrderSn: string
  subPurchaseOrderSn: string
  skcId: string
  /** 0=待装箱 → packing.send 后 2=已发货；cancel 置 5=已取消 */
  status: number
  subWarehouseId: number
  deliveryAddressId: number | null
  deliverSkcNum: number
  deliverPackageNum: number
  packageDetailList: Array<{ productSkuId: number; skuNum: number }>
  createdAt: number
  deliverTime: number | null
  expressBatchSn: string | null
}
const registeredShipOrders = new Map<string, RegisteredShipOrder>()

/** DEMOSUB 备货单号 → 演示款（备货/待装箱的单号=款序号+1，与商品表播种同源） */
function productBySubSn(subPurchaseOrderSn: string): DemoProduct | undefined {
  const n = Number(String(subPurchaseOrderSn).replace(/\D/g, ""))
  if (!Number.isFinite(n) || n <= 0) return undefined
  const products = demoProducts()
  return products[(n - 1) % products.length]
}

/** 固定 30 单（buildDemoShipOrders）→ shiporderv2 行。2026-11-24 补齐 supplierId/
 *  subWarehouseId/receiveAddressInfo/isPrintBoxMark/packageDetailList 等真实字段：此前
 *  缺列导致进一次发货单列表（实时拉取）就把本地播种值 upsert 覆盖成空（收货仓 id、
 *  已打印标记、SKU 明细一并丢失） */
function fixedShipOrderRow(o: DemoShipOrder) {
  return {
    deliveryOrderSn: o.deliveryOrderSn,
    subPurchaseOrderSn: o.subPurchaseOrderSn,
    productSkcId: Number(o.skcId.replace("DSKC", "")),
    skcExtCode: o.sn,
    status: o.status,
    supplierId: DEMO_SUPPLIER_ID,
    subWarehouseId: o.warehouseId,
    subWarehouseName: o.warehouseName,
    receiveAddressInfo: receiveAddressOf(o.warehouseId),
    isPrintBoxMark: o.status >= 1,
    deliverSkcNum: o.skcNum,
    deliveryAddressId: o.warehouseId,
    deliveryOrderCreateTime: new Date(o.createTime).getTime(),
    deliverTime: o.deliverTime ? new Date(o.deliverTime).getTime() : null,
    receiveTime: o.status >= 3 ? new Date(o.createTime).getTime() + 86400_000 : null,
    expectPickUpGoodsTime: new Date(o.expectPickTime).getTime(),
    expectLatestPickTime: new Date(o.latestPickTime).getTime(),
    deliverPackageNum: o.packageNum,
    packageDetailList: demoPackageDetails(o.skcId, o.skcNum),
    purchaseStockType: 1,
    factoryDirect: false,
  }
}

/** 登记单 → shiporderv2 行（列口径同固定单；deliverTime/expressBatchSn 随 packing.send 推进） */
function registeredShipOrderRow(r: RegisteredShipOrder, products: DemoProduct[]) {
  const p = products.find((x) => x.skcId === r.skcId)
  return {
    deliveryOrderSn: r.deliveryOrderSn,
    subPurchaseOrderSn: r.subPurchaseOrderSn,
    productSkcId: Number(r.skcId.replace("DSKC", "")) || null,
    skcExtCode: p?.sn ?? null,
    status: r.status,
    supplierId: DEMO_SUPPLIER_ID,
    subWarehouseId: r.subWarehouseId,
    subWarehouseName: receiveWarehouseName(r.subWarehouseId),
    receiveAddressInfo: receiveAddressOf(r.subWarehouseId),
    isPrintBoxMark: r.status >= 1,
    deliverSkcNum: r.deliverSkcNum,
    deliveryAddressId: r.deliveryAddressId,
    deliveryOrderCreateTime: r.createdAt,
    deliverTime: r.deliverTime,
    receiveTime: null,
    expectPickUpGoodsTime: r.createdAt + 2 * 86400_000,
    expectLatestPickTime: r.createdAt + 3 * 86400_000,
    deliverPackageNum: r.deliverPackageNum,
    expressBatchSn: r.expressBatchSn,
    packageDetailList: r.packageDetailList,
    purchaseStockType: 1,
    factoryDirect: false,
  }
}

/** 合并行（登记单在前=创建时间倒序，口径同 sortType:0 裸查；固定 30 单在后）：
 *  shiporderv2 裸查/按单号回查与 package.get 回显共用 */
function mergedShipOrderRows(): Array<Record<string, unknown>> {
  const products = demoProducts()
  return [
    ...[...registeredShipOrders.values()].map((r) => registeredShipOrderRow(r, products)),
    ...buildDemoShipOrders(products, bjToday()).map(fixedShipOrderRow),
  ]
}

function shipOrders(params: Record<string, unknown>) {
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 20)
  const all = mergedShipOrderRows()
  // 按单号回查（upsertFromOfficial / freshPullStore 实时核对通道）：只回名单内的单，
  // 缺席=官方侧已移除（与真实接口同构）——此前无视名单恒回固定 30 单，创建出的
  // DEMONEW 单永远查不到、30 分钟后被误判已取消
  const sns = new Set(
    Array.isArray(params.deliveryOrderSnList)
      ? params.deliveryOrderSnList.map((v) => String(v))
      : [],
  )
  const list = sns.size > 0 ? all.filter((r) => sns.has(String(r.deliveryOrderSn))) : all
  const start = (pageNo - 1) * pageSize
  return { total: list.length, list: list.slice(start, start + pageSize) }
}

/* ─── 发货台待装箱（bg.shiporder.staging.get → list[].subPurchaseOrderBasicVO） ─── */
function staging() {
  const products = demoProducts()
  const now = Date.now()
  const list = products.slice(0, 15).map((p, i) => ({
    subPurchaseOrderBasicVO: {
      subPurchaseOrderSn: `DEMOSUB${String((i % 100) + 1).padStart(5, "0")}`,
      productName: p.name,
      productSkcPicture: p.imageUrl,
      productSkcId: Number(p.skcId.replace("DSKC", "")),
      skcExtCode: p.sn,
      subWarehouseName: i % 2 === 0 ? "义乌国际仓" : "深圳宝安仓",
      receiveAddressInfo: {
        provinceName: "广东省",
        cityName: "深圳市",
        districtName: "南山区",
        detailAddress: "演示路 88 号仓库",
      },
      purchaseQuantity: Math.round(p.dailyQty[p.dailyQty.length - 1] / 5),
      purchaseTime: now - i * 3600_000,
      urgencyType: 0,
      purchaseStockType: 0,
      deliverDisplayCountdownMillis: 48 * 3600_000,
      expectLatestDeliverTime: now + 2 * 86400_000,
      expectLatestArrivalTime: now + 5 * 86400_000,
    },
    orderDetailVOList: [1, 2, 3].map((suffix) => ({
      productSkuId: Number(`${i + 1}${suffix}`),
      skuDeliveryQuantityMaxLimit: Math.round(p.dailyQty[p.dailyQty.length - 1] / 10),
      productSkuPurchaseQuantity: Math.round(p.dailyQty[p.dailyQty.length - 1] / 15),
      productSkuImgUrlList: [p.imageUrl],
    })),
  }))
  return { total: list.length, list }
}

/* ─── 广告计划实时状态（bg.glo.searchrec.ad.detail.query，PA；对齐 loadAdPlans
 *  消费端：adsDetail[{goodsId, adShowStatus, adPhase, budget, roas, summary}]） ─── */
function adDetails(params: Record<string, unknown>) {
  // 请求 productIdList 的 id（演示商品 ID 为 DPID 字符串，原样对齐）
  const ids = Array.isArray(params.productIdList)
    ? params.productIdList.map((v) => String(v))
    : []
  const byId = new Map(demoProducts().map((p) => [p.productId, p]))
  const rows = ids
    .map((id) => byId.get(id))
    .filter((p): p is DemoProduct => !!p)
    .map((p, i) => ({
      productId: p.productId,
      adShowStatus: 8, // 官方枚举 8=promoting 推广中
      adPhase: 1, // 官方枚举 1=平稳期
      budget: 5000 + i * 100,
      roas: 13,
      summary: {
        adSpend: { ad: { val: p.priceFen * 2 } },
        orderPayAmt: { ad: { val: p.priceFen * 20 } },
        roas: { ad: { val: 13 } },
        orderPayCnt: { ad: { val: 2 } },
      },
    }))
  return { adsDetail: rows }
}

/* ─── 类目（发品链路 bg.glo.goods.cats.get / category.match / attrs.get） ─── */
const DEMO_CATS = [
  { catId: 1001, catName: "玩具解压", parentId: 0, leaf: false },
  { catId: 1002, catName: "捏捏乐", parentId: 1001, leaf: true },
  { catId: 1003, catName: "家居收纳", parentId: 0, leaf: false },
  { catId: 1004, catName: "收纳盒", parentId: 1003, leaf: true },
  { catId: 1005, catName: "服饰配件", parentId: 0, leaf: false },
  { catId: 1006, catName: "围巾", parentId: 1005, leaf: true },
]

function goodsCats(params: Record<string, unknown>) {
  const parentId = Number(params.parentCatId ?? 0)
  const list = DEMO_CATS.filter((c) => c.parentId === parentId)
  return { catInfoList: list.map((c) => ({ ...c, isLeaf: c.leaf, hidden: false })) }
}

function categoryMatch(params: Record<string, unknown>) {
  const title = String(params.goodsName ?? params.title ?? "")
  const hit =
    DEMO_CATS.find((c) => c.leaf && title.includes(c.catName.slice(0, 1))) ??
    DEMO_CATS[1]
  return { catChain: [1001, hit.catId].includes(hit.parentId) ? [] : [], matchCatId: hit.catId, matchCatName: hit.catName }
}

function goodsAttrs() {
  return {
    goodsAttrDTOList: [
      { attrId: 101, attrName: "颜色", isCustom: false, values: [{ valueId: 1, valueName: "黑色" }, { valueId: 2, valueName: "白色" }] },
      { attrId: 102, attrName: "尺寸", isCustom: false, values: [{ valueId: 11, valueName: "均码" }] },
      { attrId: 103, attrName: "材质", isCustom: true },
    ],
  }
}

/* ─── 写操作：模拟成功（单号类回显请求值；任务类回假任务号） ─── */
function writeSuccess(type: string, params: Record<string, unknown>) {
  if (type.includes("cancel")) {
    // 取消的单在登记表同步置已取消（5）：回查 upsert 后本地状态收敛（此前登记单
    // 取消后仍按旧状态回查落库）
    const sn = typeof params.deliveryOrderSn === "string" ? params.deliveryOrderSn : null
    const reg = sn ? registeredShipOrders.get(sn) : null
    if (reg) reg.status = 5
    return { successList: params.purchaseOrderSnList ?? params.deliveryOrderSnList ?? [] }
  }
  if (type.includes("apply")) return { purchaseOrderSn: `DEMOAPPLY${Date.now() % 100000}` }
  if (type === "bg.glo.goods.add") return { goodsSkcId: 990001, goodsId: 990001 }
  // 对齐官方「一单一个发货单号」（deliveryOrders[].deliveryOrderSn）：单号数与订单数
  // 一致，seedCreatedOrders 才会按序补全收货仓/地址/件数；只回一个号会退化成极简行。
  // 同时登记进内存（registeredShipOrders）：shiporderv2 按单号回查/实时核对可见
  if (type === "bg.shiporderv3.create") {
    const groups = Array.isArray(params.deliveryOrderCreateGroupList)
      ? (params.deliveryOrderCreateGroupList as Record<string, unknown>[])
      : []
    const flat = groups.flatMap((g) => {
      const infos = Array.isArray(g.deliveryOrderCreateInfos)
        ? (g.deliveryOrderCreateInfos as Record<string, unknown>[])
        : []
      return infos.map((o) => ({ group: g, order: o }))
    })
    const n = Math.max(1, flat.length)
    const base = Date.now() % 100000
    const sns = Array.from({ length: n }, (_, i) => `DEMONEW${(base + i) % 100000}`)
    const now = Date.now()
    sns.forEach((sn, i) => {
      const { group, order } = flat[i] ?? { group: {}, order: {} }
      const subPurchaseOrderSn =
        typeof order.subPurchaseOrderSn === "string" ? order.subPurchaseOrderSn : ""
      const p = productBySubSn(subPurchaseOrderSn)
      const packageDetailList = (
        Array.isArray(order.deliverOrderDetailInfos)
          ? (order.deliverOrderDetailInfos as Record<string, unknown>[])
          : []
      )
        .map((d) => ({ productSkuId: Number(d.productSkuId), skuNum: Number(d.deliverSkuNum) }))
        .filter((d) => Number.isFinite(d.productSkuId) && d.productSkuId > 0)
        .map((d) => ({ ...d, skuNum: Number.isFinite(d.skuNum) ? d.skuNum : 0 }))
      registeredShipOrders.set(sn, {
        deliveryOrderSn: sn,
        subPurchaseOrderSn,
        skcId: p?.skcId ?? "",
        status: 0,
        subWarehouseId: Number(group.subWarehouseId) || 0,
        deliveryAddressId: Number(group.deliveryAddressId ?? order.deliveryAddressId) || null,
        deliverSkcNum: packageDetailList.reduce((a, d) => a + d.skuNum, 0),
        deliverPackageNum: Array.isArray(order.packageInfos) ? order.packageInfos.length : 0,
        packageDetailList,
        createdAt: now,
        deliverTime: null,
        expressBatchSn: null,
      })
    })
    return { deliveryOrders: sns.map((deliveryOrderSn) => ({ deliveryOrderSn })) }
  }
  // 对齐真实出参 {expressBatchSn}（sendPackingAction 读批次号回显；dataKey 是打印接口
  // 的出参），并推进登记单 0→2 已发货：按单号回查 upsert 后离开待装箱、不可反复发货
  if (type === "bg.shiporder.packing.send") {
    const expressBatchSn = `DEMOBATCH${Date.now() % 100000}`
    const now = Date.now()
    for (const sn of Array.isArray(params.deliveryOrderSnList) ? params.deliveryOrderSnList : []) {
      const reg = registeredShipOrders.get(String(sn))
      if (reg && reg.status < 2) {
        reg.status = 2
        reg.deliverTime = now
        reg.expressBatchSn = expressBatchSn
      }
    }
    return { expressBatchSn }
  }
  if (type === "bg.glo.searchrec.ad.modify") return { adPlanId: 8001 }
  // ad.create 对齐 createTemuAdsAction 消费端：成功 ID 列表 + 成功数 + 失败明细
  if (type === "bg.glo.searchrec.ad.create") {
    const reqs = Array.isArray(params.createAdReqs)
      ? (params.createAdReqs as Record<string, unknown>[])
      : []
    return {
      successCreateProductNum: reqs.length,
      successProductIdLists: reqs.map((r) => r.productId),
      createGoodsFailObjList: [],
    }
  }
  return {}
}

/** 读端点分发表 */
const READ_ROUTES: Record<string, (p: Record<string, unknown>) => unknown> = {
  "bg.mall.info.get": () => ({ semiManagedMall: false, isThriftStore: false }),
  "bg.purchaseorderv2.get": purchaseOrders,
  "bg.price.review.page.query": priceReviews,
  "bg.full.adjust.price.page.query": adjustOrders,
  "bg.goods.qualityinspection.get": qualityInspections,
  "bg.refund.returnpackage.get": returnPackages,
  "bg.refund.returnpackagelist.get": returnPackageDetails,
  // 退供包裹详情弹窗：returnPackageInfos[] 字段对齐 getTemuReturnPackageDetailAction
  // 消费端（productSkcId=商品表播种 skcId，货号/品名本地反查命中；件数与列表行同源，
  // DEMORT 序号同款）
  "bg.refund.returnpackagedetail.get": (p) => {
    const n = Number(String(p.returnSupplierPackageNo ?? "").replace(/\D/g, "")) || 1
    const products = demoProducts()
    const prod = products[(n - 1) % products.length]!
    return {
      returnPackageInfos: [
        {
          productSkcId: Number(prod.skcId),
          thumbUrl: prod.imageUrl,
          mainSaleSpec: "均码",
          secondarySaleSpec: "白色",
          returnSupplierQuantity: 1 + ((n - 1) % 5),
        },
      ],
    }
  },
  "bg.shiporderv2.get": shipOrders,
  // 调整包裹弹窗回显（package.get → packageInfo[{packageSn,skcNum,packageDetails}]）：
  // 字段对齐 getShipPackagesAction 消费端；按单号回查合并行，SKU 明细轮转均摊到包裹
  "bg.shiporder.package.get": (p) => {
    const sn = String(p.deliveryOrderSn ?? "")
    const row = mergedShipOrderRows().find((r) => String(r.deliveryOrderSn) === sn)
    const details = Array.isArray(row?.packageDetailList)
      ? (row!.packageDetailList as Array<{ productSkuId: number; skuNum: number }>)
      : []
    const pkgNum = Math.max(1, Number(row?.deliverPackageNum) || details.length || 1)
    const buckets = Array.from({ length: pkgNum }, (_, k) => ({
      packageSn: `DEMOPKG${String(k + 1).padStart(3, "0")}`,
      packageDetails: [] as Array<{ productSkuId: number; skuNum: number }>,
    }))
    details.forEach((d, k) => buckets[k % pkgNum]!.packageDetails.push(d))
    return {
      packageInfo: buckets.map((b) => ({
        packageSn: b.packageSn,
        skcNum: b.packageDetails.reduce((a, d) => a + d.skuNum, 0),
        packageDetails: b.packageDetails,
      })),
    }
  },
  "bg.shiporder.staging.get": staging,
  "bg.shiporder.receiveaddressv2.get": receiveAddressGroups,
  "bg.mall.address.get": () => [{ id: 501, addressLabel: "义乌国际仓" }, { id: 502, addressLabel: "深圳宝安仓" }],
  // 对齐 getThirdPartyLogisticsAction 消费端（logistics.get 官方 result 即数组，行字段
  // expressCompanyId/expressCompanyName）——此前回 {logisticsList:[{logisticsId,
  // logisticsName}]}，消费端按数组读恒空
  "bg.shiporder.logistics.get": () => [
    { expressCompanyId: 9001, expressCompanyName: "演示物流" },
    { expressCompanyId: 9002, expressCompanyName: "演示经济快递" },
  ],
  "bg.shiporder.logisticsorder.match": () => ({ logisticsOrderId: 1, expressCompanyName: "演示物流", waybillNo: "DEMO123456" }),
  // 对齐 getLogisticsMatchAction 消费端（logisticsmatch 官方出参）：list[] 比价公司 +
  // mostUsedExpressCompany 平台常用；自动发货向导按「优先顺序」严格口径选司，
  // 两家演示公司默认都不在企业名单里——正好演示「阻断 → 加入优先 → 重选」流程
  "bg.shiporderv3.logisticsmatch.get": () => ({
    list: [
      {
        expressCompanyId: 9001,
        expressCompanyName: "演示专线",
        minSupplierChargeAmount: 4.55,
        maxSupplierChargeAmount: 4.78,
        courierTimeType: 1,
        channelScheduleTimeList: [],
        pickupMethod: 0,
        predictId: 9001,
      },
      {
        expressCompanyId: 9002,
        expressCompanyName: "演示经济快递",
        minSupplierChargeAmount: 3.2,
        maxSupplierChargeAmount: 3.6,
        courierTimeType: 99,
        channelScheduleTimeList: [],
        pickupMethod: 0,
        predictId: 9002,
      },
    ],
    mostUsedExpressCompany: { expressCompanyId: 9001, expressCompanyName: "演示专线", canSaveChargeAmount: "0.5" },
    usePricePrivileges: false,
  }),
  "bg.glo.searchrec.ad.detail.query": adDetails,
  // 对齐 loadAdProducts 灰名单语义（官方参数表）：goodsInfoList 只返回不可投
  // 商品，未出现在名单=可投；条目字段官方为 productId（字符串 DPID 原样对齐）。
  // 每 10 款 1 款带演示原因（type=2 已在线），验证服务端「只返回可投」过滤
  "bg.glo.searchrec.ad.goods.create.query": () => ({
    goodsInfoList: demoProducts().map((p, i) => ({
      productId: p.productId,
      grayReason:
        i % 10 === 9 ? [{ type: 2, reason: "演示：商品已在广告中（Already Online）" }] : [],
    })),
  }),
  // 对齐 predictTemuAdRoasAction 消费端：queryAdBidResult[].predList[{roas}]
  "bg.glo.searchrec.ad.roas.pred": (p) => {
    const reqs = Array.isArray(p.goodsInfoList)
      ? (p.goodsInfoList as Record<string, unknown>[])
      : []
    return { queryAdBidResult: reqs.map(() => ({ predList: [{ roas: 13 }] })) }
  },
  "bg.glo.goods.cats.get": goodsCats,
  "bg.glo.goods.category.match": categoryMatch,
  "bg.glo.goods.attrs.get": goodsAttrs,
  "bg.glo.goods.parentspec.get": () => ({ parentSpecList: [] }),
  "bg.glo.goods.price.list.get": () => ({ priceList: demoProducts().slice(0, 20).map((p) => ({ skcExtCode: p.sn, supplierPrice: p.priceFen })) }),
  "bg.predict.volume.get": () => ({ predictVolume: 0.05, predictWeight: 1.2 }),
  // return_data_key 模式下官方 result 直接是 dataKey 字符串（getShipBoxMarkPrintUrlAction 据此拼打印页）
  "bg.logistics.boxmarkinfo.get": (p) =>
    p.return_data_key === "true"
      ? `demo-boxmark-${Date.now() % 100000}`
      : { boxMarkUrl: "https://placehold.co/400x300/eef2ff/475569?text=BoxMark" },
  // 商品条码打印（labelv2.get，getShipBarcodePrintUrlAction 两段式）：裸查回显请求 SKU
  // （演示店名下 SKU 全量可认领，逐 token 认领不落空）；return_data_key 模式官方 result
  // 直接是 dataKey 字符串（口径同 boxmarkinfo.get）
  "bg.glo.goods.labelv2.get": (p) =>
    p.return_data_key === "true"
      ? `demo-barcode-${Date.now() % 100000}`
      : {
          labelCodePageResult: {
            data: (Array.isArray(p.productSkuIdList) ? p.productSkuIdList : []).map((id) => ({
              productSkuDTO: { productSkuId: Number(id) },
            })),
          },
        },
  "bg.open.accesstoken.info.get.global": () => ({ mallName: "演示店铺", uniqueId: "demo-mall", expiredTime: Date.now() + 365 * 86400_000, apiScopeList: [] }),
  // 换视频链路（2026-11-12 接入；galerie 直传由 /api/temu/video-upload 演示短路返回
  // 虚拟 vid，此处只覆盖两个网关 type）：sign 恒可用、转码即时完成（CC0 样例视频）
  "bg.goods.video.upload.sign.get.global": () => ({ sign: `demo-sign-${Date.now().toString(36)}` }),
  "bg.goods.big.video.upload.result.get.global": (p) => ({
    vid: String(p.vid ?? ""),
    coverUrl: "https://placehold.co/800x800/eef2ff/475569?text=Demo+Video",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    width: 960,
    height: 540,
  }),
}

/** 虚拟响应入口：callTemuApi 拦截层调用（demo 上下文恒 success，不发网络） */
export function demoApiEnvelope<T = unknown>(
  type: string,
  params: Record<string, unknown>,
): { success: true; errorCode: 1000000; errorMsg: ""; result: T; requestId: string } {
  const read = READ_ROUTES[type]
  const result = read ? read(params) : writeSuccess(type, params)
  return {
    success: true,
    errorCode: 1000000,
    errorMsg: "",
    result: result as T,
    requestId: `demo-${Date.now() % 1000000}`,
  }
}
