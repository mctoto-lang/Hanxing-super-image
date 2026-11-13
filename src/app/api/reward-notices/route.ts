import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { auth } from "@/lib/auth/config"
import { db } from "@/db/client"
import { users } from "@/db/schema"
import {
  ackRewardNotices,
  listPendingRewardNotices,
} from "@/server/services/reward-notice-service"

/**
 * 奖励礼物通知轮询端点（RewardPopup 数据源）
 *
 * GET ：当前用户的待弹事件（企业全员事件 + 定向给我的），按时间升序；
 * POST：{ id } 推进已读游标到该通知的 created_at（µs 精度、只进不退，
 *       通知 id 按企业归属校验）。超管/无企业恒空，不参与弹窗。
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const enterpriseId = session.user.enterpriseId
  if (!enterpriseId || session.user.isSuperAdmin) {
    return NextResponse.json({ items: [] })
  }

  try {
    const [row] = await db
      .select({ id: users.id, enterpriseId: users.enterpriseId })
      .from(users)
      .where(eq(users.id, session.user.id))
    if (!row || !row.enterpriseId) {
      return NextResponse.json({ items: [] })
    }

    const items = await listPendingRewardNotices({
      id: row.id,
      enterpriseId: row.enterpriseId,
    })
    return NextResponse.json({ items })
  } catch (err) {
    console.error("[reward-notices] 查询待弹事件失败:", err)
    return NextResponse.json({ items: [] })
  }
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  let noticeId: string | null = null
  try {
    const body = (await request.json()) as { id?: unknown }
    if (typeof body.id === "string" && body.id.length > 0) noticeId = body.id
  } catch {
    // 非 JSON 体忽略
  }
  if (!noticeId) {
    return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 })
  }

  try {
    await ackRewardNotices(session.user.id, noticeId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[reward-notices] 推进已读游标失败:", err)
    return NextResponse.json({ ok: false, error: "处理失败" }, { status: 500 })
  }
}
