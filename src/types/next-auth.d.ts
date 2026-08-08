import { type DefaultSession } from "next-auth"
import { type EnterpriseRole } from "@/db/schema"

/**
 * Auth.js Session 类型扩展（手册 §5.3）
 *
 * 让 session.user 携带 id / username / isSuperAdmin / enterpriseId /
 * enterpriseRole / groupId，供服务端 getCurrentUserContext() 使用。
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string
      username: string
      isSuperAdmin: boolean
      enterpriseId?: string | null
      enterpriseRole?: EnterpriseRole
      groupId?: string | null
    } & DefaultSession["user"]
  }

  interface User {
    username: string
    isSuperAdmin: boolean
    enterpriseId?: string | null
    enterpriseRole?: EnterpriseRole
    groupId?: string | null
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    username?: string
    isSuperAdmin?: boolean
    enterpriseId?: string | null
    enterpriseRole?: EnterpriseRole
    groupId?: string | null
  }
}
