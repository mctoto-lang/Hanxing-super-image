/* 一次性：查各店 token 授权 scope（bg.open.accesstoken.info.get.global，
 * 看 apiScopeList 是否含广告域——goods.create.query 恒空根因排查，只读） */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const stores = await db.select().from(temuStores).where(eq(temuStores.tokenState, "active"))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (const store of stores) {
    if (!store.accessTokenEncrypted) continue
    const built = await getTemuCallContext(store)
    if ("error" in built) {
      console.log(`\n===== ${store.name}: ctx 失败 ${built.error}`)
      continue
    }
    try {
      const env = await callTemuApi<{ mallName?: unknown; apiScopeList?: string[] }>(
        "bg.open.accesstoken.info.get.global",
        {},
        built,
      )
      const scopes = env.result?.apiScopeList ?? []
      const ad = scopes.filter((s) => s.includes("searchrec") || s.includes(".ad."))
      console.log(`\n===== ${store.name}（${store.mallName ?? "?"}）scope 数=${scopes.length}`)
      console.log("广告域 scope:", JSON.stringify(ad))
    } catch (e) {
      console.log(`\n===== ${store.name} 失败:`, e instanceof Error ? e.message.slice(0, 160) : e)
    }
    await sleep(1500)
  }
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
