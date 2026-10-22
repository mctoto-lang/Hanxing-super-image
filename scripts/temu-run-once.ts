/* 一次性：重验 RoseBlanche token（修正被截断的 mallId）+ 立即跑一轮真实同步 */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { verifyStoreToken, syncStore } = await import("../src/server/services/temu-sync")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, "RoseBlanche")).limit(1)
  if (!store) {
    console.log("[run] RoseBlanche 不存在")
    process.exit(0)
  }

  const v = await verifyStoreToken(store.id)
  console.log("[run] 重验:", JSON.stringify({ ok: v.ok, mallType: v.mallType, mallIdLen: v.mallId?.length }))

  const t0 = Date.now()
  const outcome = await syncStore(store.id)
  console.log(`[run] 同步完成（${Math.round((Date.now() - t0) / 1000)}s）: ok=`, outcome.status?.ok)
  for (const [source, r] of Object.entries(outcome.status?.sources ?? {})) {
    console.log(`[run]   ${source}: ok=${r.ok} count=${r.count ?? 0}${r.skipped ? "（跳过）" : ""}${r.error ? " err=" + r.error.slice(0, 100) : ""}`)
  }
  process.exit(0)
}

void main()
