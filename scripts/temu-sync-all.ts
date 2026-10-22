/* 手动触发全店铺同步（等价 worker 一轮，maxAge=0 强制全部到期）。用法：npx tsx scripts/temu-sync-all.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { syncDueStores } = await import("../src/server/services/temu-sync")
  const outcomes = await syncDueStores(0)
  for (const o of outcomes) {
    const parts = o.status
      ? Object.entries(o.status.sources)
          .map(([k, v]) => `${k.replace("api-", "")}:${v.ok ? (v.count ?? 0) : `失败(${String(v.error ?? "").slice(0, 60)})`}`)
          .join(" ")
      : String(o.skipped)
    console.log("[sync-all]", o.storeId.slice(0, 8), o.status?.ok ? "OK" : "PARTIAL", parts)
  }
  process.exit(0)
}

void main()
