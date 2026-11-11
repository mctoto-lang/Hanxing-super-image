/* 只读探针 4：CN 网关 edit 变体钓鱼（中文报错往往给字段级线索）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-cn.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = "4666287147"
const GOODS_ID = "601105768830302"

const CALLS: Array<[string, string, Record<string, unknown>]> = [
  ["cn-edit-empty", "bg.goods.edit", {}],
  ["cn-edit-goodsId", "bg.goods.edit", { goodsId: GOODS_ID }],
  ["cn-apply-empty", "bg.goods.edit.task.apply", {}],
  ["glo-edit-empty", "bg.glo.goods.edit", {}],
]

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi, TemuApiError } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  for (const [label, type, params] of CALLS) {
    try {
      const r = await callTemuApi<Record<string, unknown>>(type, params, ctx)
      console.log(`\n✅ [${label}] ${type} ${JSON.stringify(params).slice(0, 100)}\n   → ${JSON.stringify(r.result).slice(0, 500)}`)
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}] ${type} ${JSON.stringify(params).slice(0, 100)}\n   → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
    }
    await new Promise((s) => setTimeout(s, 1500))
  }
  process.exit(0)
}

void main()
