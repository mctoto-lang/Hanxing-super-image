/* 一次性：店铺广告协议签署状态判定（只读副作用为零）——
 * 传格式合法但不存在的 11 位 productId 调 ad.create（真店实测 ID 均 10-11 位，
 * 99999999999 不在真实 ID 空间）：协议未签报 230016103（协议层先拦），已签报
 * 230012003 unmatch（商品层拦）；两者都不可能创建成功，无真实花费。
 * 注：productId=1 会被参数校验层直接打回 230012000（走不到协议层，首测结论） */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const stores = await db
    .select()
    .from(temuStores)
    .where(sql`${temuStores.tokenState} = 'active' and ${temuStores.accessTokenEncrypted} is not null and ${temuStores.name} <> '发品测试店铺'`)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (const store of stores) {
    const built = await getTemuCallContext(store)
    if ("error" in built) {
      console.log(`${store.name}: ctx 失败 ${built.error}`)
      continue
    }
    try {
      const env = await callTemuApi<Record<string, unknown>>(
        "bg.glo.searchrec.ad.create",
        { createAdReqs: [{ productId: 99999999999, budget: -1, roas: 130000, roasType: 1 }] },
        built,
      )
      // envelope success 只代表网关层；业务结果在 result（成功数/失败明细）
      console.log(`${store.name}: envelope success，result=${JSON.stringify(env.result).slice(0, 300)}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const verdict = msg.includes("230016103")
        ? "→ 广告协议未签（230016103，需主账号在 ads.temu.com 签署）"
        : msg.includes("230012003")
          ? "→ 协议已签（230012003 商品不匹配，数据面正常）"
          : "→ 其他错误"
      console.log(`${store.name}: ${msg.slice(0, 160)} ${verdict}`)
    }
    await sleep(1700)
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
