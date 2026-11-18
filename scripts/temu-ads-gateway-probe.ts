/* 一次性：广告接口网关对照探针（只读）——官方文档标 goods.create.query
 * 「数据存储 CN」，而本站登记走 PA 网关（openapi-b-partner）：同 type 分别发
 * CN/PA 两网关对照，验证「PA 网关查不到 CN 区数据→恒空」假设 */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"

async function main() {
  const { sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { signTemuRequest } = await import("../src/lib/temu-api/sign")

  const [store] = await db
    .select()
    .from(temuStores)
    .where(sql`${temuStores.name} = ${storeName}`)
    .limit(1)
  if (!store) {
    console.error(`store not found: ${storeName}`)
    process.exit(1)
  }
  const built = await getTemuCallContext(store)
  if ("error" in built) {
    console.log("ctx 失败:", built.error)
    return
  }
  const ctx = built as { appKey: string; appSecret: string; accessToken: string }
  const onSale = (
    await db
      .select({ productId: temuProducts.productId })
      .from(temuProducts)
      .where(
        sql`${temuProducts.storeId} = ${store.id} and ${temuProducts.skcStatus} in (1,11) and ${temuProducts.productId} is not null`,
      )
  )
    .map((r) => Number(r.productId))
    .filter(Number.isFinite)

  const CN = "https://openapi.kuajingmaihuo.com/openapi/router"
  const PA = "https://openapi-b-partner.temu.com/openapi/router"
  const post = async (url: string, type: string, params: Record<string, unknown>) => {
    const body: Record<string, unknown> = {
      type,
      timestamp: Math.floor(Date.now() / 1000),
      app_key: ctx.appKey,
      data_type: "JSON",
      access_token: ctx.accessToken,
      ...params,
    }
    body.sign = signTemuRequest(body, ctx.appSecret)
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return (await res.json()) as Record<string, unknown>
  }
  const brief = (env: Record<string, unknown>) => JSON.stringify(env).slice(0, 260)

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // goods.create.query：CN vs PA（在售前 20）
  const p20 = { productIdList: onSale.slice(0, 20) }
  for (const [label, url] of [
    ["CN(kuajingmaihuo)", CN],
    ["PA(openapi-b-partner)", PA],
  ] as const) {
    try {
      const env = await post(url, "bg.glo.searchrec.ad.goods.create.query", p20)
      console.log(`[goods.create.query @${label}] ${brief(env)}`)
    } catch (e) {
      console.log(`[goods.create.query @${label}] 失败:`, e instanceof Error ? e.message.slice(0, 140) : e)
    }
    await sleep(1700)
  }

  // detail.query：CN vs PA
  for (const [label, url] of [
    ["CN", CN],
    ["PA", PA],
  ] as const) {
    try {
      const env = await post(url, "bg.glo.searchrec.ad.detail.query", p20)
      console.log(`[detail.query @${label}] ${brief(env)}`)
    } catch (e) {
      console.log(`[detail.query @${label}] 失败:`, e instanceof Error ? e.message.slice(0, 140) : e)
    }
    await sleep(1700)
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
