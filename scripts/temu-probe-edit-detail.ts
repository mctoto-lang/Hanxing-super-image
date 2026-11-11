/* 只读探针：编辑组三接口的数据源形态探测（不改任何商品）。
 * 1) bg.glo.goods.detail.get —— 商品详情（拉当前素材/标题的候选数据源），多参数形态试探
 * 2) bg.glo.goods.edit.task.apply —— 编辑任务申请（只读语义待验证）
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-detail.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = "4666287147"
const SKC_ID = "99470742994"
const GOODS_ID = "601105768830302"

function brief(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v !== "object") return typeof v === "string" && v.length > 90 ? JSON.stringify(v.slice(0, 90)) + "…" : JSON.stringify(v)
  if (depth > 2) return Array.isArray(v) ? `Array(${v.length})` : "{…}"
  if (Array.isArray(v)) return `[${v.slice(0, 3).map((x) => brief(x, depth + 1)).join(", ")}${v.length > 3 ? `, …×${v.length}` : ""}]`
  const entries = Object.entries(v as Record<string, unknown>).slice(0, 14)
  return `{ ${entries.map(([k, x]) => `${k}: ${brief(x, depth + 1)}`).join(", ")}${Object.keys(v as object).length > 14 ? ", …" : ""} }`
}

async function tryCall(
  label: string,
  type: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<void> {
  const { callTemuApi, TemuApiError } = await import("../src/lib/temu-api/client")
  try {
    const r = await callTemuApi<Record<string, unknown>>(type, params, ctx as never)
    console.log(`\n✅ [${label}] ${type} ${JSON.stringify(params)}\n   → ${brief(r.result)}`)
  } catch (err) {
    if (err instanceof TemuApiError) {
      console.log(`\n❌ [${label}] ${type} ${JSON.stringify(params)}\n   → ${err.errorCode} ${err.errorMsg}`)
    } else {
      console.log(`\n💥 [${label}] ${type} ${JSON.stringify(params)}\n   → ${err instanceof Error ? err.message : err}`)
    }
  }
  await new Promise((s) => setTimeout(s, 1200))
}

async function main() {
  const { eq } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  if (!store) {
    console.log(`${STORE_NAME} 不存在`)
    process.exit(0)
  }
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }

  // —— 1. 商品详情：多参数形态试探 ——
  await tryCall("detail-goodsId", "bg.glo.goods.detail.get", { goodsId: GOODS_ID }, ctx)
  await tryCall("detail-productId", "bg.glo.goods.detail.get", { productId: PRODUCT_ID }, ctx)
  await tryCall("detail-skcs", "bg.glo.goods.detail.get", { skcIds: [SKC_ID] }, ctx)

  // —— 2. 编辑任务申请：多参数形态试探（apply 语义未知，从只读形态开始） ——
  await tryCall("apply-productId", "bg.glo.goods.edit.task.apply", { productId: PRODUCT_ID }, ctx)
  await tryCall("apply-goodsId", "bg.glo.goods.edit.task.apply", { goodsId: GOODS_ID }, ctx)
  await tryCall("apply-empty", "bg.glo.goods.edit.task.apply", {}, ctx)

  process.exit(0)
}

void main()
