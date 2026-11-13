/**
 * 一次性探测脚本：官方沙箱测试账号（全托+半托）打各 tab 数据源读接口，
 * 确认演示模式可用性与各接口沙箱数据量（2026-11-11 演示模式批次前置探测）。
 *
 * 运行：pnpm tsx scripts/temu-sandbox-probe.ts
 */
import { callTemuApi } from "../src/lib/temu-api/client"
import { TEST_ACCOUNTS } from "../src/lib/temu-api/test-accounts"

interface ProbeDef {
  name: string
  type: string
  params: Record<string, unknown>
  /** 从 result 里挑出数组字段的键名（用于统计行数） */
  listKey: string
}

const PROBES: ProbeDef[] = [
  { name: "店铺信息", type: "bg.mall.info.get", params: {}, listKey: "" },
  { name: "销售/商品(同步主源)", type: "bg.goods.salesv2.get", params: { pageNo: 1, pageSize: 50 }, listKey: "subOrderList" },
  { name: "备货单", type: "bg.purchaseorderv2.get", params: { pageNo: 1, pageSize: 50, statusList: [0, 1] }, listKey: "subOrderForSupplierList" },
  { name: "核价", type: "bg.price.review.page.query", params: { pageNo: 1, pageSize: 20 }, listKey: "reviewSamplePriceList" },
  { name: "发货单", type: "bg.shiporderv2.get", params: { pageNo: 1, pageSize: 20 }, listKey: "shipOrderList" },
  { name: "质检", type: "bg.goods.qualityinspection.get", params: { pageNo: 1, pageSize: 20 }, listKey: "qualityInspectionList" },
  { name: "退货", type: "bg.refund.returnpackagelist.get", params: { pageNo: 1, pageSize: 20 }, listKey: "returnPackageList" },
  { name: "广告计划(PA)", type: "bg.glo.searchrec.ad.detail.query", params: { pageNo: 1, pageSize: 20 }, listKey: "adPlanList" },
]

async function main() {
  for (const acct of [TEST_ACCOUNTS.fullManaged, TEST_ACCOUNTS.semiManaged]) {
    console.log(`\n===== ${acct.label}（mallType=${acct.mallType}）=====`)
    const ctx = {
      appKey: acct.appKey,
      appSecret: acct.appSecret,
      accessToken: acct.accessToken,
      rateKey: `probe-${acct.mallType}`,
      qps: 3,
      timeoutMs: 20000,
    }
    for (const p of PROBES) {
      try {
        const r = await callTemuApi<Record<string, unknown>>(p.type, p.params, ctx)
        const result = r.result ?? {}
        const list = p.listKey ? (result[p.listKey] as unknown[] | undefined) : undefined
        const total = result.total
        const keys = Object.keys(result).slice(0, 8)
        console.log(
          `  ${p.name.padEnd(14)} OK  ${list ? `rows=${list.length}` : ""}${total !== undefined ? ` total=${total}` : ""} keys=[${keys.join(",")}]`,
        )
      } catch (e) {
        console.log(
          `  ${p.name.padEnd(14)} FAIL ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 90)}` : e}`,
        )
      }
    }
  }
}

main()
  .catch((e) => {
    console.error("探测脚本异常：", e)
    process.exitCode = 1
  })
  .finally(() => process.exit())
