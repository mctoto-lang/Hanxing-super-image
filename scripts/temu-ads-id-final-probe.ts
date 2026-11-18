/* 一次性：goods.create.query 穷尽终验（只读）——
 * a) goodsIdList 变体入参（US 旧口径字段名，排除 bg.glo 网关字段路由差异）
 * b) roas.pred 官方回显确认有效的在售 productId 直调（封死「ID 不正确」假设） */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"
// argv[3]：逗号分隔 productId，缺省回落 roas.pred 2026-11-17 实测回显确认有效的 5 个
const argProductIds = (process.argv[3] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isFinite)
const verified = argProductIds.length > 0 ? argProductIds : [7174880704, 9242249196, 2058655455, 50950929583, 7153931744]

async function main() {
  const { sql } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

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
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  type Item = { productId?: unknown; goodsId?: unknown; grayReason?: Array<{ type?: unknown; reason?: unknown }> }
  const call = async (label: string, params: Record<string, unknown>) => {
    try {
      const env = await callTemuApi<{ goodsInfoList?: Item[] }>(
        "bg.glo.searchrec.ad.goods.create.query",
        params,
        built,
      )
      const list = env.result?.goodsInfoList ?? []
      console.log(
        `[${label}] 返回=${list.length}` + (list.length ? ` 首条=${JSON.stringify(list[0]).slice(0, 200)}` : ""),
      )
    } catch (e) {
      console.log(`[${label}] 失败:`, e instanceof Error ? e.message.slice(0, 200) : e)
    }
    await sleep(1700)
  }

  await call("productIdList×已验证5", { productIdList: verified })
  await call("goodsIdList×已验证5(US旧口径)", { goodsIdList: verified })
  await call("两字段同传×已验证5", { productIdList: verified, goodsIdList: verified })
  console.log("done")
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
