/**
 * 种子对话模型（M6 AI 对话测试用）
 *
 * 为平台预置两个对话模型（openai 兼容 + claude 格式示例），
 * 含最大上下文 / 单次最大输出 / 百万 token 厘级价格 / 思考强度配置。
 *
 * 注意：loadEnvFile 必须早于任何会触发 env.ts 校验的 import，故依赖一律用动态 import
 * （与 scripts/seed-model.ts 一致）。
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}

void (async () => {
  // 动态 import：确保上面 loadEnvFile 在 env.ts 校验之前完成
  const { db } = await import("@/db/client")
  const { chatApiConfigs } = await import("@/db/schema")
  const { encrypt } = await import("@/lib/crypto")
  const { eq, isNull, and } = await import("drizzle-orm")

  async function main() {
    const seeds = [
      {
        name: "gpt-4o-mini-test",
        displayName: "GPT 对话（测试）",
        description: "OpenAI 兼容格式示例，日常问答",
        badgeText: "NEW",
        badgeColor: "blue",
        apiEndpoint: "https://api.example.com/v1",
        apiKeyEncrypted: encrypt("test-api-key-placeholder"),
        formatType: "openai",
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
        // 2.50 积分/百万输入，10.00 积分/百万输出（单位：厘）
        inputPriceCenticredits: 250,
        outputPriceCenticredits: 1000,
        supportsThinking: true,
        maxConcurrent: 5,
        maxRetries: 3,
        apiTimeout: 120,
        taskTimeout: 300,
      },
      {
        name: "claude-sonnet-test",
        displayName: "Claude 对话（测试）",
        description: "Anthropic 格式示例，长文写作",
        badgeText: "PRO",
        badgeColor: "purple",
        apiEndpoint: "https://api.anthropic.com",
        apiKeyEncrypted: encrypt("test-api-key-placeholder"),
        formatType: "claude",
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
        inputPriceCenticredits: 300, // 3.00 积分/百万输入
        outputPriceCenticredits: 1500, // 15.00 积分/百万输出
        supportsThinking: true,
        maxConcurrent: 5,
        maxRetries: 3,
        apiTimeout: 120,
        taskTimeout: 300,
      },
    ]

    for (const seed of seeds) {
      const [existing] = await db
        .select()
        .from(chatApiConfigs)
        .where(
          and(
            eq(chatApiConfigs.name, seed.name),
            isNull(chatApiConfigs.enterpriseId),
          ),
        )
        .limit(1)
      if (existing) {
        console.log(`✓ 对话模型 ${seed.name} 已存在`)
        continue
      }
      await db.insert(chatApiConfigs).values({
        enterpriseId: null, // 平台预置，所有企业可见
        ...seed,
        isActive: true,
      })
      console.log(`✓ 创建测试对话模型: ${seed.displayName} (${seed.formatType})`)
    }
    console.log("  注意：apiEndpoint 是占位，真实对话会失败，但用于验证 UI/计费/白名单流程")
    process.exit(0)
  }
  await main()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
