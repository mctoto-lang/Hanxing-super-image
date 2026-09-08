import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/db/schema"
import { verifyPassword } from "@/lib/crypto"

/**
 * Auth.js v5 配置（手册 §5.3、D6）
 *
 * - Credentials Provider：用户名 + 密码（沿用旧项目账号体系）；
 * - JWT session：无状态，便于多实例；
 * - 预留 OAuth Provider 扩展位（企业微信/钉钉/OIDC，手册 D6）。
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // jwt 策略下 cookie 每次请求滚动续期：maxAge 实际语义是「不活跃超时」
  // （活跃用户无感），避免角色/超管标记在 token 里陈旧 30 天
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        username: {},
        password: {},
      },
      async authorize(creds) {
        const username = creds?.username as string | undefined
        const password = creds?.password as string | undefined
        if (!username || !password) return null

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .limit(1)

        if (!user) return null
        if (user.status !== "active") return null

        const ok = await verifyPassword(password, user.passwordHash)
        if (!ok) return null

        return {
          id: user.id,
          username: user.username,
          name: user.name ?? user.username,
          email: user.email ?? undefined,
          image: user.image ?? undefined,
          isSuperAdmin: user.isSuperAdmin,
          enterpriseId: user.enterpriseId,
          enterpriseRole: user.enterpriseRole,
          groupId: user.groupId,
        }
      },
    }),
    // ★ 预留：未来加 GitHubProvider / 企业微信 / OIDC
  ],
  callbacks: {
    async jwt({ token, user }) {
      // 首次登录时 user 有值，把扩展字段注入 token
      if (user) {
        token.username = user.username
        token.isSuperAdmin = user.isSuperAdmin
        token.enterpriseId = user.enterpriseId
        token.enterpriseRole = user.enterpriseRole
        token.groupId = user.groupId
        token.chkAt = Date.now()
        return token
      }
      // 周期复核（10 分钟）：角色/状态/企业归属以 DB 为准回写 token。
      // proxy 页面守卫直接信任 token 字段，不复核时被降权/禁用/
      // 移出企业的会话在 token 过期前（最长 7 天）仍能进入受控页面；
      // 写路径经 getCurrentUserContext 每次查库，本就实时。
      const last = typeof token.chkAt === "number" ? token.chkAt : 0
      if (Date.now() - last > 10 * 60_000) {
        token.chkAt = Date.now()
        const [row] = await db
          .select({
            username: users.username,
            status: users.status,
            isSuperAdmin: users.isSuperAdmin,
            enterpriseId: users.enterpriseId,
            enterpriseRole: users.enterpriseRole,
            groupId: users.groupId,
          })
          .from(users)
          .where(eq(users.id, token.sub!))
          .limit(1)
        if (!row || row.status !== "active") {
          // 用户已删除/禁用：清空特权与企业字段，会话立即降为无归属
          token.isSuperAdmin = false
          token.enterpriseId = null
          token.enterpriseRole = undefined
          token.groupId = null
        } else {
          token.username = row.username
          token.isSuperAdmin = row.isSuperAdmin
          token.enterpriseId = row.enterpriseId
          token.enterpriseRole = row.enterpriseRole
          token.groupId = row.groupId
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!
        session.user.username = (token.username as string) ?? ""
        session.user.isSuperAdmin = (token.isSuperAdmin as boolean) ?? false
        session.user.enterpriseId = (token.enterpriseId as string | null) ?? null
        session.user.enterpriseRole = token.enterpriseRole as
          | "owner"
          | "admin"
          | "member"
          | undefined
        session.user.groupId = (token.groupId as string | null) ?? null
      }
      return session
    },
  },
})
