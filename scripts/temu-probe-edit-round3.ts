/* 只读探针 3 第三轮（2026-11-12）：用 editItem=5 任务（432df278）对比 submit 必填字段点名，
 * 尝试从错误文案反推 editItem 语义（6=尺码已由错误文案证实）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-round3.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = 4666287147
const TASK_ITEM3 = "3763b2c3-92ce-44a2-8b7c-bb36cf9c4ad7"
const TASK_ITEM5 = "432df278-b3cb-4682-b396-78ebc8b7a07a"

const CASES: Array<[string, Record<string, unknown>]> = [
  ["T1-item5任务-无属性字段裸参", { productId: PRODUCT_ID, taskUid: TASK_ITEM5, taskVersion: 1 }],
  ["T2-item5任务-空属性列表", { productId: PRODUCT_ID, taskUid: TASK_ITEM5, taskVersion: 1, productPropertyReqs: [] }],
  ["T3-item3任务-无属性字段裸参", { productId: PRODUCT_ID, taskUid: TASK_ITEM3, taskVersion: 1 }],
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
  for (const [label, params] of CASES) {
    try {
      const r = await callTemuApi<Record<string, unknown>>("bg.glo.goods.edit.task.submit", params, ctx)
      console.log(`\n✅ [${label}]\n   ${JSON.stringify(params).slice(0, 220)}\n   → ${JSON.stringify(r.result).slice(0, 700)}`)
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}]\n   → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
    }
    await new Promise((s) => setTimeout(s, 1500))
  }
  process.exit(0)
}

void main()
