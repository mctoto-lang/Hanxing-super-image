/**
 * 种子模型（M3 测试用，手册 §4.3）
 *
 * 为默认企业 + 平台预置一个 GRS 模型（可见于创作页）。
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}
import { db } from "@/db/client"
import { models } from "@/db/schema"
import { encrypt } from "@/lib/crypto"
import { eq } from "drizzle-orm"

async function main() {
  const name = "grs-gpt-image"
  const [existing] = await db
    .select()
    .from(models)
    .where(eq(models.name, name))
    .limit(1)

  if (existing) {
    console.log(`✓ 模型 ${name} 已存在`)
    process.exit(0)
  }

  const [model] = await db
    .insert(models)
    .values({
      enterpriseId: null, // 平台预置模型，所有企业可见
      name,
      displayName: "GRS GPT 图片（测试）",
      apiEndpoint: "https://grs.example.com/v1",
      apiKeyEncrypted: encrypt("test-api-key-placeholder"),
      apiFormat: "grs",
      extraConfig: {
        grsModelFamily: "gpt",
        replyType: "json",
      },
      costPerImage: 1,
      supportedSizes: {
        ratios: [
          { width: 1024, height: 1024 },
          { width: 1280, height: 720 },
          { width: 720, height: 1280 },
        ],
      },
      visibleInCreate: true,
      supportsReferenceImage: false,
      maxReferenceImages: 0,
      maxConcurrent: 2,
      maxRetries: 1,
      apiTimeout: 60,
      taskTimeout: 180,
    })
    .returning()

  console.log(`✓ 创建测试模型: ${model!.displayName} (${model!.id})`)
  console.log("  注意：apiEndpoint 是占位，真实生图会失败，但用于验证 UI/扣减/入队流程")
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
