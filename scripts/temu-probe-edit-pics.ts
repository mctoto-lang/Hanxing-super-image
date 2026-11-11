/* 写探针（结构验证）：edit.pictures.submit 提交测试商品「现值」图片（不改变内容，幂等无害）。
 * 目的：验证 docs §8.12 结构（productId + materialImgUrl + carouselImageUrls + skcList）被官方接受。
 * 预期：结构对但内容未变 → 996000024「请修改图片后提交」；结构错 → 3000000 参数错。
 * 运行：cmd //c pnpm tsx scripts/temu-probe-edit-pics.ts */
try {
  process.loadEnvFile()
} catch {}

const STORE_NAME = "RoseBlanche"
const PRODUCT_ID = "4666287147"
const SKC_ID = "99470742994"

async function main() {
  const { eq, and } = await import("drizzle-orm")
  const { db } = await import("../src/db/client")
  const { temuStores, temuProducts, temuSkuMaps } = await import("../src/db/schema/temu")
  const { getTemuCallContext } = await import("../src/server/services/temu-sync")
  const { callTemuApi, TemuApiError } = await import("../src/lib/temu-api/client")

  const [store] = await db.select().from(temuStores).where(eq(temuStores.name, STORE_NAME)).limit(1)
  const ctx = await getTemuCallContext(store)
  if ("error" in ctx) {
    console.log("ctx 失败:", ctx.error)
    process.exit(0)
  }
  const [prod] = await db
    .select({ img: temuProducts.mainImageUrl })
    .from(temuProducts)
    .where(and(eq(temuProducts.storeId, store.id), eq(temuProducts.productSkcId, SKC_ID)))
    .limit(1)
  if (!prod?.img) {
    console.log("测试商品无主图，中止")
    process.exit(0)
  }
  const skus = await db
    .select({ skuId: temuSkuMaps.skuId })
    .from(temuSkuMaps)
    .where(and(eq(temuSkuMaps.storeId, store.id), eq(temuSkuMaps.skcId, SKC_ID)))
  console.log(`主图: ${prod.img.slice(0, 60)}…；SKU 数: ${skus.length}`)

  // 结构 A：全结构提交现值（materialImgUrl + carousel 5 张同图 + skcList colorImage + sku thumb）
  const bodyA = {
    productId: PRODUCT_ID,
    materialImgUrl: prod.img,
    carouselImageUrls: [prod.img, prod.img, prod.img, prod.img, prod.img],
    skcList: [
      {
        skcId: SKC_ID,
        colorImageUrl: prod.img,
        previewImgUrls: [prod.img],
        skuCommonReqList: skus.slice(0, 3).map((s) => ({ skuId: s.skuId, thumbUrl: prod.img })),
      },
    ],
  }
  // 结构 B：最小提交（只 skcList colorImageUrl）
  const bodyB = {
    productId: PRODUCT_ID,
    skcList: [{ skcId: SKC_ID, colorImageUrl: prod.img }],
  }

  for (const [label, body] of [["full-structure", bodyA], ["minimal", bodyB]] as const) {
    try {
      const r = await callTemuApi<Record<string, unknown>>("bg.glo.goods.edit.pictures.submit", body, ctx)
      console.log(`\n✅ [${label}] → ${JSON.stringify(r.result).slice(0, 400)}`)
    } catch (err) {
      if (err instanceof TemuApiError) {
        console.log(`\n❌ [${label}] → ${err.errorCode} ${err.errorMsg}`)
      } else {
        console.log(`\n💥 [${label}] ${err instanceof Error ? err.message : err}`)
      }
    }
    await new Promise((s) => setTimeout(s, 1800))
  }
  process.exit(0)
}

void main()
