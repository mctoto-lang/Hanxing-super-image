import { NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { auth } from "@/lib/auth/config"
import { db } from "@/db/client"
import { users } from "@/db/schema"
import { roleLabel } from "@/lib/auth/permissions"
import { listOnlineUserIds, touchPresence } from "@/lib/presence"

/**
 * 企业在线成员（顶栏头像组数据源，手册 §5.4 轮询端点）
 *
 * GET 一次即心跳：刷新请求者活跃时间，返回当前企业在线名单
 * （按最近活跃倒序）。会话 JWT 已含 enterpriseId/isSuperAdmin，
 * 认证路径零 DB 查询；成员资料走进程内 60s 缓存（企业成员量级小、
 * 昵称/头像变更低频）。Redis/DB 异常时降级返回空名单，
 * 头像组暂隐，下一轮心跳自愈。
 */

/** 面板最多列出的成员数（头像组只依赖 total，不受此限制影响） */
const MAX_MEMBERS = 50

interface MemberProfile {
  id: string
  name: string
  avatar: string | null
  roleLabel: string
}

/** 成员资料进程内缓存：enterpriseId → { rows, fetchedAt } */
const profileCache = new Map<
  string,
  { rows: MemberProfile[]; fetchedAt: number }
>()
const PROFILE_CACHE_TTL_MS = 60_000

async function loadEnterpriseProfiles(
  enterpriseId: string,
): Promise<MemberProfile[]> {
  const cached = profileCache.get(enterpriseId)
  if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
    return cached.rows
  }
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      image: users.image,
      enterpriseRole: users.enterpriseRole,
    })
    .from(users)
    .where(and(eq(users.enterpriseId, enterpriseId), eq(users.status, "active")))
  const profiles: MemberProfile[] = rows.map((r) => ({
    id: r.id,
    name: r.name || r.username,
    avatar: r.image ?? null,
    roleLabel: roleLabel(r.enterpriseRole),
  }))
  profileCache.set(enterpriseId, { rows: profiles, fetchedAt: Date.now() })
  return profiles
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const enterpriseId = session.user.enterpriseId
  // 超管/无企业不参与在线统计
  if (!enterpriseId || session.user.isSuperAdmin) {
    return NextResponse.json({ total: 0, members: [] })
  }

  try {
    await touchPresence(enterpriseId, session.user.id)
    const [onlineIds, profiles] = await Promise.all([
      listOnlineUserIds(enterpriseId),
      loadEnterpriseProfiles(enterpriseId),
    ])
    const byId = new Map(profiles.map((p) => [p.id, p]))
    // onlineIds 已按最近活跃倒序；过滤已禁用/转移企业的用户
    const online = onlineIds
      .map((id) => byId.get(id))
      .filter((m): m is MemberProfile => !!m)
    return NextResponse.json({
      total: online.length,
      members: online.slice(0, MAX_MEMBERS),
    })
  } catch (err) {
    console.error("[presence] 查询在线成员失败:", err)
    return NextResponse.json({ total: 0, members: [] })
  }
}
