import { db } from "@/db/client"
import { users } from "@/db/schema"
import { hashPassword, verifyPassword } from "@/lib/crypto"
import { eq } from "drizzle-orm"

async function main() {
  const targets = [
    { username: "owner", password: "Owner@test2026" },
    { username: "designer", password: "Designer@2026" },
  ]
  for (const t of targets) {
    const newHash = await hashPassword(t.password)
    await db
      .update(users)
      .set({ passwordHash: newHash })
      .where(eq(users.username, t.username))
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.username, t.username))
      .limit(1)
    const ok = await verifyPassword(t.password, u!.passwordHash)
    console.log(`✓ ${t.username} 密码更新，校验: ${ok}`)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
