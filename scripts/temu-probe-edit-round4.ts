/* 只读探针 3 第四轮（2026-11-12）：换标题——官方接口 bg.local.goods.partial.update
 * （EU 站授权清单确认存在；官方标题字段 goodsBasic.goodsName，第三方官方集成文档实证）。
 * 流程：detail.get 拿现标题 → 同值提交（无变化被拒则加后缀真改一次）→ detail.get 回读验证。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-round4.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = 4666287147

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

  const call = async (label: string, method: string, params: Record<string, unknown>) => {
    try {
      const r = await callTemuApi<Record<string, unknown>>(method, params, ctx)
      console.log(`\n✅ [${label}]\n   → ${JSON.stringify(r.result).slice(0, 800)}`)
      return r.result
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}] ${method}\n   ${JSON.stringify(params).slice(0, 200)}\n   → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
      return null
    }
  }

  // 1. 现标题
  const detail = await call("1-detail.get 现标题", "bg.glo.goods.detail.get", { productId: PRODUCT_ID })
  const currentName = typeof detail?.productName === "string" ? detail.productName : ""
  console.log(`\n当前标题: 「${currentName}」`)

  // 2. 同值提交（官方若比对无变化会拒绝——那也是「接口可用」的证据）
  await call("2a-partial.update 同值提交", "bg.local.goods.partial.update", {
    goodsId: PRODUCT_ID,
    goodsBasic: { goodsName: currentName },
  })

  // 2b. 若 2a 被拒/无报错，加后缀真改一次（测试品可承受）
  const newName = `${currentName} TP`.trim()
  await new Promise((s) => setTimeout(s, 1500))
  await call("2b-partial.update 真改（+ TP 后缀）", "bg.local.goods.partial.update", {
    goodsId: PRODUCT_ID,
    goodsBasic: { goodsName: newName },
  })

  // 3. 回读验证
  await new Promise((s) => setTimeout(s, 2500))
  const after = await call("3-detail.get 回读", "bg.glo.goods.detail.get", { productId: PRODUCT_ID })
  const afterName = typeof after?.productName === "string" ? after.productName : ""
  console.log(`\n回读标题: 「${afterName}」`)
  console.log(afterName === newName ? "\n🎯 换标题链路验证成功" : "\n⚠️ 回读标题与提交值不一致（可能有同步延迟或未生效）")
  process.exit(0)
}

void main()
