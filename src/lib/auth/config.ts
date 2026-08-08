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
  session: { strategy: "jwt" },
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
