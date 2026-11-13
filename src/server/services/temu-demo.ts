import { and, eq, count } from "drizzle-orm"
import { db } from "@/db/client"
import {
  temuStores,
  temuProducts,
  temuSalesOverviews,
  temuSkuMaps,
  temuShipOrders,
  temuAdsDailies,
  temuAdsProductDailies,
  temuMetricSnapshots,
} from "@/db/schema"
import { isTemuDemoMode } from "@/lib/temu-api/app-config"
import {
  buildDemoProducts,
  buildDemoSalesRows,
  buildDemoShipOrders,
  buildDemoAdsDaily,
  buildDemoAdsProductRows,
  buildDemoSoldoutSnapshot,
  DEMO_PRODUCT_COUNT,
} from "@/lib/temu-api/demo-data"
import { TEMU_TZ, temuDayStr } from "./temu-time"

/**
 * TEMU 演示模式（企业未配置任何 TEMU 应用时，2026-11-11 起为内置虚拟数据）：
 *
 * - 激活：自动创建 1 个演示店铺（is_demo=true、不参与同步——数据为静态虚拟
 *   集非官方同步）+ 向本地表写入 100 款虚拟商品/90 天销量/30 条发货单/7 天
 *   广告日报（售价 100+ 元、单日销量 100+，数据整体偏高）。概览/商品/广告
 *   报表/发货单列表等本地表 tab 天然有数据；实时工作台（备货/核价/质检/
 *   退货/发货台/发品类目）由 callTemuApi 的 demo 拦截层（demo-api.ts）返回
 *   同源虚拟响应，可浏览、可走完 UI 流程，不发任何官方请求。
 * - 退出：企业出现任一 TEMU 应用（或真实店铺）时自动清理演示店铺与全部
 *   演示数据（店铺级联删 13 张数据表）。
 * - 入口：getTemuOverviewAction（/temu 页面每 tab 必调），进程内并发去重。
 */

/** 演示店铺展示名（stores tab 与店铺下拉显示，带「演示」徽章） */
export const DEMO_STORE_NAME = "演示店铺（虚拟数据）"

/** 同进程并发去重（/temu 页面多 tab 并发渲染时防演示店铺双插；跨进程竞态窗口极小可接受） */
const inflight = new Map<string, Promise<boolean>>()

/** 演示模式激活入口：幂等创建演示店铺+虚拟数据；返回是否处于演示模式（供 banner 展示） */
export function ensureDemoStores(enterpriseId: string): Promise<boolean> {
  const hit = inflight.get(enterpriseId)
  if (hit) return hit
  const p = doEnsureDemoStores(enterpriseId).finally(() => inflight.delete(enterpriseId))
  inflight.set(enterpriseId, p)
  return p
}

async function doEnsureDemoStores(enterpriseId: string): Promise<boolean> {
  // 判定每次都算（两个索引查询）：应用出现立即退出演示模式
  const demoMode = await isTemuDemoMode(enterpriseId)
  if (!demoMode) {
    await cleanupDemoStores(enterpriseId)
    return false
  }

  // 幂等：已有演示店铺则只补数据（防数据被误清后回填）
  const [existing] = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(and(eq(temuStores.enterpriseId, enterpriseId), eq(temuStores.isDemo, true)))
    .limit(1)
  if (existing) {
    await ensureDemoData(enterpriseId, existing.id)
    return true
  }

  const [store] = await db
    .insert(temuStores)
    .values({
      enterpriseId,
      appId: null,
      isDemo: true,
      name: DEMO_STORE_NAME,
      mallType: "full",
      mallId: "demo-mall",
      mallName: "演示mall",
      tokenState: "active",
      // 虚拟数据店铺：不参与定时同步（syncDueStores 亦按 is_demo 排除双保险）
      syncEnabled: false,
      enabled: true,
    })
    .returning({ id: temuStores.id })
  if (store) await ensureDemoData(enterpriseId, store.id)
  return true
}

/** 虚拟数据落库（幂等：商品表已有该店数据则跳过） */
async function ensureDemoData(enterpriseId: string, storeId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(temuProducts)
    .where(eq(temuProducts.storeId, storeId))
  if (Number(row?.n ?? 0) > 0) return

  const today = temuDayStr()
  const products = buildDemoProducts()
  const salesRows = buildDemoSalesRows(products, today)
  const shipOrders = buildDemoShipOrders(products, today)
  const adsDaily = buildDemoAdsDaily(today)
  const adsProductRows = buildDemoAdsProductRows(products, today)
  const soldout = buildDemoSoldoutSnapshot()
  void enterpriseId

  await db.transaction(async (tx) => {
    // 商品 100 行
    await tx.insert(temuProducts).values(
      products.map((p) => ({
        storeId,
        productSkcId: p.skcId,
        productId: p.productId,
        productName: p.name,
        category: p.category,
        leafCategoryName: p.leafCategory,
        cat1Name: p.category.split("/")[0],
        supplierId: "demo-supplier",
        skcStatus: 11, // 在售
        productSn: p.sn,
        totalSalesVolume: p.dailyQty.reduce((a, b) => a + b, 0),
        last7DaysSalesVolume: p.dailyQty.slice(-7).reduce((a, b) => a + b, 0),
        mainImageUrl: p.imageUrl,
        buyerName: "演示买手",
        skcCreatedAt: Date.now(),
        addedSiteAt: Date.now(),
        siteName: "US",
        supplierPrice: p.priceFen,
        priceVerifiedAt: Date.now(),
      })),
    )

    // 销量快照 90 天 × 100（概览趋势/四卡/商品页序列）
    for (let i = 0; i < salesRows.length; i += 1000) {
      await tx.insert(temuSalesOverviews).values(
        salesRows.slice(i, i + 1000).map((r) => ({
          storeId,
          skcId: r.skcId,
          capturedAt: r.capturedAt,
          capturedDay: r.capturedDay,
          contentHash: r.contentHash,
          productSn: r.productSn,
          productName: r.productName,
          category: r.category,
          todaySalesVolume: r.todaySalesVolume,
          last7DaysSalesVolume: r.last7DaysSalesVolume,
          last30DaysSalesVolume: r.last30DaysSalesVolume,
          warehouseAvailableStock: r.warehouseAvailableStock,
          waitDeliveryStock: r.waitDeliveryStock,
          shippedStock: r.shippedStock,
          availableSaleDays: r.availableSaleDays,
          priceDetail: r.priceDetail,
          overview: { isFirst: false },
        })),
      )
    }

    // SKU 映射（核价/退货的 SKU → SKC → 商品名反查数据源；每款 3 规格）
    await tx.insert(temuSkuMaps).values(
      products.flatMap((p) =>
        ["1", "2", "3"].map((suffix) => ({
          storeId,
          skuId: `${p.skcId.replace("DSKC", "")}${suffix}`,
          skcId: p.skcId,
          supplierPrice: p.priceFen,
        })),
      ),
    )

    // 发货单 30 条（发货 tab 本地表 + 库存发货单同步子视图被 is_demo 过滤不掺入）
    const capturedAt = new Date()
    await tx.insert(temuShipOrders).values(
      shipOrders.map((o) => ({
        storeId,
        contentHash: `demo-ship-${o.deliveryOrderSn}`,
        capturedAt,
        deliveryOrderSn: o.deliveryOrderSn,
        subPurchaseOrderSn: o.subPurchaseOrderSn,
        productSkcId: Number(o.skcId.replace('DSKC', '')),
        skcExtCode: o.sn,
        subWarehouseId: o.warehouseId,
        subWarehouseName: o.warehouseName,
        status: o.status,
        deliveryAddressId: o.warehouseId,
        deliverPackageNum: o.packageNum,
        skcPurchaseNum: o.skcNum,
        deliverSkcNum: o.status === 1 ? 0 : o.skcNum,
        deliveryOrderCreateTime: new Date(o.createTime),
        deliverTime: o.deliverTime ? new Date(o.deliverTime) : null,
        expectPickUpGoodsTime: new Date(o.expectPickTime),
        expectLatestPickTime: new Date(o.latestPickTime),
        purchaseTime: new Date(o.createTime),
        supplierId: 88888,
      })),
    )

    // 广告日报（店铺级 7 行 + 商品级 700 行）
    await tx.insert(temuAdsDailies).values(
      adsDaily.map((d) => ({
        storeId,
        date: d.date,
        adSpend: d.adSpendFen,
        impressions: d.impressions,
        clicks: d.clicks,
        orders: d.orders,
        gmv: d.gmvFen,
      })),
    )
    for (let i = 0; i < adsProductRows.length; i += 500) {
      await tx.insert(temuAdsProductDailies).values(
        adsProductRows.slice(i, i + 500).map((r) => ({
          storeId,
          date: r.date,
          productId: r.productId,
          spend: Math.round(r.adSpendFen / DEMO_PRODUCT_COUNT),
          imprCnt: Math.round(r.impressions / DEMO_PRODUCT_COUNT),
          clkCnt: Math.round(r.clicks / DEMO_PRODUCT_COUNT),
          orderPayCnt: Math.round(r.orders / DEMO_PRODUCT_COUNT),
          orderPayAmt: Math.round(r.gmvFen / DEMO_PRODUCT_COUNT),
        })),
      )
    }

    // 售罄预警快照（概览售罄卡）
    await tx.insert(temuMetricSnapshots).values({
      storeId,
      source: "api-soldout",
      contentHash: `demo-soldout-${today}`,
      capturedAt: new Date(),
      todaySellOutNum: soldout.todaySellOutNum,
      todaySoonSellOutNum: soldout.todaySoonSellOutNum,
      increaseSellOutNum: soldout.increaseSellOutNum,
      alreadySoldOutNumber: soldout.alreadySoldOutNumber,
    })
  })
  console.log(
    `[temu-demo] 演示数据已就绪（store=${storeId}）：商品 ${DEMO_PRODUCT_COUNT} 款 · 90 天销量 · 发货单 30 · 广告 7 天（时区锚 ${TEMU_TZ}）`,
  )
}

/** 企业出现真实应用/店铺时清理演示店铺与数据（级联清数据表）；无演示店铺时为 no-op */
export async function cleanupDemoStores(enterpriseId: string): Promise<void> {
  await db
    .delete(temuStores)
    .where(and(eq(temuStores.enterpriseId, enterpriseId), eq(temuStores.isDemo, true)))
}
