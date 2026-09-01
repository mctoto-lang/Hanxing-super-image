/**
 * 种子模型（M3 测试用，手册 §4.3）
 *
 * 为默认企业 + 平台预置一个 OpenAI 标准生图模型（可见于创作页）。
 *
 * 注意：loadEnvFile 必须早于任何会触发 env.ts 校验的 import，故依赖一律用动态 import
 * （与 scripts/worker.ts、src/db/seed.ts 一致）。
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}

void (async () => {
  // 动态 import：确保上面 loadEnvFile 在 env.ts 校验之前完成
  const { db } = await import("@/db/client")
  const { models } = await import("@/db/schema")
  const { encrypt } = await import("@/lib/crypto")
  const { eq } = await import("drizzle-orm")

  async function main() {
    const name = "openai-gpt-image"
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
        displayName: "GPT 图片（测试）",
        description: "高质量写实风格，适合人物与场景",
        badgeText: "NEW",
        badgeColor: "blue",
        apiEndpoint: "https://api.example.com/v1",
        apiKeyEncrypted: encrypt("test-api-key-placeholder"),
        apiFormat: "openai",
        extraConfig: {},
        costPerImage: 1,
        sizePresets: [
          { label: "1:1", width: 1024, height: 1024 },
          { label: "16:9", width: 1280, height: 720 },
          { label: "9:16", width: 720, height: 1280 },
        ],
        supportsImageCount: true,
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
  await main()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
