/* 只读探针 2：detail.get 完整 dump + edit.task.apply 参数逐步推进（错误信息钓鱼法）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-detail2.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = "4666287147"

async function tryCall(
  label: string,
  type: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<Record<string, unknown> | null> {
  const { callTemuApi, TemuApiError } = await import("../src/lib/temu-api/client")
  try {
    const r = await callTemuApi<Record<string, unknown>>(type, params, ctx as never)
    console.log(`\n✅ [${label}] ${type} ${JSON.stringify(params)}`)
    return r.result as Record<string, unknown>
  } catch (err) {
    if (err instanceof TemuApiError) {
      console.log(`\n❌ [${label}] ${type} ${JSON.stringify(params)}\n   → ${err.errorCode} ${err.errorMsg}`)
    } else {
      console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
    }
    return null
  }
}

async function main() {
  const { writeFileSync } = await import("node:fs")
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }

  // —— 1. detail.get 完整 dump ——
  const detail = await tryCall("detail", "bg.glo.goods.detail.get", { productId: PRODUCT_ID }, ctx)
  if (detail) {
    writeFileSync(".zcode/probe-detail-dump.json", JSON.stringify(detail, null, 2))
    console.log("   顶层键:", Object.keys(detail).join(", "))
    const g = detail.goods as Record<string, unknown> | undefined
    if (g) console.log("   goods 键:", Object.keys(g).join(", "))
  }

  // —— 2. edit.task.apply 逐步推进 ——
  await new Promise((s) => setTimeout(s, 1200))
  await tryCall("apply-t1", "bg.glo.goods.edit.task.apply", { businessIdType: 1, businessIdList: [PRODUCT_ID] }, ctx)
  await new Promise((s) => setTimeout(s, 1200))
  await tryCall("apply-t2", "bg.glo.goods.edit.task.apply", { businessIdType: 2, businessIdList: [PRODUCT_ID] }, ctx)
  await new Promise((s) => setTimeout(s, 1200))
  await tryCall("apply-mod", "bg.glo.goods.edit.task.apply", { businessIdType: 1, businessIdList: [PRODUCT_ID], modificationList: [{}] }, ctx)

  process.exit(0)
}

void main()
