/* 只读探针 3（2026-11-12 复测版）：edit.task.apply 官方参数表字段名复测。
 * 背景：首轮探针（2026-11-09）只试过 businessIdType/businessIdList/modificationList 系字段名，
 * 全部报"字段未识别"；后来在官方文档站取证缓存 .zcode/temu-doc-audit/doc-bg.glo.goods.edit.task.apply.json
 * 里发现真实字段名是 bizIdType / bizIds / productEditItems[{editAdvice, editItem}]——本轮复测。
 *
 * 安全分级（前三步无副作用，后两步作用于测试品）：
 * 1. 空参对照——错误文案若点名 bizIdType/bizIds/productEditItems 即证明字段名正确；
 * 2. 非法 editItem=99——期望 2000042 Illegal Edit Item（字段识别但枚举非法，不产生任务）；
 * 3. 不存在的 productId + 合法 editItem=3——期望"商品不存在"类业务错误（不产生任务）；
 * 4. 测试品 + editItem=3——apply 语义验证（可能创建属性编辑任务，测试品可承受）；
 * 5. task.submit 假 taskUid——参数识别 vs 任务不存在的错误分类。
 *
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-apply.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = 4666287147

const CASES: Array<[string, string, Record<string, unknown>]> = [
  [
    "apply",
    "1-空参对照（错误文案点名字段=参数表正确）",
    {},
  ],
  [
    "apply",
    "2-非法枚举 editItem=99（期望 2000042，无副作用）",
    { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe verification", editItem: 99 }] },
  ],
  [
    "apply",
    "3-不存在商品+合法 editItem=3（期望业务错误，无副作用）",
    { bizIdType: 1, bizIds: [999999999999], productEditItems: [{ editAdvice: "probe verification", editItem: 3 }] },
  ],
  [
    "apply",
    "4-测试品+editItem=3（apply 语义验证，可能创建任务）",
    { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe verification", editItem: 3 }] },
  ],
  [
    "submit",
    "5-task.submit 假 taskUid（错误分类探针）",
    { productId: PRODUCT_ID, taskUid: "PROBE-FAKE-UID", taskVersion: 1, productPropertyReqs: [] },
  ],
]

const METHODS: Record<string, string> = {
  apply: "bg.glo.goods.edit.task.apply",
  submit: "bg.glo.goods.edit.task.submit",
}

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
  for (const [kind, label, params] of CASES) {
    try {
      const r = await callTemuApi<Record<string, unknown>>(METHODS[kind]!, params, ctx)
      console.log(`\n✅ [${label}]\n   ${JSON.stringify(params).slice(0, 200)}\n   → ${JSON.stringify(r.result).slice(0, 700)}`)
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}]\n   ${JSON.stringify(params).slice(0, 200)}\n   → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
    }
    await new Promise((s) => setTimeout(s, 1500))
  }
  process.exit(0)
}

void main()
