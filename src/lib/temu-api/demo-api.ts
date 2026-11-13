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
    .map((p, i) => ({
      qcBillId: 900000 + i,
      productSkuId: `${p.skcId.replace("DSKC", "")}1`,
      productSkcId: p.skcId,
      spuId: p.productId,
      skuName: p.name,
      spec: i % 2 === 0 ? "白色 均码" : "黑色 均码",
      catName: p.leafCategory,
      purchaseNo: `DEMOPO${String((i % 100) + 1).padStart(5, "0")}`,
      qcResultUpdateTime: `${bjToday()}T11:00:00+08:00`,
      thumbUrl: p.imageUrl,
      skuQcResult: i % 3 === 1 ? 2 : 1,
    }))
  // 服务端过滤（与真实接口入参同构）：skuQcResult 1=合格 2=不合格（UI 默认筛 2）
  const qcF = typeof params.skuQcResult === "number" ? params.skuQcResult : null
  const filtered = qcF == null ? rows : rows.filter((r) => r.skuQcResult === qcF)
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
  const filtered = status == null ? rows : rows.filter((_, i) => i % 2 === status % 2)
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
  const start = (pageNo - 1) * pageSize
  return { total: rows.length, packageDetailDTOList: rows.slice(start, start + pageSize) }
}

/* ─── 发货单（bg.shiporderv2.get：fresh 拉取路径，与落库虚拟数据同源） ─── */
function shipOrders(params: Record<string, unknown>) {
  const pageNo = Number(params.pageNo ?? 1)
  const pageSize = Number(params.pageSize ?? 20)
  const orders = buildDemoShipOrders(demoProducts(), bjToday())
  const list = orders.map((o) => ({
    deliveryOrderSn: o.deliveryOrderSn,
    subPurchaseOrderSn: o.subPurchaseOrderSn,
    productSkcId: Number(o.skcId.replace("DSKC", "")),
    skcExtCode: o.sn,
    status: o.status,
    deliverSkcNum: o.skcNum,
    deliveryAddressId: o.warehouseId,
    deliveryOrderCreateTime: new Date(o.createTime).getTime(),
    deliverTime: o.deliverTime ? new Date(o.deliverTime).getTime() : null,
    receiveTime: o.status >= 3 ? new Date(o.createTime).getTime() + 86400_000 : null,
    expectPickUpGoodsTime: new Date(o.expectPickTime).getTime(),
    expectLatestPickTime: new Date(o.latestPickTime).getTime(),
    subWarehouseName: o.warehouseName,
    deliverPackageNum: o.packageNum,
    purchaseStockType: 1,
    factoryDirect: false,
  }))
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

/* ─── 广告计划（bg.glo.searchrec.ad.detail.query，PA） ─── */
function adPlans() {
  const rows = demoProducts()
    .slice(0, 8)
    .map((p, i) => ({
      adPlanId: 8000 + i,
      adPlanName: `演示推广计划-${p.sn}`,
      adStatus: i % 2 === 0 ? 1 : 2, // 1=投放中
      dayBudget: 5000 + i * 100,
      spendFen: p.priceFen * 2,
      orderCnt: 100 + i * 10,
      orderPayAmtFen: p.priceFen * (100 + i),
      productSkcId: p.skcId,
      skcExtCode: p.sn,
      goodsName: p.name,
      productImgUrl: p.imageUrl,
    }))
  return { adPlanList: rows, total: rows.length }
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
  if (type.includes("cancel")) return { successList: params.purchaseOrderSnList ?? params.deliveryOrderSnList ?? [] }
  if (type.includes("apply")) return { purchaseOrderSn: `DEMOAPPLY${Date.now() % 100000}` }
  if (type === "bg.glo.goods.add") return { goodsSkcId: 990001, goodsId: 990001 }
  if (type === "bg.shiporderv3.create") return { deliveryOrderSn: `DEMONEW${Date.now() % 100000}` }
  if (type === "bg.shiporder.packing.send") return { dataKey: `demo-print-${Date.now() % 100000}` }
  if (type === "bg.glo.searchrec.ad.modify") return { adPlanId: 8001 }
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
  "bg.shiporderv2.get": shipOrders,
  "bg.shiporder.staging.get": staging,
  "bg.shiporder.receiveaddressv2.get": () => ({
    addressList: [{ addressId: 601, addressLabel: "义乌国际仓", receiverName: "演示仓", phone: "13800000000", province: "浙江省", city: "金华市", detailAddress: "义乌市XXX路1号" }],
  }),
  "bg.mall.address.get": () => [{ id: 501, addressLabel: "义乌国际仓" }, { id: 502, addressLabel: "深圳宝安仓" }],
  "bg.shiporder.logistics.get": () => ({ logisticsList: [{ logisticsId: 1, logisticsName: "演示物流" }] }),
  "bg.shiporder.logisticsorder.match": () => ({ logisticsOrderId: 1, expressCompanyName: "演示物流", waybillNo: "DEMO123456" }),
  "bg.shiporderv3.logisticsmatch.get": () => ({ matchList: [{ channelName: "演示专线", firstWeightFen: 500, continueWeightFen: 100, expectPickDay: 1 }] }),
  "bg.glo.searchrec.ad.detail.query": adPlans,
  "bg.glo.searchrec.ad.goods.create.query": () => ({ goodsList: demoProducts().slice(0, 10).map((p) => ({ productSkcId: p.skcId, goodsName: p.name, skcExtCode: p.sn })) }),
  "bg.glo.goods.cats.get": goodsCats,
  "bg.glo.goods.category.match": categoryMatch,
  "bg.glo.goods.attrs.get": goodsAttrs,
  "bg.glo.goods.parentspec.get": () => ({ parentSpecList: [] }),
  "bg.glo.goods.price.list.get": () => ({ priceList: demoProducts().slice(0, 20).map((p) => ({ skcExtCode: p.sn, supplierPrice: p.priceFen })) }),
  "bg.predict.volume.get": () => ({ predictVolume: 0.05, predictWeight: 1.2 }),
  "bg.logistics.boxmarkinfo.get": () => ({ boxMarkUrl: "https://placehold.co/400x300/eef2ff/475569?text=BoxMark" }),
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
