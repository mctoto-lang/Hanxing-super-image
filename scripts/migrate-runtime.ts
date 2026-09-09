/**
 * 运行时迁移（drizzle-orm postgres-js migrator）。
 *
 * 用途：drizzle-kit migrate 在个别环境会静默空转——正常读取配置、建好
 * drizzle.__drizzle_migrations 台账表后直接退出（台账 0 行、业务表未建、
 * 无任何报错）。本脚本走 drizzle-orm 运行时 migrator，读取同一 drizzle/
 * 目录与 journal，应用条数前后对比、成败都有明确输出。
 *
 * 运行：docker compose run --rm migrate npx tsx scripts/migrate-runtime.ts
 */

// loadEnvFile 必须早于会触发 env.ts 校验的 import（静态 import 会被提升，
// 见 worker.ts/seed.ts 同款说明）
process.loadEnvFile()

async function main() {
  const [{ env }, { default: postgres }, { drizzle }, { migrate }] =
    await Promise.all([
      import("@/lib/env"),
      import("postgres"),
      import("drizzle-orm/postgres-js"),
      import("drizzle-orm/postgres-js/migrator"),
    ])
  // 迁移期 DDL 逐条提交，单连接 + 禁用 prepare 与事务内 DDL 兼容
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false })

  let before = 0
  try {
    const r = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`
    before = r[0]!.n
  } catch {
    // 首次运行台账表尚未创建
  }
  console.log(`[migrate-runtime] 应用前台账记录: ${before}`)

  try {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" })

    const r = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`
    const after = r[0]!.n
    console.log(`[migrate-runtime] 完成，应用后台账记录: ${after}`)
    if (after === before) {
      console.warn(
        "[migrate-runtime] ⚠️ 台账未增长：migrator 认为没有待应用迁移。" +
          "若业务表也未建，请把本输出发回排查",
      )
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error("[migrate-runtime] 失败:", err)
  process.exit(1)
})
