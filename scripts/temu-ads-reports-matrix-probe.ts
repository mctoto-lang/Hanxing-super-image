/* 一次性：reports 参数矩阵探针（只读）——mall/goods 两接口 × 窗口跨度组合，
 * 定位 230012000 bad query params 的真实参数约束（疑时间窗跨度限制） */
try {
  process.loadEnvFile()
} catch {}

const storeName = process.argv[2] || "RoseBlanche"
// argv[3]：逗号分隔 productId（goods 单数场景取首个），缺省回落已知在投商品 2058655455
const argProductIds = (process.argv[3] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isFinite)
const adProductIds = argProductIds.length > 0 ? argProductIds : [2058655455]

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
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
  const win = (days: number) => ({
    startTs: new Date(`${day(days - 1)}T00:00:00+08:00`).getTime(),
    endTs: new Date(`${day(0)}T23:59:59.999+08:00`).getTime(),
  })

  type Info = { reportsItemList?: unknown[]; summary?: unknown }
  const probe = async (label: string, type: string, params: Record<string, unknown>) => {
    try {
      const env = await callTemuApi<{ reportInfo?: Info }>(type, params, built)
      const items = env.result?.reportInfo?.reportsItemList
      console.log(
        `[${label}] 行=${Array.isArray(items) ? items.length : 0} summary=${JSON.stringify(env.result?.reportInfo?.summary ?? {}).slice(0, 120)}`,
      )
    } catch (e) {
      console.log(`[${label}] 失败:`, e instanceof Error ? e.message.slice(0, 130) : e)
    }
    await sleep(1700)
  }

  // 跨度矩阵：单日(昨日)/3 日/7 日/31 日/92 日 × mall/goods
  for (const days of [1, 3, 7, 31, 92]) {
    const label = days === 1 ? "昨日单日" : `近${days}日`
    await probe(`${label}·mall`, "bg.glo.searchrec.ad.reports.mall.query", win(days))
    await probe(`${label}·goods`, "bg.glo.searchrec.ad.reports.goods.query", win(days))
  }
  // goods 带 productId 单数（默认已知在投商品 2058655455，argv[3] 首个覆盖）
  await probe("昨日·goods+productId", "bg.glo.searchrec.ad.reports.goods.query", {
    ...win(1),
    productId: adProductIds[0],
  })
}

main()
  .catch((e) => console.error(e))
  .finally(() => process.exit(0))
