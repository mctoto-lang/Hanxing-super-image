/* 一次性诊断：用库内真实 token 查授权范围 + 复现 salesv2 报错 + 店铺类型。不打印任何密钥明文。
 * 结构同 worker.ts：loadEnvFile 必须先于动态 import（静态 import 会被提升到它之前）。 */
try {
  process.loadEnvFile()
} catch {
  // .env 不存在时忽略
}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, "RoseBlanche")).limit(1)
  if (!store?.accessTokenEncrypted) {
    console.log("[diag] RoseBlanche 不存在或未录入 token")
    process.exit(0)
  }
  console.log("[diag] 店铺:", store.name, "mallType(库)=", store.mallType, "mallId=", store.mallId, "tokenState=", store.tokenState)

  // 与同步链路同源（temu-sync.getTemuCallContext）：企业级凭证 + testMode 测试账号分支 + 规范解密
  const built = await getTemuCallContext(store)
  if ("error" in built) {
    console.log("[diag] " + built.error)
    process.exit(0)
  }
  const ctx = built

  console.log("\n[diag] 1) bg.mall.info.get（店铺类型）")
  try {
    const r = await callTemuApi<{ semiManagedMall?: boolean }>("bg.mall.info.get", {}, ctx)
    console.log("[diag]   半托 =", r.result?.semiManagedMall === true)
  } catch (e) {
    console.log("[diag]   失败:", e instanceof Error ? e.message : e)
  }

  console.log("\n[diag] 2) bg.open.accesstoken.info.get.global（token 实际授权范围）")
  try {
    const r = await callTemuApi<Record<string, unknown>>("bg.open.accesstoken.info.get.global", {}, ctx)
    const res = r.result ?? {}
    console.log("[diag]   mallName =", res.mallName, "uniqueId =", res.uniqueId, "expiredTime =", res.expiredTime)
    const scopes = Array.isArray(res.apiScopeList) ? (res.apiScopeList as unknown[]) : []
    const names = scopes.map((s) => {
      const o = s as Record<string, unknown>
      return String(o.apiName ?? o.name ?? o.scopeName ?? JSON.stringify(s).slice(0, 60))
    })
    console.log("[diag]   授权接口数 =", names.length)
    console.log("[diag]   销售相关:", names.filter((n) => n.includes("销售") || n.toLowerCase().includes("sales")).join(" | ") || "（无！）")
    console.log("[diag]   全部授权:", names.join("、"))
  } catch (e) {
    console.log("[diag]   失败:", e instanceof Error ? e.message : e)
  }

  console.log("\n[diag] 3) bg.goods.salesv2.get（pageSize 扫描）")
  for (const size of [10, 50, 100, 200]) {
    try {
      const r = await callTemuApi<{ total?: number; subOrderList?: unknown[] }>(
        "bg.goods.salesv2.get",
        { pageNo: 1, pageSize: size },
        ctx,
      )
      console.log(`[diag]   size=${size}: success, 本页=${r.result?.subOrderList?.length ?? 0}`)
    } catch (e) {
      console.log(`[diag]   size=${size}: 失败 → ${e instanceof Error ? e.message.slice(0, 120) : e}`)
    }
  }
  process.exit(0)
}

void main()
