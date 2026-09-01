/**
 * 一次性修复：补齐「白名单模式」企业的预置模型 id。
 *
 * 背景：企业 visiblePresetModels 非空时只看枚举的 id（白名单模式）；历史数据中
 * 新建的预置模型未被同步进白名单，导致企业端创作页看不到。本脚本幂等地把所有
 * 活跃平台预置模型 id 补进每个白名单模式企业。可重复执行，无副作用。
 *
 * 用法：npx tsx scripts/fix-preset-models-whitelist.ts
 *
 * 注意：loadEnvFile 必须早于任何会触发 env.ts 校验的 import，故依赖一律用动态 import
 * （与 scripts/seed-model.ts、src/db/seed.ts 一致）。
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}

void (async () => {
  // 动态 import：确保上面 loadEnvFile 在 env.ts 校验之前完成
  const { db } = await import("@/db/client")
  const { models, enterprises } = await import("@/db/schema")
  const { and, eq, isNull, sql } = await import("drizzle-orm")

  async function main() {
    // 1. 全部活跃平台预置模型 id
    const presets = await db
      .select({ id: models.id, displayName: models.displayName })
      .from(models)
      .where(and(eq(models.isActive, true), isNull(models.enterpriseId)))

    if (presets.length === 0) {
      console.log("✓ 无活跃平台预置模型，无需修复")
      process.exit(0)
    }
    const presetIds = presets.map((p) => p.id)
    console.log(`发现 ${presetIds.length} 个活跃平台预置模型`)

    // 2. 所有「白名单模式」企业（visiblePresetModels 非空）
    const whitelisted = await db
      .select({
        id: enterprises.id,
        name: enterprises.name,
        visible: enterprises.visiblePresetModels,
      })
      .from(enterprises)
      .where(sql`jsonb_array_length(${enterprises.visiblePresetModels}) > 0`)

    if (whitelisted.length === 0) {
      console.log("✓ 所有企业均为「全部预置可见」模式（visiblePresetModels 为空），无需修复")
      process.exit(0)
    }

    let totalFixed = 0
    let affectedEnterprises = 0
    for (const ent of whitelisted) {
      const list = (ent.visible as string[] | null) ?? []
      const missing = presetIds.filter((id) => !list.includes(id))
      if (missing.length === 0) continue
      await db
        .update(enterprises)
        .set({ visiblePresetModels: [...list, ...missing], updatedAt: new Date() })
        .where(eq(enterprises.id, ent.id))
      totalFixed += missing.length
      affectedEnterprises += 1
      console.log(`✓ 企业「${ent.name}」补齐 ${missing.length} 个预置模型`)
    }

    console.log(
      `\n修复完成：补齐 ${totalFixed} 条白名单记录，涉及 ${affectedEnterprises} 个白名单模式企业（共 ${whitelisted.length} 个）`,
    )
    process.exit(0)
  }
  await main()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
