/* 写探针（部分位提交语义确认）：edit.pictures.submit 只改 skcList[].colorImageUrl 为「另一商品的官方图」。
 * 若 success → 部位提交成立（换图 UI 可做「只提交要改的位」）。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-pics2.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = "4666287147"
const SKC_ID = "99470742994"

async function main() {
  const { eq, ne, and } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi, TemuApiError } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  // 拿另一张官方图作「新图」
  const [other] = await db
    .select({ img: temuProducts.mainImageUrl, sn: temuProducts.productSkcId })
    .from(temuProducts)
    .where(and(eq(temuProducts.storeId, store.id), ne(temuProducts.productSkcId, SKC_ID)))
    .limit(5)
  const newImg = other?.img
  if (!newImg) {
    console.log("无参考图，中止")
    process.exit(0)
  }
  console.log("新图（另一商品主图）:", newImg.slice(0, 70))

  // 轮播位单独提交：第一张换成新图、其余四张用商品现主图（轮播 ≥5 张官方规则）
  const [self] = await db
    .select({ img: temuProducts.mainImageUrl })
    .from(temuProducts)
    .where(and(eq(temuProducts.storeId, store.id), eq(temuProducts.productSkcId, SKC_ID)))
    .limit(1)
  const body = {
    productId: PRODUCT_ID,
    carouselImageUrls: [newImg, self!.img, self!.img, self!.img, self!.img],
  }
  try {
    const r = await callTemuApi<Record<string, unknown>>("bg.glo.goods.edit.pictures.submit", body, ctx)
    console.log(`\n✅ 部位提交（仅 colorImageUrl）→ ${JSON.stringify(r.result).slice(0, 400)}`)
  } catch (err) {
    if (err instanceof TemuApiError) {
      console.log(`\n❌ → ${err.errorCode} ${err.errorMsg}`)
    } else {
      console.log(`\n💥 ${err instanceof Error ? err.message : err}`)
    }
  }
  process.exit(0)
}

void main()
