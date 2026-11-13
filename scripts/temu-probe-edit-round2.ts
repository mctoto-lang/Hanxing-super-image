/* 只读探针 3 第二轮（2026-11-12）：apply 已打通（bizIdType/bizIds/productEditItems 正确，
 * editItem=3 返回 taskUid）。本轮目标：找到「标题」的提交载体。
 *
 * 1. editItem 枚举扫描（1/2/4/5/6——非法值报 Invalid Edit Item，合法值返回 taskUid）；
 * 2. 用真 taskUid 探 task.submit：空属性列表 / 假 pid 属性 / 附加 productName 字段是否被识别。
 *
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-round2.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = 4666287147
/** 第一轮 editItem=3 apply 创建的任务（本轮 submit 探针复用，不额外创建） */
const REAL_TASK_UID = "3763b2c3-92ce-44a2-8b7c-bb36cf9c4ad7"

const CASES: Array<[string, string, Record<string, unknown>]> = [
  ["apply", "A1-editItem=1", { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe", editItem: 1 }] }],
  ["apply", "A2-editItem=2", { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe", editItem: 2 }] }],
  ["apply", "A4-editItem=4", { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe", editItem: 4 }] }],
  ["apply", "A5-editItem=5", { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe", editItem: 5 }] }],
  ["apply", "A6-editItem=6", { bizIdType: 1, bizIds: [PRODUCT_ID], productEditItems: [{ editAdvice: "probe", editItem: 6 }] }],
  [
    "submit",
    "S1-空属性列表",
    { productId: PRODUCT_ID, taskUid: REAL_TASK_UID, taskVersion: 1, productPropertyReqs: [] },
  ],
  [
    "submit",
    "S2-假pid属性",
    {
      productId: PRODUCT_ID,
      taskUid: REAL_TASK_UID,
      taskVersion: 1,
      productPropertyReqs: [{ pid: 999999, vid: 999999, propName: "probe", propValue: "probe" }],
    },
  ],
  [
    "submit",
    "S3-附加productName字段（字段识别探针）",
    {
      productId: PRODUCT_ID,
      taskUid: REAL_TASK_UID,
      taskVersion: 1,
      productName: "probe title",
      productPropertyReqs: [],
    },
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
      console.log(`\n✅ [${label}]\n   ${JSON.stringify(params).slice(0, 220)}\n   → ${JSON.stringify(r.result).slice(0, 700)}`)
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}]\n   ${JSON.stringify(params).slice(0, 220)}\n   → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
    }
    await new Promise((s) => setTimeout(s, 1500))
  }
  process.exit(0)
}

void main()
