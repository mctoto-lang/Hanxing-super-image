/**
 * M2 端到端测试辅助脚本（创建测试企业 + owner，验证 Server Action 逻辑）
 *
 * 用法：node --import tsx scripts/create-test-data.ts
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}
import { db } from "@/db/client"
import { enterprises, permissionGroups, users } from "@/db/schema"
import { hashPassword } from "@/lib/crypto"
import { rechargeCredits, deductCredits } from "@/server/services/credits-service"
import { eq } from "drizzle-orm"

async function main() {
  // 1. 创建测试企业
  const slug = "test-ent"
  const [existing] = await db
    .select()
    .from(enterprises)
    .where(eq(enterprises.slug, slug))
    .limit(1)

  let entId: string
  if (existing) {
    entId = existing.id
    console.log(`✓ 测试企业已存在: ${existing.name} (${entId})`)
  } else {
    const [ent] = await db
      .insert(enterprises)
      .values({
        name: "测试企业",
        slug,
        enabledModules: ["create", "assets", "workspace", "settings"],
        maxConcurrent: 5,
        creditsBalance: 0,
      })
      .returning()
    entId = ent!.id
    console.log(`✓ 创建测试企业: ${ent!.name} (${entId})`)

    // 默认权限组
    await db.insert(permissionGroups).values({
      enterpriseId: entId,
      name: "默认组",
      isDefault: true,
      maxConcurrent: 3,
    })
  }

  // 2. 充值 5000 积分
  const { balanceAfter: afterRecharge } = await rechargeCredits({
    enterpriseId: entId,
    amount: 5000,
    userId: null,
    remark: "M2 测试充值",
  })
  console.log(`✓ 充值 5000，余额: ${afterRecharge}`)

  // 3. 扣减 100 积分
  const { balanceAfter: afterDeduct } = await deductCredits({
    enterpriseId: entId,
    amount: 100,
    userId: null,
    remark: "M2 测试扣减",
  })
  console.log(`✓ 扣减 100，余额: ${afterDeduct}`)

  // 4. 创建 owner 用户
  const [dupUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, "owner"))
    .limit(1)

  if (!dupUser) {
    const [group] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.enterpriseId, entId))
      .limit(1)
    const hash = await hashPassword("Owner@Test2026")
    await db.insert(users).values({
      username: "owner",
      name: "测试企业主",
      passwordHash: hash,
      isSuperAdmin: false,
      enterpriseId: entId,
      enterpriseRole: "owner",
      groupId: group?.id,
    })
    console.log(`✓ 创建 owner 用户 (密码: Owner@test2026)`)
  } else {
    console.log(`✓ owner 用户已存在`)
  }

  // 5. 创建 member 用户
  const [dupMember] = await db
    .select()
    .from(users)
    .where(eq(users.username, "designer"))
    .limit(1)
  if (!dupMember) {
    const [group] = await db
      .select()
      .from(permissionGroups)
      .where(eq(permissionGroups.enterpriseId, entId))
      .limit(1)
    const hash = await hashPassword("Designer@2026")
    await db.insert(users).values({
      username: "designer",
      name: "设计师小王",
      passwordHash: hash,
      isSuperAdmin: false,
      enterpriseId: entId,
      enterpriseRole: "member",
      groupId: group?.id,
    })
    console.log(`✓ 创建 designer 成员 (密码: Designer@2026)`)
  } else {
    console.log(`✓ designer 成员已存在`)
  }

  console.log("\n🎉 M2 测试数据就绪：")
  console.log("   - 超管: superadmin / Super@Hanxing2026")
  console.log("   - 企业主: owner / Owner@test2026")
  console.log("   - 成员: designer / Designer@2026")
  process.exit(0)
}

main().catch((err) => {
  console.error("❌ 失败:", err)
  process.exit(1)
})
