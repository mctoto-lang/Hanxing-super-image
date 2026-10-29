/* 只读探针续：predict.volume 组合语义（单张间歇性/聚合性）验证。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-volume-combos.ts */
try {
  process.loadEnvFile()
} catch {}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, "RoseBlanche")).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const vol = async (sns: string[]) => {
    const v = await callTemuApi<{ predictVolume?: unknown }>(
      "bg.predict.volume.get",
      { deliveryOrderSnList: sns },
      ctx,
    )
    return JSON.stringify(v.result?.predictVolume ?? null)
  }

  const A = "FH2610272172644" // status0 B006（此前单张 null）
  const B = "FH2610261209440" // status1 B121（单张 null）
  const C = "FH2610272442839" // status5 B019（单张 0.0521）
  const cases: Array<[string, string[]]> = [
    ["A 单张重试1", [A]],
    ["A 单张重试2", [A]],
    ["B 单张重试", [B]],
    ["C 单张重试", [C]],
    ["A+B 两单", [A, B]],
    ["A+C 两单", [A, C]],
    ["B+C 两单", [B, C]],
  ]
  for (const [label, sns] of cases) {
    try {
      console.log(`${label} [${sns.join(",")}] → ${await vol(sns)}`)
    } catch (e) {
      console.log(`${label} → 失败: ${e instanceof Error ? e.message.slice(0, 70) : e}`)
    }
    await new Promise((s) => setTimeout(s, 900))
  }
  process.exit(0)
}

void main()
