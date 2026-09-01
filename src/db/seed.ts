/**
 * 种子脚本（手册 M1）
 *
 * 幂等创建：
 *   1. 平台超管（无企业归属，isSuperAdmin=true）；
 *   2. 一个默认企业（slug=default）；
 *   3. 该企业的默认权限组（isDefault=true）。
 *
 * 用法：pnpm db:seed
 *
 * 注意：loadEnvFile 必须早于任何会触发 env.ts 校验的 import（@/db/client、@/lib/env
 * 等）。静态 import 会被 JS 引擎提升到 loadEnvFile 之前执行，导致 env 校验时 .env 尚未
 * 加载，因此所有依赖一律改用动态 import（与 scripts/worker.ts 一致）。
 */

// 先加载本地 .env（tsx 不像 Next.js 那样自动加载）；必须早于下方动态 import
try {
  process.loadEnvFile()
} catch {
  // .env 不存在时忽略（CI/生产用真实环境变量）
}

void (async () => {
  // 动态 import：确保上面 loadEnvFile 在 env.ts 校验之前完成
  const { and, eq } = await import("drizzle-orm")
  const { db } = await import("@/db/client")
  const { enterprises, permissionGroups, users } = await import("@/db/schema")
  const { hashPassword } = await import("@/lib/crypto")
  const { env } = await import("@/lib/env")

  console.log("🌱 开始种子数据初始化...")

  // 1. 超管
  const adminUsername = env.SUPERADMIN_USERNAME || "superadmin"
  const [existingAdmin] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, adminUsername), eq(users.isSuperAdmin, true)))
    .limit(1)

  let adminPassword = env.SUPERADMIN_PASSWORD ?? ""
  if (!existingAdmin) {
    if (!adminPassword) {
      adminPassword = generateRandomPassword()
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
      console.log(`  ⚠ 超管密码未配置，已随机生成：${adminPassword}`)
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    }
    const hash = await hashPassword(adminPassword)
    await db.insert(users).values({
      username: adminUsername,
      name: "平台超管",
      passwordHash: hash,
      isSuperAdmin: true,
      // enterpriseId / groupId 为 NULL（超管无企业归属）
    })
    console.log(`✓ 创建平台超管：${adminUsername}`)
  } else {
    console.log(`✓ 平台超管已存在：${adminUsername}（跳过）`)
  }

  // 2. 默认企业（slug=default，幂等）
  let [enterprise] = await db
    .select()
    .from(enterprises)
    .where(eq(enterprises.slug, "default"))
    .limit(1)

  if (!enterprise) {
    ;[enterprise] = await db
      .insert(enterprises)
      .values({
        name: "默认企业",
        slug: "default",
        enabledModules: ["create", "assets", "mockup", "settings"],
        creditsBalance: 1000, // 初始赠送 1000 积分，便于开发测试
        maxConcurrent: 5,
      })
      .returning()
    console.log(`✓ 创建默认企业：${enterprise.name}（初始 1000 积分）`)
  } else {
    console.log(`✓ 默认企业已存在（跳过）`)
  }

  // 3. 默认权限组（每企业一个 isDefault=true）
  const [existingGroup] = await db
    .select()
    .from(permissionGroups)
    .where(
      and(
        eq(permissionGroups.enterpriseId, enterprise.id),
        eq(permissionGroups.isDefault, true),
      ),
    )
    .limit(1)

  if (!existingGroup) {
    await db.insert(permissionGroups).values({
      enterpriseId: enterprise.id,
      name: "默认组",
      description: "企业默认权限组，新成员自动分配",
      allowedModels: [], // 空 = 企业全部已开通模型
      allowedPages: [], // 空 = 企业全部已开通模块
      maxConcurrent: 2,
      priority: 0,
      isDefault: true,
    })
    console.log("✓ 创建默认权限组")
  } else {
    console.log("✓ 默认权限组已存在（跳过）")
  }

  console.log("🎉 种子数据初始化完成")
  process.exit(0)
})().catch((err) => {
  console.error("❌ 种子数据初始化失败：", err)
  process.exit(1)
})

function generateRandomPassword(length = 16): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%"
  let pwd = ""
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < length; i++) {
    pwd += chars[bytes[i]! % chars.length]
  }
  return pwd
}
