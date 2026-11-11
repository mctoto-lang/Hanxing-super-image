/* 只读探针 3：edit.task.apply 参数名变体钓鱼（全部为参数级试探，不带修改内容不会产生编辑任务）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-apply.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = "4666287147"

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ["num-list", { businessIdType: 1, businessIdList: [4666287147], modificationList: [{ modificationType: 1 }] }],
  ["str-type", { businessIdType: "1", businessIdList: [4666287147], modificationList: [{ modificationType: 1 }] }],
  ["wrap-req", { editTaskApplyReq: { businessIdType: 1, businessIdList: [4666287147], modificationList: [{ modificationType: 1 }] } }],
  ["goods-wrap", { goodsEditTaskApplyReq: { businessIdType: 1, businessIdList: [4666287147], modificationList: [{ modificationType: 1 }] } }],
  ["biz-fields", { businessIdType: 1, businessIdList: [4666287147], productModificationList: [{ modificationType: 1 }] }],
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
  for (const [label, params] of VARIANTS) {
    try {
      const r = await callTemuApi<Record<string, unknown>>("bg.glo.goods.edit.task.apply", params, ctx)
      console.log(`\n✅ [${label}] ${JSON.stringify(params).slice(0, 140)}\n   → ${JSON.stringify(r.result).slice(0, 600)}`)
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}] ${JSON.stringify(params).slice(0, 140)}\n   → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
    }
    await new Promise((s) => setTimeout(s, 1500))
  }
  process.exit(0)
}

void main()
