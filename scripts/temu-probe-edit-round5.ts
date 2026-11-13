/* 只读探针 3 第五轮（2026-11-12）：bg.local.goods.partial.update 在 PA 网关 7000016，
 * 枚举其余官方 router 域名（us / eu / CN 跨境卖货）——同值提交安全模式（无真实改动）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-round5.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = 4666287147
const CURRENT_NAME =
  "Blank Recipe Book to Write In, 150 Pages Holds 144 Recipes, A5 (6.0x8.5 Inch) Vegan Leather Cover with Foil Stamping & Front Pocket, Lays Flat for Easy Use, Waterproof Cooking Journal"

const ROUTERS: Array<[string, string]> = [
  ["US", "https://openapi-b-us.temu.com/openapi/router"],
  ["EU", "https://openapi-b-eu.temu.com/openapi/router"],
  ["CN", "https://openapi.kuajingmaihuo.com/openapi/router"],
  ["PA(对照)", "https://openapi-b-partner.temu.com/openapi/router"],
]

const TYPE = "bg.local.goods.partial.update"

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { signTemuRequest } = await import("../src/lib/temu-api/sign")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const c = ctx as { appKey: string; appSecret: string; accessToken: string }
  for (const [label, url] of ROUTERS) {
    const body: Record<string, unknown> = {
      type: TYPE,
      timestamp: Math.floor(Date.now() / 1000),
      app_key: c.appKey,
      data_type: "JSON",
      access_token: c.accessToken,
      goodsId: PRODUCT_ID,
      goodsBasic: { goodsName: CURRENT_NAME },
    }
    body.sign = signTemuRequest(body, c.appSecret)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      console.log(`\n[${label}] ${url} HTTP ${res.status}\n   → ${text.slice(0, 400)}`)
    } catch (err) {
      console.log(`\n[${label}] ${url}\n   → 网络失败: ${err instanceof Error ? err.message : err}`)
    }
    await new Promise((s) => setTimeout(s, 1500))
  }
  process.exit(0)
}

void main()
