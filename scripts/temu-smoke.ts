/* 一次性冒烟脚本：官方测试账号打真实网关，验证签名与网关路由被服务端接受 */
import { callTemuApi } from "../src/lib/temu-api/client"
import { TEST_ACCOUNTS } from "../src/lib/temu-api/test-accounts"
import { signTemuRequest } from "../src/lib/temu-api/sign"

async function main() {
  const acct = TEST_ACCOUNTS.fullManaged
  const ctx = {
    appKey: acct.appKey,
    appSecret: acct.appSecret,
    accessToken: acct.accessToken,
    rateKey: "smoke",
    qps: 3,
    timeoutMs: 20000,
  }

  console.log("[smoke] 1) bg.mall.info.get（CN 网关）…")
  try {
    const r = await callTemuApi<{ semiManagedMall?: boolean; isThriftStore?: boolean }>(
      "bg.mall.info.get",
      {},
      ctx,
    )
    console.log("[smoke]   success =", r.success, "result =", JSON.stringify(r.result), "requestId =", r.requestId)
  } catch (e) {
    console.log("[smoke]   失败：", e instanceof Error ? `${e.name}: ${e.message}` : e)
  }

  console.log("[smoke] 2) bg.open.accesstoken.info.get.global（PA 网关）…")
  try {
    const r = await callTemuApi<Record<string, unknown>>(
      "bg.open.accesstoken.info.get.global",
      {},
      ctx,
    )
    const keys = Object.keys(r.result ?? {})
    console.log("[smoke]   success =", r.success, "result keys =", keys.slice(0, 12).join(","), "requestId =", r.requestId)
  } catch (e) {
    console.log("[smoke]   失败：", e instanceof Error ? `${e.name}: ${e.message}` : e)
  }

  console.log("[smoke] 3) bg.glo.goods.list.get（PA 网关，page=1）…")
  try {
    const r = await callTemuApi<{ data?: unknown[]; totalCount?: number }>(
      "bg.glo.goods.list.get",
      { page: 1, pageSize: 5 },
      ctx,
    )
    console.log(
      "[smoke]   success =", r.success,
      "totalCount =", r.result?.totalCount,
      "firstKeys =", r.result?.data?.[0] ? Object.keys(r.result.data[0] as object).slice(0, 10).join(",") : "(空)",
    )
  } catch (e) {
    console.log("[smoke]   失败：", e instanceof Error ? `${e.name}: ${e.message}` : e)
  }

  // 文档已知答案自检（不应失败）
  const sign = signTemuRequest(
    {
      type: "bg.shiporder.staging.add",
      timestamp: 1739688901,
      app_key: "47bb4bb7769e12d9f7aa93cf029fe529",
      data_type: "JSON",
      access_token: "1zz6vlvwq1kulyyyybkdy0bfwnlrgfls8e4ssefhxpanh1mltyodjacc",
      joinInfoList: [{ deliveryAddressType: 1, subPurchaseOrderSn: "WB2411113267800" }],
    },
    "ac0a3e952eaaa5b19c0e615c2ef497f50afa6e49",
  )
  console.log("[smoke] 签名已知答案:", sign === "BA49C39EFE53461582CC779CDA2ADB3E" ? "PASS" : "FAIL")
  process.exit(0)
}

void main()
