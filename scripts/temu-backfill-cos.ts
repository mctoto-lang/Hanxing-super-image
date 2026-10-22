/* 手动全量回填 TEMU 商品主图转存（只读库转图，不调官方 API；同步链路外的存量兜底）。
 * 用法：npx tsx scripts/temu-backfill-cos.ts [每店每批=50] */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { mirrorProductImages } = await import("../src/server/services/temu-sync")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema")
  const batch = Math.max(1, Number(process.argv[2]) || 50)

  const stores = await db.select({ id: temuStores.id, name: temuStores.name }).from(temuStores)
  for (const s of stores) {
    let total = 0
    // 持续转批直到一轮零成功（余下均为反复失败的烂图，留给同步链路慢重试）；
    // 轮数硬上限防 COS 故障时空转
    for (let round = 0; round < 100; round++) {
      const done = await mirrorProductImages(s.id, batch)
      total += done
      if (done === 0) break
    }
    console.log("[backfill-cos]", s.name, `本轮共转存 ${total} 张`)
  }
  process.exit(0)
}

void main()
